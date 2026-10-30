#!/usr/bin/env node
/**
 * verify-phase0.js — Read-only acceptance checks for Phase 0.
 *
 * Checks:
 *   - PostgreSQL is the canonical backend and AME writes are off.
 *   - Schema objects added in Phase 0 exist.
 *   - Project isolation predicate is present in the ranking query.
 *   - Every record has a project scope tag.
 *
 * Exit code 0 = pass, 1 = fail.
 */
const { pool, config, qaRankingQuery } = require('../core');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  check('MEMORY_BACKEND=postgres', config.backend === 'postgres', `got ${config.backend}`);
  check('AME writes disabled', config.ame?.write === false, `ame.write=${config.ame?.write}`);
  check('BIND_HOST is local by default', ['127.0.0.1', 'localhost'].includes(config.server.host), config.server.host);
  check('body limit configured', Number(config.server.maxBodyBytes) > 0, `${config.server.maxBodyBytes} bytes`);

  const cols = (await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'agent_qa_cache'`
  )).rows.map(r => r.column_name);
  for (const required of ['useful_count', 'retrieval_count', 'use_count', 'last_retrieved_at', 'last_used_at']) {
    check(`column agent_qa_cache.${required}`, cols.includes(required));
  }

  const tables = (await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )).rows.map(r => r.table_name);
  for (const required of ['agent_qa_querylog', 'agent_query_embedding_cache', 'schema_migrations']) {
    check(`table ${required}`, tables.includes(required));
  }

  const views = (await pool.query(
    `SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`
  )).rows.map(r => r.table_name);
  for (const required of ['v_qa_dashboard', 'v_qa_quality', 'v_querylog_summary']) {
    check(`view ${required}`, views.includes(required));
  }

  const indexes = (await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'agent_qa_cache'`
  )).rows.map(r => r.indexname);
  check('HNSW index present', indexes.includes('idx_qa_embedding_hnsw'));
  check('hit_count index present', indexes.includes('idx_qa_hit_count'));
  check('question hash lookup index present', indexes.includes('idx_qa_question_hash'));
  check('global unique question index removed', !indexes.includes('idx_qa_unique_question'));

  const migrations = (await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  )).rows.map(r => r.version);
  check('migration 001 applied', migrations.includes('001_baseline'), migrations.join(','));
  check('migration 002 applied', migrations.includes('002_phase0_counters'));
  check('migration 003 applied', migrations.includes('003_global_project_tag'));

  const unscoped = (await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM agent_qa_cache
     WHERE NOT EXISTS (
       SELECT 1 FROM unnest(COALESCE(tags, '{}')) t WHERE t LIKE 'project:%'
     )`
  )).rows[0].n;
  check('every record has a project scope tag', unscoped === 0, `${unscoped} unscoped`);

  const assumedErp = (await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM agent_qa_cache
     WHERE 'project-review:assumed-erp' = ANY(tags)`
  )).rows[0].n;
  check('legacy unscoped records flagged for review', assumedErp > 0, `${assumedErp} records`);

  const qq = qaRankingQuery({ limit: 3, project: 'phase0-check' });
  check('ranking query has project predicate',
    qq.text.includes('project_id = $5::text'));
  check('ranking query params include project', qq.params([], '[]', null, 'q', 'phase0-check').length === 7);

  const defaultQ = qaRankingQuery({ limit: 3 });
  check('default scope is global-only',
    defaultQ.text.includes("scope = 'global'"));
  const defaultParams = defaultQ.params([], '[]', null, 'q');
  check('default params omit project', defaultParams.length === 7 && defaultParams[4] === null);
  check('documents excluded from atom retrieval', defaultQ.text.includes("COALESCE(chunk_type, 'atom') = 'atom'"));

  const allQ = qaRankingQuery({ limit: 3, allProjects: true });
  check('all-projects scope is explicit',
    allQ.text.includes('$6::boolean = true') && allQ.params([], '[]', null, 'q')[5] === true);

  const bothQ = qaRankingQuery({ limit: 3, project: 'phase0-check', allProjects: true });
  check('all-projects wins even when a project is set',
    bothQ.params([], '[]', null, 'q', 'phase0-check')[5] === true);

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
