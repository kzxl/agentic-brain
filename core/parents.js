/**
 * parents.js — Attach parent document context to retrieved atoms.
 *
 * Documents are containers and are excluded from normal retrieval. When an
 * atom is selected and the caller asks for context, fetch the parent row.
 */
const pool = require('./db');

async function attachParents(rows, db = pool, opts = {}) {
  const maxChars = Math.max(200, Math.min(20000, parseInt(opts.maxChars, 10) || 2000));
  const parentIds = [...new Set((rows || []).map(r => r.parent_id).filter(Boolean))];
  if (parentIds.length === 0) {
    return (rows || []).map(r => ({ ...r, parent: null }));
  }

  const parents = (await db.query(
    `SELECT id, question, LEFT(answer_context, $2) AS answer_context,
            source_ref, scope, project_id, trust_level, status
     FROM agent_qa_cache
     WHERE id = ANY($1::int[])`,
    [parentIds, maxChars]
  )).rows;

  const byId = new Map(parents.map(p => [String(p.id), p]));
  return (rows || []).map(r => ({
    ...r,
    parent: r.parent_id ? (byId.get(String(r.parent_id)) || null) : null,
  }));
}

module.exports = { attachParents };
