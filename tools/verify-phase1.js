#!/usr/bin/env node
/**
 * verify-phase1.js — Read-only acceptance checks for Phase 1.
 *
 * Checks schema columns, scope backfill, atom/document separation, review queue,
 * deterministic scope resolution, and atomic normalization.
 */
const { pool, qaRankingQuery, resolveScope, normalizeKnowledge } = require('../core');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const columns = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_qa_cache'`
  )).rows.map(r => r.column_name);

  for (const required of [
    'scope', 'scope_origin', 'scope_reason', 'scope_confidence',
    'scope_candidate', 'review_status', 'parent_id', 'atom_index',
    'chunk_type', 'source_ref',
  ]) {
    check(`column agent_qa_cache.${required}`, columns.includes(required));
  }

  const migrations = (await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  )).rows.map(r => r.version);
  check('migration 006 applied', migrations.includes('006_scope_and_atoms'), migrations.join(','));
  check('migration 007 applied', migrations.includes('007_scope_trigger'));

  const trigger = (await pool.query(
    `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_qa_scope'`
  )).rows[0];
  check('scope trigger installed', Boolean(trigger));

  const nullScope = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM agent_qa_cache WHERE scope IS NULL'
  )).rows[0].n;
  check('every record has a scope', nullScope === 0, `${nullScope} null`);

  const byScope = (await pool.query(
    `SELECT scope, COUNT(*)::int AS n FROM agent_qa_cache GROUP BY scope ORDER BY scope`
  )).rows;
  check('scope values are project/global', byScope.every(r => r.scope === 'project' || r.scope === 'global'),
    byScope.map(r => `${r.scope}=${r.n}`).join(', '));

  const chunk = (await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE COALESCE(chunk_type, 'atom') = 'atom')::int AS atoms,
       COUNT(*) FILTER (WHERE chunk_type = 'document')::int AS documents
     FROM agent_qa_cache`
  )).rows[0];
  check('atom/document split is valid', chunk.atoms >= 0 && chunk.documents >= 0,
    `atoms=${chunk.atoms}, documents=${chunk.documents}`);

  const pending = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM agent_qa_cache WHERE review_status = 'pending'`
  )).rows[0].n;
  check('review queue is queryable', pending >= 0, `${pending} pending`);

  const projectQ = qaRankingQuery({ limit: 3, project: 'phase1-check' });
  check('project query includes project tag predicate',
    projectQ.text.includes("('project:' || $5::text) = ANY(tags)"));

  const defaultQ = qaRankingQuery({ limit: 3 });
  check('default query is global-only',
    defaultQ.text.includes("scope = 'global'") && !defaultQ.text.includes('$5::text'));
  check('atom retrieval excludes documents',
    defaultQ.text.includes("COALESCE(chunk_type, 'atom') = 'atom'"));

  const explicit = resolveScope({ explicitScope: 'global', project: 'erp' });
  check('explicit global wins', explicit.scope === 'global');

  const candidate = resolveScope({
    project: 'erp',
    content: 'Use async/await instead of blocking calls in JavaScript services',
  });
  check('generic project lesson is a global candidate',
    candidate.scope === 'project' && candidate.candidate === 'global' && candidate.reviewStatus === 'pending');

  const projectSpecific = resolveScope({
    project: 'erp',
    content: 'Fix deadlock in MDS InventoryService under Features/Inventory',
  });
  check('project-specific lesson stays project', projectSpecific.scope === 'project' && !projectSpecific.candidate);

  const normalized = await normalizeKnowledge({
    text: 'Deadlock on commit | Missing composite index | Add index and sort lock order',
    structured: true,
  });
  check('structured input normalizes to one atom', normalized.atoms.length === 1);

  const failed = results.filter(r => !r.ok);
  console.log(`\n[VERIFY] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`[VERIFY] FAILED: ${failed.map(f => f.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main()
  .catch(err => {
    console.error('[VERIFY][FATAL]', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
