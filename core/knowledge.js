/**
 * knowledge.js — Single write path for knowledge capture.
 *
 * Phase 2:
 *   - project_id is a real column (unique per project/question)
 *   - deterministic scope resolution
 *   - explicit trust/provenance (source type, evidence, verifier, validity)
 *   - documents and atoms are linked via parent_id/source_ref
 */
const pool = require('./db');
const { embed } = require('./embed');
const { extractKeywords, inferTags } = require('./keywords');
const { resolveScope } = require('./scope');
const { normalizeTrustLevel, normalizeEvidence, trustRank } = require('./trust');

const SEMANTIC_DEDUP_THRESHOLD = 0.85;

function clampConfidence(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeProject(project) {
  return project ? String(project).trim().toLowerCase() : null;
}

function buildTags(question, answer, tags, scope, project, pinned) {
  const merged = inferTags(question, answer, tags || []);
  const projectTag = scope === 'global'
    ? 'project:global'
    : (project ? `project:${project}` : 'project:global');

  const filtered = merged.filter(t => !t.startsWith('project:') || t === projectTag);
  if (!filtered.includes(projectTag)) filtered.push(projectTag);
  if (pinned && !filtered.includes('pinned')) filtered.push('pinned');
  return filtered;
}

function resolveInputScope(input, project, source, content) {
  return resolveScope({
    explicitScope: input.scope,
    project,
    content,
    tags: input.tags,
    source,
    scopeHint: input.scopeHint,
    scopeHintConfidence: input.scopeHintConfidence,
  });
}

function buildProvenance(input, source) {
  const evidence = normalizeEvidence(input.evidence);
  const verifier = input.verifier || input.verifierName || null;
  const trustLevel = normalizeTrustLevel(input.trustLevel || input.trust_level, {
    source,
    evidence,
    verifier,
  });
  const sourceType = input.sourceType || input.source_type || source;
  const verifiedAt = (trustLevel === 'verified_fact' || trustLevel === 'user_decision')
    ? (input.verifiedAt || input.verified_at || new Date())
    : (input.verifiedAt || input.verified_at || null);
  const validFrom = input.validFrom || input.valid_from || new Date();
  const validTo = input.validTo || input.valid_to || null;
  const status = input.status || 'active';

  return {
    evidence,
    evidenceJson: JSON.stringify(evidence),
    verifier,
    trustLevel,
    trustRankValue: trustRank(trustLevel),
    sourceType,
    verifiedAt,
    validFrom,
    validTo,
    status,
  };
}

/**
 * Capture a Q/A item or a parent document.
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
 * @param {'project'|'global'} [input.scope]
 * @param {'project'|'global'} [input.scopeHint]
 * @param {number} [input.scopeHintConfidence]
 * @param {'atom'|'document'} [input.chunkType='atom']
 * @param {number|null} [input.parentId]
 * @param {number|null} [input.atomIndex]
 * @param {string|null} [input.sourceRef]
 * @param {string} [input.trustLevel]
 * @param {string} [input.sourceType]
 * @param {string[]|string} [input.evidence]
 * @param {string|null} [input.verifier]
 * @param {Date|string} [input.verifiedAt]
 * @param {Date|string} [input.validFrom]
 * @param {Date|string|null} [input.validTo]
 * @param {string} [input.status]
 * @param {object} [db=pool]
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
  const chunkType = input.chunkType === 'document' ? 'document' : 'atom';
  const parentId = Number.isInteger(input.parentId) ? input.parentId : null;
  const atomIndex = Number.isInteger(input.atomIndex) ? input.atomIndex : null;
  const sourceRef = input.sourceRef ? String(input.sourceRef) : null;

  const content = `${question}\n${answer}`;
  const scopeInfo = resolveInputScope(input, project, source, content);
  const projectId = scopeInfo.scope === 'global' ? 'global' : (project || 'unknown');
  const tags = buildTags(question, answer, input.tags, scopeInfo.scope, project, input.pinned);
  const provenance = buildProvenance(input, source);

  const searchText = `${question} ${answer}`.toLowerCase();
  const keywords = extractKeywords(searchText);

  // ---- Parent document -------------------------------------------------
  if (chunkType === 'document') {
    const existing = sourceRef
      ? await db.query(
          `SELECT id FROM agent_qa_cache
           WHERE chunk_type = 'document' AND source_ref = $1
           LIMIT 1`,
          [sourceRef]
        )
      : { rows: [] };

    if (existing.rows.length > 0) {
      const id = existing.rows[0].id;
      await db.query(
        `UPDATE agent_qa_cache
         SET question = $1,
             answer_context = $2,
             search_text = $3,
             keywords = $4,
             source = $5,
             category = $6,
             tags = $7,
             confidence_score = COALESCE(confidence_score, $8),
             scope = $9,
             scope_origin = $10,
             scope_reason = $11,
             scope_confidence = $12,
             scope_candidate = $13,
             review_status = $14,
             trust_level = $15,
             source_type = $16,
             evidence = $17::jsonb,
             verifier = $18,
             verified_at = $19,
             valid_from = $20,
             valid_to = $21,
             status = $22,
             project_id = $23,
             source_ref = $24,
             updated_at = NOW()
         WHERE id = $25`,
        [question, answer, searchText, keywords, source, category, tags, confidence,
         scopeInfo.scope, scopeInfo.origin, scopeInfo.reason, scopeInfo.confidence,
         scopeInfo.candidate, scopeInfo.reviewStatus, provenance.trustLevel,
         provenance.sourceType, provenance.evidenceJson, provenance.verifier,
         provenance.verifiedAt, provenance.validFrom, provenance.validTo,
         provenance.status, projectId, sourceRef, id]
      );
      return { status: 'updated', id, matchType: 'document' };
    }

    const inserted = await db.query(
      `INSERT INTO agent_qa_cache
         (question, answer_context, search_text, keywords, embedding, source, category, tags,
          confidence_score, scope, scope_origin, scope_reason, scope_confidence,
          scope_candidate, review_status, trust_level, source_type, evidence, verifier,
          verified_at, valid_from, valid_to, status, parent_id, atom_index, chunk_type,
          source_ref, project_id)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17::jsonb, $18, $19, $20, $21, $22,
               NULL, NULL, 'document', $23, $24)
       RETURNING id`,
      [question, answer, searchText, keywords, source, category, tags, confidence,
       scopeInfo.scope, scopeInfo.origin, scopeInfo.reason, scopeInfo.confidence,
       scopeInfo.candidate, scopeInfo.reviewStatus, provenance.trustLevel,
       provenance.sourceType, provenance.evidenceJson, provenance.verifier,
       provenance.verifiedAt, provenance.validFrom, provenance.validTo,
       provenance.status, sourceRef, projectId]
    );
    return { status: 'saved', id: inserted.rows[0].id, matchType: 'document' };
  }

  // ---- Atom ------------------------------------------------------------
  const vec = await embed(searchText);

  const scopePredicate = scopeInfo.scope === 'global'
    ? "scope = 'global'"
    : "project_id = $2::text";
  const exactParams = scopeInfo.scope === 'global'
    ? [question]
    : [question, projectId];

  const exact = await db.query(
    `SELECT id, question, answer_context, tags, confidence_score
     FROM agent_qa_cache
     WHERE question_hash = md5(lower($1))
       AND COALESCE(chunk_type, 'atom') = 'atom'
       AND ${scopePredicate}
     LIMIT 1`,
    exactParams
  );

  let target = exact.rows[0] || null;
  let matchType = target ? 'exact_hash' : null;

  if (!target) {
    const scopeSql = scopeInfo.scope === 'global'
      ? "scope = 'global'"
      : "project_id = $2::text";
    const thresholdIdx = scopeInfo.scope === 'global' ? '$2' : '$3';
    const simParams = scopeInfo.scope === 'global'
      ? [JSON.stringify(vec), SEMANTIC_DEDUP_THRESHOLD]
      : [JSON.stringify(vec), projectId, SEMANTIC_DEDUP_THRESHOLD];

    const sim = await db.query(
      `SELECT id, question, answer_context, tags, confidence_score,
              1 - (embedding <=> $1::vector) AS similarity
       FROM agent_qa_cache
       WHERE COALESCE(chunk_type, 'atom') = 'atom'
         AND ${scopeSql}
         AND embedding IS NOT NULL
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

    const mergedTags = [...new Set([...(target.tags || []), ...tags])]
      .filter(t => !t.startsWith('project:') || t === tags.find(x => x.startsWith('project:')));

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
           scope = COALESCE(scope, $9),
           scope_origin = COALESCE(scope_origin, $10),
           scope_reason = COALESCE(scope_reason, $11),
           scope_confidence = COALESCE(scope_confidence, $12),
           scope_candidate = COALESCE(scope_candidate, $13),
           review_status = COALESCE(review_status, $14),
           trust_level = CASE
             WHEN trust_level IS NULL THEN $15
             WHEN $16 > CASE trust_level
               WHEN 'observation' THEN 1
               WHEN 'hypothesis' THEN 2
               WHEN 'inference' THEN 3
               WHEN 'verified_fact' THEN 4
               WHEN 'user_decision' THEN 5
               ELSE 0
             END
             THEN $15
             ELSE trust_level
           END,
           source_type = COALESCE($17, source_type),
           evidence = CASE
             WHEN $18::jsonb <> '[]'::jsonb THEN $18::jsonb
             ELSE COALESCE(evidence, '[]'::jsonb)
           END,
           verifier = COALESCE($19, verifier),
           verified_at = COALESCE($20, verified_at),
           valid_from = COALESCE(valid_from, $21),
           valid_to = COALESCE($22, valid_to),
           status = COALESCE($23, status),
           parent_id = COALESCE(parent_id, $24),
           atom_index = COALESCE(atom_index, $25),
           chunk_type = COALESCE(chunk_type, 'atom'),
           source_ref = COALESCE(source_ref, $26),
           project_id = COALESCE(project_id, $27),
           updated_at = NOW()
       WHERE id = $28`,
      [answer, searchText, keywords, JSON.stringify(vec), source, category, mergedTags,
       confidence, scopeInfo.scope, scopeInfo.origin, scopeInfo.reason, scopeInfo.confidence,
       scopeInfo.candidate, scopeInfo.reviewStatus, provenance.trustLevel,
       provenance.trustRankValue, provenance.sourceType, provenance.evidenceJson,
       provenance.verifier, provenance.verifiedAt, provenance.validFrom,
       provenance.validTo, provenance.status, parentId, atomIndex, sourceRef,
       projectId, target.id]
    );

    return { status: 'updated', id: target.id, matchType };
  }

  const inserted = await db.query(
    `INSERT INTO agent_qa_cache
       (question, answer_context, search_text, keywords, embedding, source, category, tags,
        confidence_score, scope, scope_origin, scope_reason, scope_confidence,
        scope_candidate, review_status, trust_level, source_type, evidence, verifier,
        verified_at, valid_from, valid_to, status, parent_id, atom_index, chunk_type,
        source_ref, project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18::jsonb, $19, $20, $21, $22, $23,
             $24, $25, 'atom', $26, $27)
     RETURNING id`,
    [question, answer, searchText, keywords, JSON.stringify(vec), source, category, tags,
     confidence, scopeInfo.scope, scopeInfo.origin, scopeInfo.reason, scopeInfo.confidence,
     scopeInfo.candidate, scopeInfo.reviewStatus, provenance.trustLevel,
     provenance.sourceType, provenance.evidenceJson, provenance.verifier,
     provenance.verifiedAt, provenance.validFrom, provenance.validTo,
     provenance.status, parentId, atomIndex, sourceRef, projectId]
  );

  return { status: 'saved', id: inserted.rows[0].id, matchType: 'new' };
}

module.exports = {
  captureKnowledge,
  resolveInputScope,
  buildTags,
  buildProvenance,
  SEMANTIC_DEDUP_THRESHOLD,
};
