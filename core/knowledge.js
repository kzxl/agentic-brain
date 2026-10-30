/**
 * knowledge.js — Single write path for knowledge capture.
 *
 * Phase 0 scope:
 *   - one dedup policy (exact hash + semantic >= 0.85 within project)
 *   - one history policy
 *   - project-aware writes
 *   - never inflate confidence on an existing record
 *
 * Phase 1 will move this behind MemoryRepository and add trust/provenance.
 */
const pool = require('./db');
const { embed } = require('./embed');
const { extractKeywords, inferTags } = require('./keywords');

const SEMANTIC_DEDUP_THRESHOLD = 0.85;

function clampConfidence(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeProject(project) {
  return project ? String(project).trim().toLowerCase() : null;
}

function buildTags(question, answer, tags, project, pinned) {
  const merged = inferTags(question, answer, tags || []);
  const projectTag = project ? `project:${project}` : 'project:global';
  if (!merged.includes(projectTag)) {
    merged.push(projectTag);
  }
  if (pinned && !merged.includes('pinned')) {
    merged.push('pinned');
  }
  return merged;
}

/**
 * Capture a Q/A item.
 *
 * @param {object} input
 * @param {string} input.question
 * @param {string} input.answer
 * @param {string} [input.source='manual']
 * @param {string} [input.category='general']
 * @param {string[]} [input.tags=[]]
 * @param {number} [input.confidence=0.5]
 * @param {string|null} [input.project=null]
 * @param {boolean} [input.pinned=false]
 * @param {object} [db=pool]
 * @returns {Promise<{status:'saved'|'updated', id:number, matchType:string}>}
 */
async function captureKnowledge(input, db = pool) {
  const question = String(input.question || '').trim();
  const answer = String(input.answer || '').trim();
  if (!question || !answer) {
    throw new Error('question and answer are required');
  }

  const project = normalizeProject(input.project);
  const source = input.source || 'manual';
  const category = input.category || 'general';
  const confidence = clampConfidence(input.confidence, 0.5);
  const tags = buildTags(question, answer, input.tags, project, input.pinned);

  const searchText = `${question} ${answer}`.toLowerCase();
  const vec = await embed(searchText);
  const keywords = extractKeywords(searchText);

  // 1. Exact hash match (scoped to the project, or to global when no project)
  const exactSql = project
    ? `SELECT id, question, answer_context, tags, confidence_score
       FROM agent_qa_cache
       WHERE question_hash = md5(lower($1))
         AND $2::text = ANY(tags)
       LIMIT 1`
    : `SELECT id, question, answer_context, tags, confidence_score
       FROM agent_qa_cache
       WHERE question_hash = md5(lower($1))
         AND 'project:global' = ANY(tags)
       LIMIT 1`;
  const exact = await db.query(exactSql, project ? [question, `project:${project}`] : [question]);

  let target = exact.rows[0] || null;
  let matchType = target ? 'exact_hash' : null;

  // 2. Semantic near-duplicate inside the same project (or global when no project)
  if (!target) {
    const scopeSql = project ? '$2::text = ANY(tags)' : "'project:global' = ANY(tags)";
    const thresholdIdx = project ? '$3' : '$2';
    const simParams = project
      ? [JSON.stringify(vec), `project:${project}`, SEMANTIC_DEDUP_THRESHOLD]
      : [JSON.stringify(vec), SEMANTIC_DEDUP_THRESHOLD];

    const sim = await db.query(
      `SELECT id, question, answer_context, tags, confidence_score,
              1 - (embedding <=> $1::vector) AS similarity
       FROM agent_qa_cache
       WHERE ${scopeSql}
         AND 1 - (embedding <=> $1::vector) >= ${thresholdIdx}
       ORDER BY similarity DESC
       LIMIT 1`,
      simParams
    );
    if (sim.rows.length > 0) {
      target = sim.rows[0];
      matchType = `semantic_dedup (${(sim.rows[0].similarity * 100).toFixed(1)}%)`;
    }
  }

  if (target) {
    await db.query(
      `INSERT INTO agent_qa_history (qa_id, old_answer, new_answer, changed_by)
       VALUES ($1, $2, $3, $4)`,
      [target.id, target.answer_context, answer, source]
    );

    const mergedTags = [...new Set([...(target.tags || []), ...tags])];
    // Existing confidence is preserved on agent writes. Negative feedback is
    // handled by mark-unhelpful.js, not by a merge.
    await db.query(
      `UPDATE agent_qa_cache
       SET answer_context = $1,
           search_text = $2,
           keywords = $3,
           embedding = $4,
           source = CASE
             WHEN agent_qa_cache.source IN ('seed','teach','manual','reviewed-agent')
               THEN agent_qa_cache.source
             ELSE $5
           END,
           category = $6,
           tags = $7,
           confidence_score = COALESCE(confidence_score, $8),
           updated_at = NOW()
       WHERE id = $9`,
      [answer, searchText, keywords, JSON.stringify(vec), source, category,
       mergedTags, confidence, target.id]
    );

    return { status: 'updated', id: target.id, matchType };
  }

  const inserted = await db.query(
    `INSERT INTO agent_qa_cache
       (question, answer_context, search_text, keywords, embedding, source, category, tags, confidence_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [question, answer, searchText, keywords, JSON.stringify(vec), source, category, tags, confidence]
  );

  return { status: 'saved', id: inserted.rows[0].id, matchType: 'new' };
}

module.exports = { captureKnowledge, SEMANTIC_DEDUP_THRESHOLD };
