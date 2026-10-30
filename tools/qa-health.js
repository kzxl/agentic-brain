#!/usr/bin/env node
/**
 * qa-health.js — Semantic Brain Health Check & Auto-Decay
 *
 * Phân tích sức khỏe toàn bộ QA Cache, phát hiện:
 *   1. Cold entries (0 hits, > N days) → decay confidence
 *   2. Entries quá ngắn / quá dài
 *   3. Duplicate candidates (phát hiện bằng question_hash check nhanh)
 *   4. Orphan tags (tags không còn entry nào dùng)
 *
 * Usage:
 *   node qa-health.js                      # Dry-run report
 *   node qa-health.js --fix                # Apply auto-decay + cleanup
 *   node qa-health.js --cold-days=14       # Customize cold threshold (default: 14)
 *   node qa-health.js --decay-to=0.6       # Decay target confidence (default: 0.6)
 */
const { pool } = require('../core');

// Parse args
const DRY_RUN = !process.argv.includes('--fix');
const COLD_DAYS = parseInt(process.argv.find(a => a.startsWith('--cold-days='))?.split('=')[1] || '14');
const DECAY_TO = parseFloat(process.argv.find(a => a.startsWith('--decay-to='))?.split('=')[1] || '0.6');
const MIN_ANSWER_LEN = 20;
const MAX_ANSWER_LEN = 2000;

