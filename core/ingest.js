/**
 * ingest.js — Atomic ingestion pipeline.
 *
 * Long text -> normalizer -> optional parent document -> one writer call per atom.
 * Every atom gets its own embedding; documents are containers only.
 */
const { normalizeKnowledge } = require('./normalizer');
const { captureKnowledge } = require('./knowledge');

/**
 * @param {object} input
 * @param {string} input.text
 * @param {string|null} [input.project]
 * @param {string} [input.source='ingest']
 * @param {string|null} [input.sourceRef]
 * @param {string[]} [input.tags]
 * @param {number} [input.confidence=0.6]
 * @param {'project'|'global'} [input.scope]
 * @param {boolean} [input.structured]
 * @param {boolean} [input.createParent=true]
 * @param {object[]} [input.atoms]  agent-provided atoms; no LLM is called
 * @param {object} [opts]
 * @param {object} [opts.db]
 * @returns {Promise<{count:number, parentId:number|null, ids:number[]}>}
 */
async function ingestText(input = {}, opts = {}) {
  const db = opts.db;
  const source = input.source || 'ingest';
  const confidence = input.confidence !== undefined ? input.confidence : 0.6;
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const createParent = input.createParent !== false;

  const normalized = await normalizeKnowledge(input, opts);
  const atoms = normalized.atoms || [];
  if (atoms.length === 0) {
    return { count: 0, parentId: null, ids: [] };
  }

  // A document is only needed when one input produced multiple atoms.
  const sourceRef = input.sourceRef
    || (atoms.length > 1 ? `${source}:${Date.now()}` : null);

  let parentId = null;
  if (createParent && atoms.length > 1) {
    const parent = await captureKnowledge({
      question: `[DOCUMENT] ${sourceRef || 'untitled'}`,
      answer: normalized.document.text,
      source,
      tags,
      confidence,
      project: input.project || null,
      scope: input.scope,
      scopeHint: atoms[0].scopeHint,
      scopeHintConfidence: atoms[0].scopeConfidence,
      chunkType: 'document',
      sourceRef,
    }, db);
    parentId = parent.id;
  }

  const ids = [];
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    const result = await captureKnowledge({
      question: atom.question,
      answer: atom.answer,
      source,
      tags: [...tags, ...(atom.tags || [])],
      confidence,
      project: input.project || null,
      scope: input.scope,
      scopeHint: atom.scopeHint,
      scopeHintConfidence: atom.scopeConfidence,
      parentId,
      atomIndex: i,
      chunkType: 'atom',
      sourceRef,
    }, db);
    ids.push(result.id);
  }

  return { count: ids.length, parentId, ids };
}

module.exports = { ingestText };
