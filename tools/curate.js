#!/usr/bin/env node
/**
 * curate.js - Knowledge Lifecycle & Curation Engine
 *
 * Scans the QA repository for knowledge health:
 *   1. Active: Recently retrieved/used or updated (< stale_days)
 *   2. Stale: no retrieval/use signal for > stale_days (status column)
 *   3. Pinned: Golden invariants explicitly marked (protected from lifecycle changes)
 *   4. Overlapping: Pairs with cosine similarity > 0.88 eligible for consolidation
 *
 * Usage:
 *   node tools/curate.js [--project=name] [--stale-days=60] [--dry-run] [--mark-stale]
 */

const { pool } = require('../core');

const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--mark-stale');
const PROJECT_ARG = process.argv.find(a => a.startsWith('--project='))?.split('=')[1]?.toLowerCase() || null;
const STALE_DAYS = parseInt(process.argv.find(a => a.startsWith('--stale-days='))?.split('=')[1] || '60', 10);

async function curate() {
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║ 🧹 KNOWLEDGE LIFECYCLE CURATION ENGINE                       ║`);
  console.log(`║ Mode: ${DRY_RUN ? 'DRY-RUN (Audit Only)' : '⚡ LIVE MUTATION'} | Threshold: ${STALE_DAYS} days | Project: ${(PROJECT_ARG || 'all').padEnd(10)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝\n`);

  try {
    const projectFilter = PROJECT_ARG ? `AND project_id = '${PROJECT_ARG.replace(/'/g, "''")}'` : '';

    // 1. Fetch summary metrics
    const rows = (await pool.query(`
      SELECT id, question, tags, status,
             COALESCE(retrieval_count, 0) AS retrieval_count,
             COALESCE(use_count, 0) AS use_count,
             COALESCE(last_retrieved_at, updated_at) AS last_signal,
             EXTRACT(DAY FROM NOW() - COALESCE(last_retrieved_at, updated_at))::int AS idle_days
      FROM agent_qa_cache
      WHERE status IN ('active', 'stale', 'archived') ${projectFilter}
      ORDER BY id ASC
    `)).rows;

    if (rows.length === 0) {
      console.log('No QA records found matching criteria.');
      return;
    }

    let pinnedCount = 0;
    let activeCount = 0;
    let staleCount = 0;
    let archivedCount = 0;
    const staleCandidates = [];

    for (const r of rows) {
      const isPinned = (r.tags || []).includes('pinned');
      if (isPinned) {
        pinnedCount++;
        continue;
      }

      if (r.status === 'archived') {
        archivedCount++;
        continue;
      }

      if (r.status === 'stale') {
        staleCount++;
        continue;
      }

      if (r.idle_days > STALE_DAYS && r.retrieval_count === 0 && r.use_count === 0) {
        staleCount++;
        staleCandidates.push(r);
      } else {
        activeCount++;
      }
    }

    console.log(`📊 Knowledge State Overview:`);
    console.log(`   • Total Records:   ${rows.length}`);
    console.log(`   • Pinned (Golden): ${pinnedCount}`);
    console.log(`   • Active:          ${activeCount}`);
    console.log(`   • Stale:           ${staleCount} (no retrieval/use > ${STALE_DAYS} days)`);
    console.log(`   • Archived:        ${archivedCount}\n`);

    if (staleCandidates.length > 0) {
      console.log(`── Stale Candidates (Top 5) ────────────────────────────────────`);
      staleCandidates.slice(0, 5).forEach(r => {
        console.log(`   [#${r.id}] (${r.idle_days} days idle, 0 retrievals/uses) ${(r.question || '').substring(0, 70)}...`);
      });

      if (!DRY_RUN) {
        const staleIds = staleCandidates.map(r => r.id);
        const res = await pool.query(`
          UPDATE agent_qa_cache
          SET status = 'stale', updated_at = NOW()
          WHERE id = ANY($1::int[]) AND status = 'active'
        `, [staleIds]);
        console.log(`\n   ✅ Set status='stale' on ${res.rowCount} candidate(s).`);
      } else {
        console.log(`\n   ℹ️ [DRY-RUN] No status modified. Pass --mark-stale to apply.`);
      }
    }

    // 2. Scan for high-similarity semantic overlaps (potential redundancy)
    console.log(`\n── Near-Duplicate / Overlap Audit (Cosine Similarity >= 88%) ────`);
    const overlapQuery = `
      SELECT a.id AS id1, a.question AS q1, b.id AS id2, b.question AS q2,
             1 - (a.embedding <=> b.embedding) AS similarity
      FROM agent_qa_cache a
      JOIN agent_qa_cache b ON a.id < b.id
      WHERE 1 - (a.embedding <=> b.embedding) >= 0.88
        AND a.status = 'active' AND b.status = 'active'
        AND COALESCE(a.chunk_type, 'atom') = 'atom'
        AND COALESCE(b.chunk_type, 'atom') = 'atom'
        ${PROJECT_ARG ? `AND a.project_id = '${PROJECT_ARG.replace(/'/g, "''")}' AND b.project_id = '${PROJECT_ARG.replace(/'/g, "''")}'` : ''}
      ORDER BY similarity DESC
      LIMIT 5;
    `;

    const overlaps = (await pool.query(overlapQuery)).rows;
    if (overlaps.length === 0) {
      console.log(`   ✅ No near-duplicate entries found (library is cleanly deduplicated).`);
    } else {
      overlaps.forEach(o => {
        console.log(`   ⚠️ ${(o.similarity * 100).toFixed(1)}% match: [#${o.id1}] vs [#${o.id2}]`);
        console.log(`      A: "${o.q1.substring(0, 60)}..."`);
        console.log(`      B: "${o.q2.substring(0, 60)}..."`);
      });
      console.log(`   💡 Recommendation: Consolidate overlapping items using 'save-qa.js' or post-task strengthening.`);
    }

    console.log(`\n═══════════════════════════════════════════════════════════════`);
    console.log(`[DONE] Knowledge curation cycle finished.`);
    console.log(`═══════════════════════════════════════════════════════════════\n`);
  } catch (err) {
    console.error('[CURATION ERROR]', err.message);
  } finally {
    await pool.end();
  }
}

curate();
