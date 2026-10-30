#!/usr/bin/env node
/**
 * review-scope.js — Review global-scope candidates.
 *
 * A generic lesson written inside a project is stored project-scoped with
 * review_status='pending'. Approving it promotes the record to global scope.
 *
 * Usage:
 *   node tools/review-scope.js                 # list pending
 *   node tools/review-scope.js --approve=123   # promote to global
 *   node tools/review-scope.js --reject=123    # keep project-scoped
 *   node tools/review-scope.js --limit=50
 */
const { pool } = require('../core');

const APPROVE = process.argv.find(a => a.startsWith('--approve='))?.split('=')[1];
const REJECT = process.argv.find(a => a.startsWith('--reject='))?.split('=')[1];
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '20', 10);

async function listPending() {
  const rows = (await pool.query(
    `SELECT id, scope, scope_candidate, review_status,
            LEFT(question, 100) AS question, tags
     FROM agent_qa_cache
     WHERE review_status = 'pending'
     ORDER BY id ASC
     LIMIT $1`,
    [Math.max(1, Math.min(200, LIMIT))]
  )).rows;

  if (rows.length === 0) {
    console.log('[REVIEW] No pending global candidates.');
    return;
  }

  console.log(`[REVIEW] ${rows.length} pending global candidate(s):\n`);
  for (const r of rows) {
    console.log(`  #${r.id} [${r.scope}/${r.scope_candidate}] ${r.question}`);
    console.log(`       tags: ${(r.tags || []).join(', ')}`);
  }
  console.log('\nApprove: node tools/review-scope.js --approve=<id>');
  console.log('Reject:  node tools/review-scope.js --reject=<id>');
}

async function approve(id) {
  const result = await pool.query(
    `UPDATE agent_qa_cache
     SET scope = 'global',
         scope_origin = 'review',
         scope_reason = 'approved global candidate',
         scope_candidate = NULL,
         review_status = 'approved',
         project_id = 'global',
         tags = ARRAY(
           SELECT DISTINCT t
           FROM unnest(
             ARRAY(
               SELECT t
               FROM unnest(COALESCE(tags, '{}')) t
               WHERE t NOT LIKE 'project:%'
             ) || ARRAY['project:global']
           ) AS t
         ),
         updated_at = NOW()
     WHERE id = $1 AND review_status = 'pending'
     RETURNING id, question, tags`,
    [id]
  );
  if (result.rows.length === 0) {
    console.log(`[REVIEW] #${id} not found or not pending.`);
    return;
  }
  console.log(`[APPROVED] #${id} -> global (${result.rows[0].tags.join(', ')})`);
}

async function reject(id) {
  const result = await pool.query(
    `UPDATE agent_qa_cache
     SET scope = 'project',
         scope_origin = 'review',
         scope_reason = 'global candidate rejected',
         scope_candidate = NULL,
         review_status = 'rejected',
         updated_at = NOW()
     WHERE id = $1 AND review_status = 'pending'
     RETURNING id, question, tags`,
    [id]
  );
  if (result.rows.length === 0) {
    console.log(`[REVIEW] #${id} not found or not pending.`);
    return;
  }
  console.log(`[REJECTED] #${id} stays project-scoped`);
}

(async () => {
  try {
    if (APPROVE) await approve(parseInt(APPROVE, 10));
    else if (REJECT) await reject(parseInt(REJECT, 10));
    else await listPending();
  } catch (err) {
    console.error('[REVIEW][ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
