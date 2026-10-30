/**
 * trust.js — Trust level and provenance defaults.
 *
 * Model output is never a verified fact by default. A verified fact needs a
 * verifier or explicit evidence; user decisions are explicit only.
 */
const TRUST_LEVELS = ['observation', 'hypothesis', 'inference', 'verified_fact', 'user_decision'];
const TRUST_RANK = {
  observation: 1,
  hypothesis: 2,
  inference: 3,
  verified_fact: 4,
  user_decision: 5,
};

function trustRank(level) {
  return TRUST_RANK[level] || 0;
}

function normalizeEvidence(evidence) {
  if (Array.isArray(evidence)) return evidence.map(e => String(e).trim()).filter(Boolean);
  if (typeof evidence === 'string' && evidence.trim()) return [evidence.trim()];
  return [];
}

/**
 * @param {string|undefined} value explicit trust level
 * @param {object} ctx
 * @param {string} [ctx.source]
 * @param {string[]|string} [ctx.evidence]
 * @param {string|null} [ctx.verifier]
 * @returns {string}
 */
function normalizeTrustLevel(value, ctx = {}) {
  const source = String(ctx.source || '');
  const evidence = normalizeEvidence(ctx.evidence);
  const verifier = ctx.verifier || null;

  if (TRUST_LEVELS.includes(value)) {
    if (value === 'verified_fact' && !verifier && evidence.length === 0) {
      return 'hypothesis';
    }
    if (value === 'user_decision' && source !== 'user') {
      return 'hypothesis';
    }
    return value;
  }

  if (['seed', 'teach', 'manual', 'reviewed-agent', 'reviewed-cloud', 'user'].includes(source)) {
    return 'verified_fact';
  }
  if (['auto-harvest', 'proxy-auto', 'auto-qa', 'smart-rag'].includes(source)) {
    return 'inference';
  }
  if (source.startsWith('agent-')) {
    return evidence.length > 0 ? 'hypothesis' : 'observation';
  }
  return 'observation';
}

module.exports = {
  TRUST_LEVELS,
  TRUST_RANK,
  trustRank,
  normalizeEvidence,
  normalizeTrustLevel,
};
