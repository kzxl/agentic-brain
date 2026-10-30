#!/usr/bin/env node
/**
 * benchmark-ann-50k.js — ANN-first retrieval benchmark on a synthetic table.
 *
 * Creates a temporary table with 50k random 1024-d embeddings, builds the same
 * indexes as production, runs the production ranking SQL, records latency and
 * the query plan, then drops the table.
 *
 * Usage:
 *   node tools/benchmark-ann-50k.js [--rows=50000] [--iterations=20]
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { pool, qaRankingQuery, queryRetrieval } = require('../core');

const ROWS = parseInt(process.argv.find(a => a.startsWith('--rows='))?.split('=')[1] || '50000', 10);
const ITERATIONS = parseInt(process.argv.find(a => a.startsWith('--iterations='))?.split('=')[1] || '20', 10);
const TABLE = 'agent_qa_cache_bench50k';
const DIMS = 1024;

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  console.log(`[BENCH] rows=${ROWS} dims=${DIMS} iterations=${ITERATIONS}`);
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);

  let insertMs = 0;
  let indexMs = 0;

  try {
    await pool.query(`
      CREATE TABLE ${TABLE} (
        id SERIAL PRIMARY KEY,
        question TEXT,
        answer_context TEXT,
        tags TEXT[] DEFAULT '{}',
        embedding vector(1024),
        scope TEXT DEFAULT 'project',
        project_id TEXT,
        chunk_type TEXT DEFAULT 'atom',
        status TEXT DEFAULT 'active',
        valid_to TIMESTAMPTZ,
        trust_level TEXT DEFAULT 'observation',
        source_type TEXT,
        verifier TEXT,
        valid_from TIMESTAMPTZ,
        confidence_score FLOAT DEFAULT 1.0,
        updated_at TIMESTAMP DEFAULT NOW(),
        use_count INT DEFAULT 0,
        retrieval_count INT DEFAULT 0,
        parent_id BIGINT,
        tsv tsvector GENERATED ALWAYS AS (
          to_tsvector('simple', COALESCE(question, '') || ' ' || COALESCE(answer_context, ''))
        ) STORED
      )
    `);

    console.log('[BENCH] inserting synthetic rows...');
    await pool.query(`
      CREATE OR REPLACE FUNCTION bench_random_vector(dims int)
      RETURNS vector AS $$
        SELECT array_agg(random())::vector FROM generate_series(1, dims)
      $$ LANGUAGE sql VOLATILE
    `);
    const tInsert = performance.now();
    await pool.query(`
      INSERT INTO ${TABLE}
        (question, answer_context, tags, embedding, scope, project_id,
         chunk_type, status, trust_level, confidence_score)
      SELECT
        'bench question ' || i,
        'bench answer ' || i,
        ARRAY['bench'],
        bench_random_vector(${DIMS}),
        'project', 'bench', 'atom', 'active', 'observation', 1.0
      FROM generate_series(1, $1) AS i
    `, [ROWS]);
    insertMs = Math.round(performance.now() - tInsert);

    console.log('[BENCH] building indexes...');
    const tIndex = performance.now();
    await pool.query(`SET maintenance_work_mem = '64MB'`);
    await pool.query(`SET max_parallel_maintenance_workers = 0`);
    await pool.query(`
      CREATE INDEX bench_hnsw ON ${TABLE}
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
    await pool.query(`CREATE INDEX bench_tsv ON ${TABLE} USING GIN(tsv)`);
    await pool.query(`CREATE INDEX bench_project ON ${TABLE}(project_id, status)`);
    await pool.query(`ANALYZE ${TABLE}`);
    indexMs = Math.round(performance.now() - tIndex);

    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`)).rows[0].n;
    const qq = qaRankingQuery({ limit: 5, project: 'bench', candidateK: 100, minSimilarity: 0 });
    const sql = qq.text.replaceAll('agent_qa_cache', TABLE);
    const vec = JSON.stringify(Array.from({ length: DIMS }, () => Math.random()));
    const params = qq.params([], vec, null, 'needle-not-in-corpus', 'bench');

    for (let i = 0; i < 3; i++) await queryRetrieval(sql, params, { forceIndex: false });

    const latencies = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = performance.now();
      const res = await queryRetrieval(sql, params, { forceIndex: false });
      latencies.push(performance.now() - t);
      if (i === 0) console.log(`[BENCH] first measured result rows=${res.rows.length}`);
    }

    const plan = (await queryRetrieval(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
      params,
      { forceIndex: false }
    )).rows
      .map(r => r['QUERY PLAN'])
      .join('\n');
    const planLines = plan.split('\n')
      .filter(l => /Scan|Execution Time|Planning Time|Limit/.test(l))
      .map(l => l.slice(0, 300))
      .slice(0, 40);

    // Forced-index measurement: pgvector's cost model can choose a sequential
    // scan at 50k even when HNSW is much faster.
    let forcedLatency = null;
    let forcedPlanLines = [];
    for (let i = 0; i < 3; i++) await queryRetrieval(sql, params, { forceIndex: true });
    const forced = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = performance.now();
      await queryRetrieval(sql, params, { forceIndex: true });
      forced.push(performance.now() - t);
    }
    const forcedPlan = (await queryRetrieval(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
      params,
      { forceIndex: true }
    )).rows
      .map(r => r['QUERY PLAN'])
      .join('\n');
    forcedPlanLines = forcedPlan.split('\n')
      .filter(l => /Scan|Execution Time|Planning Time|Limit/.test(l))
      .map(l => l.slice(0, 300))
      .slice(0, 40);
    forcedLatency = {
      p50: +percentile(forced, 0.5).toFixed(2),
      p95: +percentile(forced, 0.95).toFixed(2),
      mean: +(forced.reduce((a, b) => a + b, 0) / forced.length).toFixed(2),
    };

    const result = {
      generatedAt: new Date().toISOString(),
      rows: total,
      dims: DIMS,
      candidateK: 100,
      limit: 5,
      iterations: ITERATIONS,
      insertMs,
      indexMs,
      latency: {
        min: +Math.min(...latencies).toFixed(2),
        p50: +percentile(latencies, 0.5).toFixed(2),
        p95: +percentile(latencies, 0.95).toFixed(2),
        max: +Math.max(...latencies).toFixed(2),
        mean: +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2),
      },
      forcedLatency,
      planLines,
      forcedPlanLines,
    };

    const outPath = path.join(__dirname, '..', 'docs', 'architecture', `baseline-ann-${ROWS}.json`);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(`[BENCH] wrote ${outPath}`);
    console.log(`[BENCH] p50=${result.latency.p50}ms p95=${result.latency.p95}ms rows=${total}`);
    console.log(planLines.join('\n'));
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await pool.query('DROP FUNCTION IF EXISTS bench_random_vector(int)').catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch(err => {
  console.error('[BENCH][FATAL]', err.message);
  process.exit(1);
});
