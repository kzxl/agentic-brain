#!/usr/bin/env node
/**
 * baseline.js — Reproducible retrieval baseline for Phase 0.
 *
 * Usage:
 *   node tools/baseline.js [--project=erp] [--limit=5]
 *
 * Writes docs/architecture/baseline.json. Safe for read-only DB usage:
 * it only embeds queries and runs SELECTs.
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { execSync } = require('child_process');
const { pool, embed, qaRankingQuery } = require('../core');

const PROJECT = (() => {
  const arg = process.argv.find(a => a.startsWith('--project='));
  return arg ? arg.split('=')[1].trim().toLowerCase() : null;
})();
const LIMIT = (() => {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  return arg ? Math.max(1, Math.min(20, parseInt(arg.split('=')[1], 10) || 5)) : 5;
})();
const OUT_ARG = process.argv.find(a => a.startsWith('--out='))?.slice('--out='.length);

const QUERIES = [
  'Universe Architecture UA là gì và cấu trúc thư mục chuẩn',
  'Cách phân tách Service Controller View trong WinForms',
  'Lỗi deadlock khi commit transaction trong service inventory',
  'BaseForm RunAfterShown pattern khởi tạo form',
  'BindingList DevExpress grid pattern',
  'Cách check permission trong WinForms',
  'Khi nào tạo DTO thay vì truyền param rời',
  'Production module workflow và BOM',
  'Inspection QC approval workflow',
  'Handover approval pattern',
  'DevExpress XtraReport binding',
  'Async await tránh block UI thread',
  'EF6 DbContext và DbScope trong Application Service',
  'Lỗi CS1503 CS1061 sau refactor',
  'Tối ưu hóa bộ nhớ và garbage collection',
  'Schema migration an toàn cho bảng lớn',
  'Retrieval precision và hybrid search',
  'Working memory và session checkpoint',
  'Knowledge provenance và trust level',
  'Làm thế nào để tránh trộn tri thức giữa các dự án',
];

function pct(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  const total = (await pool.query('SELECT COUNT(*)::int AS n FROM agent_qa_cache')).rows[0].n;

  const tWarm = performance.now();
  await embed('warmup query for baseline');
  const warmupMs = Math.round(performance.now() - tWarm);

  const rows = [];
  for (const query of QUERIES) {
    const vec = await embed(query);
    const qq = qaRankingQuery({ limit: LIMIT, project: PROJECT });
    const t0 = performance.now();
    const result = await pool.query(
      qq.text,
      qq.params([], JSON.stringify(vec), null, query, PROJECT)
    );
    const latencyMs = +(performance.now() - t0).toFixed(2);

    rows.push({
      query,
      latencyMs,
      hits: result.rows.map(r => ({
        id: r.id,
        score: +(r.final_score * 100).toFixed(1),
        question: String(r.question || '').slice(0, 120),
      })),
    });
    console.log(`[BASELINE] ${latencyMs.toFixed(2)}ms  ${result.rows.length} hits  ${query}`);
  }

  const latencies = rows.map(r => r.latencyMs);
  const commit = (() => {
    try { return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(); }
    catch { return 'unknown'; }
  })();

  const output = {
    generatedAt: new Date().toISOString(),
    commit,
    project: PROJECT,
    limit: LIMIT,
    totalRecords: total,
    warmupMs,
    queries: rows.length,
    latency: {
      min: Math.min(...latencies),
      p50: pct(latencies, 0.5),
      p95: pct(latencies, 0.95),
      max: Math.max(...latencies),
      mean: +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2),
    },
    results: rows,
  };

  const outPath = OUT_ARG
    ? path.resolve(OUT_ARG)
    : path.join(__dirname, '..', 'docs', 'architecture', 'baseline.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`\n[BASELINE] wrote ${outPath}`);
  console.log(`[BASELINE] records=${total} p50=${output.latency.p50}ms p95=${output.latency.p95}ms`);
}

main()
  .catch(err => {
    console.error('[BASELINE][FATAL]', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
