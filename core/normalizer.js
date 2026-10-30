/**
 * normalizer.js — Turn a long summary into atomic, independently retrievable
 * knowledge atoms, and validate them before they reach the writer.
 *
 * The LLM proposes atoms; deterministic validation decides what is stored.
 */
const { askLLM } = require('./llm-local');

const MAX_ATOMS = 8;
const MAX_ANSWER_CHARS = 1500;
const MAX_QUESTION_CHARS = 300;
const MIN_QUESTION_CHARS = 10;
const MIN_ANSWER_CHARS = 20;
const LONG_INPUT_CHARS = 600;

const SYSTEM_PROMPT = `You extract atomic engineering lessons from a coding session.

Return ONLY a JSON array. Do not wrap it in markdown.
Each item must have this shape:
{
  "question": "natural search query a developer would type",
  "answer": "concise lesson with root cause, fix, and invariant (max 150 words)",
  "scope_hint": "project" | "global" | null,
  "scope_confidence": 0.0,
  "tags": ["specific", "multi-dimensional"],
  "evidence": ["file:line", "test name", "commit", "error code"]
}

Rules:
- One item = one lesson. Never merge multiple lessons into one item.
- If the text contains several lessons, split them.
- scope_hint = "project" when the lesson references a specific product, module,
  table, file, or codebase. scope_hint = "global" only for reusable language,
  framework, architecture, or process knowledge.
- Ignore transient environment noise (VPN, expired tokens, disk full, missing
  local binaries) and one-off UI text changes.
- If there is no generalizable lesson, return [].
- Return at most ${MAX_ATOMS} items.`;

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
  if (typeof raw !== 'string') fail('E_EXTRACTOR_INVALID', 'extractor returned non-string');
  let text = raw.trim();
  text = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    fail('E_EXTRACTOR_INVALID_JSON', 'extractor did not return a JSON array');
  }

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    fail('E_EXTRACTOR_INVALID_JSON', `extractor JSON parse failed: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    fail('E_EXTRACTOR_INVALID', 'extractor JSON is not an array');
  }
  return parsed;
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

    const scopeHint = normalizeHint(raw.scope_hint ?? raw.scopeHint);
    const scopeConfidence = Number.isFinite(Number(raw.scope_confidence ?? raw.scopeConfidence))
      ? Math.max(0, Math.min(1, Number(raw.scope_confidence ?? raw.scopeConfidence)))
      : 0.7;

    atoms.push({
      question,
      answer,
      scopeHint,
      scopeConfidence,
      tags: asStringArray(raw.tags),
      evidence: asStringArray(raw.evidence),
    });
  }

  return atoms;
}

async function extractAtomsWithLLM(text, opts = {}) {
  const maxAtoms = opts.maxAtoms || MAX_ATOMS;
  const project = opts.project || '(none)';
  const prompt = `PROJECT: ${project}\n\n=== SESSION TEXT ===\n${text}\n\n=== EXTRACTION ===\nReturn the JSON array now (max ${maxAtoms} items).`;

  const result = await askLLM(prompt, {
    system: SYSTEM_PROMPT,
    maxTokens: 2200,
    temperature: 0.2,
  });

  return validateAtoms(parseJsonArray(result.text), { maxAtoms });
}

/**
 * Normalize a long text or a structured "problem | cause | fix" into atoms.
 *
 * @param {object} input
 * @param {string} input.text
 * @param {boolean} [input.structured]
 * @param {string|null} [input.project]
 * @param {string|null} [input.sourceRef]
 * @param {Function} [opts.extractor]  injectable for tests
 * @returns {Promise<{atoms: object[], document: {text: string, sourceRef: string|null}}>}
 */
async function normalizeKnowledge(input = {}, opts = {}) {
  const text = String(input.text || '').trim();
  const sourceRef = input.sourceRef ? String(input.sourceRef) : null;
  const document = { text, sourceRef };

  if (input.atoms) {
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

  if (text.length < 40) {
    fail('E_INPUT_TOO_SHORT', 'input must be at least 40 characters');
  }

  const extractor = opts.extractor || extractAtomsWithLLM;

  try {
    const rawAtoms = await extractor(text, { project: input.project || null, maxAtoms: opts.maxAtoms || MAX_ATOMS });
    const atoms = validateAtoms(rawAtoms, opts);
    if (atoms.length === 0 && text.length > LONG_INPUT_CHARS) {
      fail('E_ATOMIC_REQUIRED', 'no atomic lesson extracted from a long text; refusing to store a long cluster');
    }
    return { atoms, document };
  } catch (err) {
    // Short notes may fall back to a single atom when the extractor is
    // unavailable; long clusters must never be stored as one item.
    if (text.length <= LONG_INPUT_CHARS && err.code !== 'E_ATOM_ANSWER_TOO_LONG') {
      const atoms = validateAtoms([{
        question: text.slice(0, 120),
        answer: text,
        scope_hint: null,
        tags: [],
        evidence: [],
      }], opts);
      return { atoms, document };
    }
    throw err;
  }
}

module.exports = {
  normalizeKnowledge,
  validateAtoms,
  parseJsonArray,
  extractAtomsWithLLM,
  MAX_ATOMS,
  MAX_ANSWER_CHARS,
  MAX_QUESTION_CHARS,
  LONG_INPUT_CHARS,
  SYSTEM_PROMPT,
};
