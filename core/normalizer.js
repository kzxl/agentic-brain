/**
 * normalizer.js — Validate agent-provided atomic knowledge.
 *
 * No LLM extraction. The calling agent already has the task context and must
 * supply atoms. This module only parses, validates, deduplicates, and bounds
 * the payload before it reaches the writer.
 */
const MAX_ATOMS = 8;
const MAX_ANSWER_CHARS = 1500;
const MAX_QUESTION_CHARS = 300;
const MIN_QUESTION_CHARS = 10;
const MIN_ANSWER_CHARS = 20;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean).slice(0, 12);
  }
  return [];
}

function normalizeHint(value) {
  if (value === 'global' || value === 'project') return value;
  return null;
}

function parseJsonArray(raw) {
  if (typeof raw !== 'string') fail('E_INVALID_PAYLOAD', 'payload must be a JSON string');
  let text = raw.trim().replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) {
    fail('E_INVALID_PAYLOAD', 'payload does not contain a JSON array');
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    fail('E_INVALID_PAYLOAD', `invalid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) fail('E_INVALID_PAYLOAD', 'JSON is not an array');
  return parsed;
}

/**
 * Parse an agent payload: either a JSON array of atoms or
 * { atoms: [...], project, scope, source_ref, confidence, tags, text }.
 */
function parseIngestPayload(raw) {
  let parsed = raw;

  if (typeof raw === 'string') {
    const text = raw.trim().replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      fail('E_INVALID_PAYLOAD', `invalid JSON payload: ${err.message}`);
    }
  }

  if (Array.isArray(parsed)) return { atoms: parsed };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.atoms)) return parsed;
  if (parsed && typeof parsed === 'object' && parsed.question && parsed.answer) {
    return { atoms: [parsed] };
  }
  fail('E_INVALID_PAYLOAD', 'payload must be an atoms array or { atoms: [...] }');
}

function validateAtoms(inputAtoms, opts = {}) {
  const maxAtoms = opts.maxAtoms || MAX_ATOMS;
  if (!Array.isArray(inputAtoms)) fail('E_ATOMS_NOT_ARRAY', 'atoms must be an array');

  const atoms = [];
  const seen = new Set();

  for (const raw of inputAtoms.slice(0, maxAtoms)) {
    if (!raw || typeof raw !== 'object') continue;

    const question = String(raw.question || '').trim();
    const answer = String(raw.answer || '').trim();
    if (question.length < MIN_QUESTION_CHARS) {
      fail('E_ATOM_QUESTION_TOO_SHORT', `question is shorter than ${MIN_QUESTION_CHARS} chars: "${question}"`);
    }
    if (question.length > MAX_QUESTION_CHARS) {
      fail('E_ATOM_QUESTION_TOO_LONG', `question exceeds ${MAX_QUESTION_CHARS} chars`);
    }
    if (answer.length < MIN_ANSWER_CHARS) {
      fail('E_ATOM_ANSWER_TOO_SHORT', `answer is shorter than ${MIN_ANSWER_CHARS} chars`);
    }
    if (answer.length > MAX_ANSWER_CHARS) {
      fail('E_ATOM_ANSWER_TOO_LONG', `answer exceeds ${MAX_ANSWER_CHARS} chars; split the lesson`);
    }

    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    atoms.push({
      question,
      answer,
      scopeHint: normalizeHint(raw.scope_hint ?? raw.scopeHint),
      scopeConfidence: Number.isFinite(Number(raw.scope_confidence ?? raw.scopeConfidence))
        ? Math.max(0, Math.min(1, Number(raw.scope_confidence ?? raw.scopeConfidence)))
        : 0.7,
      tags: asStringArray(raw.tags),
      evidence: asStringArray(raw.evidence),
    });
  }

  return atoms;
}

/**
 * Normalize provided knowledge. No LLM call.
 *
 * Accepted inputs:
 *   - { atoms: [...] }
 *   - { text: "...", structured: true }  // "problem | cause | fix"
 *
 * Raw, unstructured summaries are rejected with E_ATOMS_REQUIRED.
 */
async function normalizeKnowledge(input = {}, opts = {}) {
  const text = String(input.text || '').trim();
  const document = { text, sourceRef: input.sourceRef ? String(input.sourceRef) : null };

  if (Array.isArray(input.atoms)) {
    return { atoms: validateAtoms(input.atoms, opts), document };
  }

  if (input.structured || opts.structured) {
    const parts = text.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      fail('E_STRUCTURED_FORMAT', 'structured input must be "<problem> | <cause> | <fix>"');
    }
    const atoms = validateAtoms([{
      question: parts[0],
      answer: parts.slice(1).join(' | '),
      scope_hint: null,
      tags: [],
      evidence: [],
    }], opts);
    return { atoms, document };
  }

  fail('E_ATOMS_REQUIRED',
    'agent must provide atomic JSON atoms; local LLM extraction was removed. Use tools/ingest-knowledge.js or POST /ingest.');
}

module.exports = {
  normalizeKnowledge,
  validateAtoms,
  parseJsonArray,
  parseIngestPayload,
  MAX_ATOMS,
  MAX_ANSWER_CHARS,
  MAX_QUESTION_CHARS,
};
