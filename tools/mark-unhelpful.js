#!/usr/bin/env node
/**
 * mark-unhelpful.js — Mark a QA entry as "not helpful" (negative feedback)
 * 
 * Khi agent dùng knowledge nhưng kết quả sai → decay confidence
 * 
 * Usage:
 *   node mark-unhelpful.js --id=137          # Mark QA #137 as unhelpful
 *   node mark-unhelpful.js --q="BaseForm"    # Find and mark by question keyword
 */
const { pool } = require('../core');

const ID_ARG = process.argv.find(a => a.startsWith('--id='))?.split('=')[1];
const Q_ARG = process.argv.find(a => a.startsWith('--q='))?.split('=')[1];

async function run() {
  if (!ID_ARG && !Q_ARG) {
    console.log('Usage: node mark-unhelpful.js --id=<id>');
    console.log('       node mark-unhelpful.js --q="<keyword>"');
    process.exit(1);
  }

  let targetId = ID_ARG ? parseInt(ID_ARG) : null;

  if (!targetId && Q_ARG) {
    const r = await pool.query(
      `SELECT id, question FROM agent_qa_cache 
       WHERE LOWER(question) LIKE $1 
       ORDER BY hit_count DESC LIMIT 1`,
      [`%${Q_ARG.toLowerCase()}%`]
    );
    if (r.rows.length === 0) {
      console.log(`[MISS] No QA found matching "${Q_ARG}"`);
      await pool.end();
      process.exit(1);
    }
    targetId = r.rows[0].id;
    console.log(`[FOUND] #${targetId}: ${r.rows[0].question.substring(0, 70)}`);
  }

  // Decay confidence by 0.1 (min 0.3)
  const result = await pool.query(
    `UPDATE agent_qa_cache 
     SET confidence_score = GREATEST(confidence_score - 0.1, 0.3),
         updated_at = NOW()
     WHERE id = $1 
     RETURNING id, question, confidence_score, hit_count, useful_count, use_count`,
    [targetId]
  );

  if (result.rows.length === 0) {
    console.log(`[ERROR] QA #${targetId} not found`);
  } else {
    const r = result.rows[0];
    console.log(`[❌ UNHELPFUL] #${r.id} (conf: ${r.confidence_score}, hits: ${r.hit_count}, useful: ${r.useful_count}, use_count: ${r.use_count})`);
    console.log(`  Q: ${r.question.substring(0, 80)}`);
    console.log(`  Confidence decayed by -0.1`);
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
