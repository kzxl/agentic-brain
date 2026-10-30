#!/usr/bin/env node
/**
 * verify-phase3.js — Read-only checks for lifecycle, trust promotion, and parents.
 */
const fs = require('fs');
const path = require('path');
const { pool, qaRankingQuery, attachParents, config } = require('../core');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const migrations = (await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  )).rows.map(r => r.version);
  check('migration 011 applied', migrations.includes('011_lifecycle_views'));

  const viewDef = (await pool.query(
    `SELECT pg_get_viewdef('v_qa_dashboard'::regclass, true) AS d`
  )).rows[0].d;
  check('dashboard view uses retrieval_count', viewDef.includes('retrieval_count'));
  check('dashboard view uses use_count', viewDef.includes('use_count'));

  const statuses = (await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM agent_qa_cache GROUP BY status ORDER BY status`
  )).rows;
  check('status values are valid',
    statuses.every(r => ['active', 'stale', 'archived', 'superseded'].includes(r.status)),
    statuses.map(r => `${r.status}=${r.n}`).join(', '));

  const curate = fs.readFileSync(path.join(__dirname, 'curate.js'), 'utf8');
  check('curate sets status column', curate.includes("SET status = 'stale'"));
  check('curate no longer writes status:stale tag', !curate.includes("'status:stale'"));

  const health = fs.readFileSync(path.join(__dirname, 'qa-health.js'), 'utf8');
  check('qa-health uses retrieval_count', health.includes('retrieval_count'));
  check('qa-health uses status column', health.includes("status = 'active'"));

  check('promote-trust CLI exists', fs.existsSync(path.join(__dirname, 'promote-trust.js')));
  check('parent helper exists', fs.existsSync(path.join(__dirname, '..', 'core', 'parents.js')));

  const stub = {
    query: async () => ({ rows: [{ id: 1, question: 'Parent', answer_context: 'Body' }] }),
  };
  const attached = await attachParents([{ id: 2, parent_id: 1 }], stub);
  check('parent helper attaches parent', attached[0].parent?.id === 1);

  const qq = qaRankingQuery({ limit: 3, project: 'phase3-check' });
  check('retrieval filters active status', qq.text.includes("COALESCE(status, 'active') = 'active'"));
  check('retrieval filters validity', qq.text.includes('valid_to IS NULL OR valid_to > NOW()'));
  check('retrieval force-index enabled', config.retrieval?.forceIndex === true);
  check('50k benchmark artifact exists',
    fs.existsSync(path.join(__dirname, '..', 'docs', 'architecture', 'baseline-ann-50000.json')));

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
