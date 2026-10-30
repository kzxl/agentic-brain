#!/usr/bin/env node
/**
 * verify-phase2.js — Read-only acceptance checks for Phase 2.
 */
const {
  pool,
  qaRankingQuery,
  normalizeTrustLevel,
  TRUST_LEVELS,
} = require('../core');

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
    'project_id', 'trust_level', 'source_type', 'evidence', 'verifier',
    'verified_at', 'valid_from', 'valid_to', 'status', 'tsv',
  ]) {
    check(`column agent_qa_cache.${required}`, columns.includes(required));
  }

  const migrations = (await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  )).rows.map(r => r.version);
  check('migration 008 applied', migrations.includes('008_project_id'));
  check('migration 009 applied', migrations.includes('009_trust_provenance'));
  check('migration 010 applied', migrations.includes('010_ann_first_retrieval'));

  const counts = (await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE project_id IS NULL)::int AS null_projects,
       COUNT(*) FILTER (WHERE trust_level IS NULL)::int AS null_trust,
       COUNT(*) FILTER (WHERE status IS NULL)::int AS null_status
     FROM agent_qa_cache`
  )).rows[0];
  check('project_id/trust/status backfilled',
    counts.null_projects === 0 && counts.null_trust === 0 && counts.null_status === 0,
    JSON.stringify(counts));

  const trustRows = (await pool.query(
    `SELECT trust_level, COUNT(*)::int AS n FROM agent_qa_cache GROUP BY 1 ORDER BY 1`
  )).rows;
  check('trust levels are valid',
    trustRows.every(r => TRUST_LEVELS.includes(r.trust_level)),
    trustRows.map(r => `${r.trust_level}=${r.n}`).join(', '));

  const uniqueIdx = (await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'agent_qa_cache'
       AND indexname = 'idx_qa_unique_project_question'`
  )).rows[0];
  check('project/question unique index exists', Boolean(uniqueIdx));

  const tsvIdx = (await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'agent_qa_cache' AND indexname = 'idx_qa_tsv'`
  )).rows[0];
  check('GIN tsv index exists', Boolean(tsvIdx));

  const projectQ = qaRankingQuery({ limit: 3, project: 'phase2-check' });
  check('ranking query uses project_id', projectQ.text.includes('project_id = $5::text'));
  check('ranking query has ANN candidate CTE', projectQ.text.includes('WITH ann'));
  check('ranking query has FTS candidate CTE', projectQ.text.includes('tsv @@ plainto_tsquery'));
  check('ranking query filters active status', projectQ.text.includes("COALESCE(status, 'active') = 'active'"));
  check('ranking query filters expired rows', projectQ.text.includes('valid_to IS NULL OR valid_to > NOW()'));
  check('ranking query returns trust metadata', projectQ.text.includes('trust_level'));

  check('seed trust default', normalizeTrustLevel(undefined, { source: 'seed' }) === 'verified_fact');
  check('agent trust default', normalizeTrustLevel(undefined, { source: 'agent-direct' }) === 'observation');
  check('verified fact requires evidence',
    normalizeTrustLevel('verified_fact', { source: 'agent' }) === 'hypothesis');
  check('explicit evidence upgrades',
    normalizeTrustLevel('verified_fact', { source: 'agent', evidence: ['test:1'] }) === 'verified_fact');

  // Execute the query once with a synthetic vector (no embedding model needed).
  const vec = JSON.stringify(new Array(1024).fill(0.01));
  await pool.query(projectQ.text, projectQ.params([], vec, null, 'phase2 smoke', 'phase2-check'));
  check('scoped retrieval executes', true);

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
