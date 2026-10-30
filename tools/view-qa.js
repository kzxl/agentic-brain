#!/usr/bin/env node
/**
 * view-qa.js - Progressive L1 Deep Inspection
 *
 * Retrieves the full context, code snippets, metadata, and revision history
 * for a specific QA item by its numeric ID.
 *
 * Usage:
 *   node tools/view-qa.js <id>
 */

const { pool, storageAme, config } = require('../core');

const ID = parseInt(process.argv[2], 10);
const BACKEND_ARG = process.argv.find(a => a.startsWith('--backend='))?.split('=')[1]?.toLowerCase();
const PROJECT_ARG = process.argv.find(a => a.startsWith('--project='))?.split('=')[1]?.toLowerCase();

if (!ID || isNaN(ID)) {
  console.log('Usage: node tools/view-qa.js <id> [--backend=ame|postgres] [--project=name]');
  process.exit(1);
}

function renderItem(item, backendLabel, histRows = [], parent = null, children = []) {
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║ 📖 DEEP INSPECTION: QA #${item.id} [${backendLabel}]`.padEnd(64) + `║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);
  console.log(`📌 Tags:       ${(item.tags || []).join(', ') || 'none'}`);
  console.log(`🏷️ Category:   ${item.category || item.tier || 'general'}`);
  console.log(`📦 Scope:      ${item.scope || '?'} | Project: ${item.project_id || '?'} | Status: ${item.status || 'active'}`);
  console.log(`🎯 Trust:      ${item.trust_level || 'observation'}${item.verifier ? ` (verifier: ${item.verifier})` : ''}`);
  console.log(`🎯 Confidence: ${((item.confidence_score || 1.0) * 100).toFixed(0)}% | Retrievals: ${item.retrieval_count || 0} | Uses: ${item.use_count || 0}`);
  if (item.updated_at) console.log(`🕒 Updated:    ${new Date(item.updated_at).toLocaleString()}`);
  if (parent) {
    console.log(`\n── Parent Document #${parent.id} ───────────────────────────────`);
    console.log(`Q: ${parent.question}`);
    console.log(`A: ${parent.answer_context}`);
  }
  console.log(`\n── Question / Technical Symptom ───────────────────────────────`);
  console.log(item.question);
  console.log(`\n── Root Cause, Solution & Gotchas ─────────────────────────────`);
  console.log(item.answer_context);
  if (children.length > 0) {
    console.log(`\n── Child Atoms (${children.length}) ────────────────────────────`);
    children.forEach(c => console.log(`  #${c.id} ${c.question.substring(0, 90)}`));
  }

  if (histRows && histRows.length > 0) {
    console.log(`\n── Revision History (${histRows.length} previous version(s)) ──────────────`);
    histRows.forEach((h, idx) => {
      const preview = (h.old_answer || '').replace(/\r?\n+/g, ' ').substring(0, 100);
      console.log(`  [v${idx + 1}] (${h.changed_by || 'agent'}) ${preview}...`);
    });
  }
  console.log(`\n═══════════════════════════════════════════════════════════════\n`);
}

async function viewQA(id) {
  const isExplicitAme = BACKEND_ARG === 'ame' || config.backend === 'ame';

  // 1. If explicit AME, try AME first
  if (isExplicitAme) {
    try {
      const ameItem = await storageAme.viewQA(id, { project: PROJECT_ARG });
      if (ameItem) {
        renderItem(ameItem, '⚡ AME Cognitive');
        process.exit(0);
      }
    } catch {}
  }

  // 2. Try PostgreSQL
  let row = null;
  let histRows = [];
  let parent = null;
  let children = [];
  try {
    const result = await pool.query(`
      SELECT id, question, answer_context, source, category, tags,
             confidence_score, retrieval_count, use_count, created_at, updated_at,
             scope, project_id, trust_level, source_type, verifier, valid_from, valid_to,
             status, parent_id, chunk_type
      FROM agent_qa_cache
      WHERE id = $1
    `, [id]);

    if (result.rows.length > 0) {
      row = result.rows[0];
      await pool.query(
        'UPDATE agent_qa_cache SET retrieval_count = COALESCE(retrieval_count, 0) + 1, last_retrieved_at = NOW() WHERE id = $1',
        [id]
      ).catch(() => {});

      if (row.parent_id) {
        parent = (await pool.query(
          `SELECT id, question, answer_context FROM agent_qa_cache WHERE id = $1`,
          [row.parent_id]
        )).rows[0] || null;
      }
      if (row.chunk_type === 'document') {
        children = (await pool.query(
          `SELECT id, question FROM agent_qa_cache
           WHERE parent_id = $1
           ORDER BY atom_index ASC NULLS LAST, id ASC`,
          [id]
        )).rows;
      }

      const histResult = await pool.query(`
        SELECT id, old_answer, changed_by, changed_at
        FROM agent_qa_history
        WHERE qa_id = $1
        ORDER BY changed_at DESC
        LIMIT 3
      `, [id]).catch(() => ({ rows: [] }));
      histRows = histResult.rows;
    }
  } catch (pgErr) {
    // PostgreSQL unavailable or timed out
  }

  if (row) {
    renderItem(row, '🐘 PostgreSQL', histRows, parent, children);
    try { await pool.end(); } catch {}
    process.exit(0);
  }

  // 3. Fallback to AME if not found in PG or PG offline
  try {
    const ameFallback = await storageAme.viewQA(id, { project: PROJECT_ARG });
    if (ameFallback) {
      renderItem(ameFallback, '⚡ AME Cognitive (Local/Container)');
      try { await pool.end(); } catch {}
      process.exit(0);
    }
  } catch {}

  console.error(`❌ [NOT FOUND] QA item #${id} does not exist in SemanticBrain (checked PostgreSQL and AME).`);
  try { await pool.end(); } catch {}
  process.exit(1);
}

viewQA(ID);