async function run() {
  const issues = [];
  let fixCount = 0;

  console.log(`╔════════════════════════════════════════════════╗`);
  console.log(`║  SEMANTIC BRAIN — HEALTH CHECK                ║`);
  console.log(`║  Mode: ${DRY_RUN ? 'DRY-RUN (preview)' : '⚡ FIX (applying)'}${DRY_RUN ? '       ' : '         '}║`);
  console.log(`╚════════════════════════════════════════════════╝\n`);

  // ───────────────────────────────────────────────
  // 1. Cold Entries (0 retrievals + 0 uses, old enough, still active)
  // ───────────────────────────────────────────────
  const cold = await pool.query(`
    SELECT id, LEFT(question, 60) as question, source, confidence_score,
      EXTRACT(DAY FROM NOW() - COALESCE(last_retrieved_at, created_at))::int as age_days
    FROM agent_qa_cache
    WHERE COALESCE(retrieval_count, 0) = 0
      AND COALESCE(use_count, 0) = 0
      AND COALESCE(last_retrieved_at, created_at) < NOW() - INTERVAL '${COLD_DAYS} days'
      AND status = 'active'
      AND confidence_score > ${DECAY_TO}
    ORDER BY COALESCE(last_retrieved_at, created_at) ASC
  `);

  console.log(`── 1. Cold Entries (0 retrievals/uses, >${COLD_DAYS} days, conf > ${DECAY_TO}) ──`);
  if (cold.rows.length === 0) {
    console.log(`   ✅ None found\n`);
  } else {
    console.log(`   ⚠️  ${cold.rows.length} entries to decay → confidence ${DECAY_TO}\n`);
    cold.rows.forEach(r => {
      console.log(`   [${r.id}] ${r.question}...`);
      console.log(`         age: ${r.age_days}d | source: ${r.source} | conf: ${r.confidence_score}`);
      issues.push({ id: r.id, type: 'cold', action: `decay → ${DECAY_TO}` });
    });

    if (!DRY_RUN) {
      const ids = cold.rows.map(r => r.id);
      const res = await pool.query(
        `UPDATE agent_qa_cache
         SET confidence_score = $1, status = 'stale', updated_at = NOW()
         WHERE id = ANY($2::int[]) AND status = 'active'`,
        [DECAY_TO, ids]
      );
      fixCount += res.rowCount;
      console.log(`\n   ✅ Decayed and marked stale: ${res.rowCount} entries`);
    }
    console.log();
  }

  // ───────────────────────────────────────────────
  // 2. Too Short / Too Long Answers
  // ───────────────────────────────────────────────
  const badLength = await pool.query(`
    SELECT id, LEFT(question, 50) as question,
      LENGTH(answer_context) as ans_len,
      CASE
        WHEN LENGTH(answer_context) < ${MIN_ANSWER_LEN} THEN 'TOO_SHORT'
        WHEN LENGTH(answer_context) > ${MAX_ANSWER_LEN} THEN 'TOO_LONG'
      END as issue
    FROM agent_qa_cache
    WHERE LENGTH(answer_context) < ${MIN_ANSWER_LEN}
       OR LENGTH(answer_context) > ${MAX_ANSWER_LEN}
    ORDER BY LENGTH(answer_context) ASC
  `);

  console.log(`── 2. Answer Length Issues (<${MIN_ANSWER_LEN} or >${MAX_ANSWER_LEN} chars) ──`);
  if (badLength.rows.length === 0) {
    console.log(`   ✅ All answers have reasonable length\n`);
  } else {
    console.log(`   ⚠️  ${badLength.rows.length} entries with length issues\n`);
    badLength.rows.forEach(r => {
      console.log(`   [${r.id}] ${r.issue} (${r.ans_len} chars) — ${r.question}...`);
      issues.push({ id: r.id, type: r.issue.toLowerCase(), action: 'review' });
    });
    console.log();
  }

  // ───────────────────────────────────────────────
  // 3. Low Confidence Entries
  // ───────────────────────────────────────────────
  const lowConf = await pool.query(`
    SELECT id, LEFT(question, 50) as question, confidence_score, source,
           COALESCE(retrieval_count, 0) AS retrieval_count,
           COALESCE(use_count, 0) AS use_count
    FROM agent_qa_cache
    WHERE confidence_score < 0.5
      AND status = 'active'
    ORDER BY confidence_score ASC
  `);

  console.log(`── 3. Low Confidence (<0.5) ──`);
  if (lowConf.rows.length === 0) {
    console.log(`   ✅ No low-confidence entries\n`);
  } else {
    console.log(`   ⚠️  ${lowConf.rows.length} entries need review or deletion\n`);
    lowConf.rows.forEach(r => {
      console.log(`   [${r.id}] conf: ${r.confidence_score} | retrievals: ${r.retrieval_count} | uses: ${r.use_count} | src: ${r.source}`);
      console.log(`         ${r.question}...`);
      issues.push({ id: r.id, type: 'low_conf', action: 'review/delete' });
    });
    console.log();
  }

  // ───────────────────────────────────────────────
  // 4. Source Quality Summary
  // ───────────────────────────────────────────────
  const srcQuality = await pool.query(`
    SELECT source,
      COUNT(*) as total,
      COUNT(CASE WHEN COALESCE(retrieval_count, 0) > 0 THEN 1 END) as used,
      ROUND(100.0 * COUNT(CASE WHEN COALESCE(retrieval_count, 0) > 0 THEN 1 END) / COUNT(*), 1) as usage_pct,
      SUM(COALESCE(retrieval_count, 0)) as total_hits
    FROM agent_qa_cache
    GROUP BY source ORDER BY usage_pct DESC
  `);

  console.log(`── 4. Source Quality Summary ──`);
  console.log(`   ${'Source'.padEnd(30)} ${'Total'.padStart(5)} ${'Used'.padStart(5)} ${'Usage%'.padStart(7)} ${'Retrievals'.padStart(10)}`);
  console.log(`   ${'─'.repeat(55)}`);
  srcQuality.rows.forEach(r => {
    const bar = '█'.repeat(Math.round(parseFloat(r.usage_pct) / 5));
    console.log(`   ${r.source.padEnd(30)} ${r.total.padStart(5)} ${r.used.padStart(5)} ${(r.usage_pct + '%').padStart(7)} ${r.total_hits.padStart(5)} ${bar}`);
  });
  console.log();

  // ───────────────────────────────────────────────
  // 5. Tag Coverage
  // ───────────────────────────────────────────────
  const noTags = await pool.query(`
    SELECT COUNT(*) as cnt FROM agent_qa_cache WHERE tags IS NULL OR array_length(tags, 1) IS NULL
  `);

  console.log(`── 5. Tag Coverage ──`);
  console.log(`   Entries without tags: ${noTags.rows[0].cnt}`);
  if (parseInt(noTags.rows[0].cnt) > 0) {
    issues.push({ type: 'no_tags', action: `${noTags.rows[0].cnt} entries need tagging` });
  }
  console.log();

  // ───────────────────────────────────────────────
  // 6. Usefulness Analysis
  // ───────────────────────────────────────────────
  const usefulness = await pool.query(`
    SELECT 
      COUNT(CASE WHEN COALESCE(use_count, 0) > 0 THEN 1 END) as proven_useful,
      COUNT(CASE WHEN COALESCE(retrieval_count, 0) >= 3 AND COALESCE(use_count, 0) = 0 THEN 1 END) as high_hit_never_useful,
      COUNT(CASE WHEN COALESCE(retrieval_count, 0) = 0
                  AND COALESCE(use_count, 0) = 0
                  AND COALESCE(last_retrieved_at, created_at) < NOW() - INTERVAL '60 days'
                  AND status = 'active' THEN 1 END) as ultra_cold,
      COUNT(*) as total
    FROM agent_qa_cache
  `);

  const u = usefulness.rows[0];
  console.log(`── 6. Usefulness Analysis ──`);
  console.log(`   Proven useful (marked):     ${u.proven_useful}`);
  console.log(`   High-retrieval never useful: ${u.high_hit_never_useful}`);
  console.log(`   Ultra-cold (>60d, no signal): ${u.ultra_cold}`);

  if (parseInt(u.high_hit_never_useful) > 0) {
    console.log(`   ⚠️ ${u.high_hit_never_useful} entries retrieved 3+ times but never marked useful`);
    issues.push({ type: 'never_useful', action: `${u.high_hit_never_useful} entries need review` });
  }

  // Auto-decay ultra-cold entries (>60 days, 0 everything)
  if (parseInt(u.ultra_cold) > 0 && !DRY_RUN) {
    const decayRes = await pool.query(`
      UPDATE agent_qa_cache
      SET confidence_score = LEAST(confidence_score, 0.5), updated_at = NOW()
      WHERE COALESCE(retrieval_count, 0) = 0
        AND COALESCE(use_count, 0) = 0
        AND COALESCE(last_retrieved_at, created_at) < NOW() - INTERVAL '60 days'
        AND status = 'active'
        AND confidence_score > 0.5
    `);
    if (decayRes.rowCount > 0) {
      fixCount += decayRes.rowCount;
      console.log(`   ✅ Decayed ${decayRes.rowCount} ultra-cold entries to conf 0.5`);
    }
  }
  console.log();

  // ───────────────────────────────────────────────
  // 7. Obsolete Rules Check (Auto-Deprecation)
  // ───────────────────────────────────────────────
  const obsolete = await pool.query(`
    SELECT id, LEFT(question, 50) as question, confidence_score
    FROM agent_qa_cache
    WHERE (
        ((question ILIKE '%c# 6%' OR answer_context ILIKE '%c# 6%' OR question ILIKE '%c#6%' OR answer_context ILIKE '%c#6%')
         AND answer_context NOT ILIKE '%loại bỏ%' AND answer_context NOT ILIKE '%c# 10%')
        OR (
            (question ILIKE '%copyfromwithlog%' OR answer_context ILIKE '%copyfromwithlog%')
            AND question NOT ILIKE '%instead of%'
            AND answer_context NOT ILIKE '%instead of%' 
            AND answer_context NOT ILIKE '%thay vì%'
            AND answer_context NOT ILIKE '%thay cho%'
            AND answer_context NOT ILIKE '%loại bỏ%'
            AND answer_context NOT ILIKE '%tránh%'
           )
        OR (
            (answer_context ILIKE '%sử dụng BindingSource%' OR answer_context ILIKE '%dùng BindingSource%')
            AND answer_context NOT ILIKE '%loại bỏ%' 
            AND answer_context NOT ILIKE '%thay thế%' 
            AND answer_context NOT ILIKE '%gỡ bỏ%'
            AND answer_context NOT ILIKE '%tránh%'
           )
      )
      AND confidence_score > 0.0
      AND status = 'active'
  `);

  console.log(`── 7. Obsolete Rules Check ──`);
  if (obsolete.rows.length === 0) {
    console.log(`   ✅ No obsolete rules found\n`);
  } else {
    console.log(`   ⚠️  ${obsolete.rows.length} obsolete entries to decay to 0.0\n`);
    obsolete.rows.forEach(r => {
      console.log(`   [${r.id}] conf: ${r.confidence_score} | ${r.question}...`);
      issues.push({ id: r.id, type: 'obsolete_rule', action: 'decay → 0.0' });
    });

    if (!DRY_RUN) {
      const ids = obsolete.rows.map(r => r.id);
      const decayObs = await pool.query(
        `UPDATE agent_qa_cache SET confidence_score = 0.0, updated_at = NOW() WHERE id = ANY($1::int[])`,
        [ids]
      );
      fixCount += decayObs.rowCount;
      console.log(`\n   ✅ Decayed ${decayObs.rowCount} obsolete entries to conf 0.0`);
    }
    console.log();
  }

  // ───────────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────────
  console.log(`═══════════════════════════════════════════════`);
  console.log(`SUMMARY: ${issues.length} issues found`);
  if (!DRY_RUN) {
    console.log(`FIXED:   ${fixCount} entries auto-fixed`);
  } else if (issues.length > 0) {
    console.log(`Run with --fix to apply auto-decay fixes.`);
  }
  console.log(`═══════════════════════════════════════════════`);
}

(async () => {
  try {
    await run();
  } catch (err) {
    console.error('[ERROR]', err.message);
  } finally {
    await pool.end();
  }
})();
