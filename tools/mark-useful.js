#!/usr/bin/env node
/**
 * mark-useful.js — Mark a QA entry as "actually useful" after agent used it successfully
 * 
 * Phân biệt: hit = retrieved, useful = agent dùng thành công
 * 
 * Usage:
 *   node mark-useful.js --id=137          # Mark QA #137 as useful
 *   node mark-useful.js --q="BaseForm"    # Find and mark by question keyword
 */
const { pool } = require('../core');

const ID_ARG = process.argv.find(a => a.startsWith('--id='))?.split('=')[1];
const Q_ARG = process.argv.find(a => a.startsWith('--q='))?.split('=')[1];

async function run() {
  if (!ID_ARG && !Q_ARG) {
    console.log('Usage: node mark-useful.js --id=<id>');
    console.log('       node mark-useful.js --q="<keyword>"');
    process.exit(1);
  }

  let targetId = ID_ARG ? parseInt(ID_ARG) : null;

  // Find by question keyword
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

  const result = await pool.query(
    `UPDATE agent_qa_cache 
     SET useful_count = useful_count + 1,
         use_count = use_count + 1,
         last_used_at = NOW()
     WHERE id = $1 
     RETURNING id, question, useful_count, use_count, hit_count`,
    [targetId]
  );

  if (result.rows.length === 0) {
    console.log(`[ERROR] QA #${targetId} not found`);
  } else {
    const r = result.rows[0];
    console.log(`[✅ USEFUL] #${r.id} (useful: ${r.useful_count}, use_count: ${r.use_count}, hits: ${r.hit_count})`);
    console.log(`  Q: ${r.question.substring(0, 80)}`);
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
