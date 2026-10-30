/**
 * scope.js — Deterministic scope resolution.
 *
 * A record is either:
 *   - project: belongs to one project (default when project context exists)
 *   - global: shared background knowledge
 *
 * Explicit input wins. Otherwise we use project context plus content signals.
 * A generic-looking lesson inside a project becomes a *global candidate* and
 * stays project-scoped until a reviewer approves it.
 */

const PROJECT_MARKERS = [
  /\b(?:MDS|MOP|MLG2|RAF|ERP|ZeroAgent|ZeroUniverse|ZeroUI|ZeroVector|SyncDB|MMS)\b/i,
  /\btb[A-Z][A-Za-z0-9_]+/,
  /\bI[A-Z][A-Za-z0-9_]*Service\b/,
  /\b(?:Features|Controllers?|Services?|Repositories?)\s*[\/\\][A-Za-z0-9_.\/\\-]+/i,
  /\b[A-Za-z]:[\\\/]/,
  /\b[A-Za-z0-9_]+\.(?:cs|sql|csproj|sln)\b/i,
  /\b(?:db[A-Z][A-Za-z0-9_]+|DataContext)\b/,
];

const GENERIC_MARKERS = [
  /\b(?:javascript|typescript|node(?:\.js)?|python|rust|golang|php|react|winforms|wpf|devexpress|sql|postgres(?:ql)?|async|await|dto|solid|clean architecture|design pattern|api|rest|json)\b/i,
];

function normalizeProject(project) {
  if (!project) return null;
  const p = String(project).trim().toLowerCase();
  return p && p !== 'global' ? p : null;
}

function isProjectSpecific(text) {
  return PROJECT_MARKERS.some(re => re.test(text || ''));
}

function isGeneric(text) {
  return GENERIC_MARKERS.some(re => re.test(text || ''));
}

/**
 * @param {object} input
 * @param {'project'|'global'|null} [input.explicitScope]
 * @param {string|null} [input.project]
 * @param {string} [input.content]
 * @param {string[]} [input.tags]
 * @param {string} [input.source]
 * @param {'project'|'global'|null} [input.scopeHint]  hint from the normalizer
 * @param {number} [input.scopeHintConfidence]
 * @returns {{scope:'project'|'global', origin:string, reason:string, confidence:number,
 *            candidate:'global'|null, reviewStatus:'none'|'pending'}}
 */
function resolveScope(input = {}) {
  const project = normalizeProject(input.project);
  const explicit = input.explicitScope === 'global' || input.explicitScope === 'project'
    ? input.explicitScope
    : null;
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const content = String(input.content || '');
  const source = String(input.source || '');

  if (explicit === 'global') {
    return {
      scope: 'global',
      origin: 'explicit',
      reason: 'explicit --scope=global',
      confidence: 1,
      candidate: null,
      reviewStatus: 'none',
    };
  }

  if (explicit === 'project') {
    if (project) {
      return {
        scope: 'project',
        origin: 'explicit',
        reason: 'explicit --scope=project',
        confidence: 1,
        candidate: null,
        reviewStatus: 'none',
      };
    }
    return {
      scope: 'global',
      origin: 'explicit',
      reason: 'project scope requested without project context; stored global',
      confidence: 0.8,
      candidate: null,
      reviewStatus: 'none',
    };
  }

  if (tags.includes('project:global') && !project) {
    return {
      scope: 'global',
      origin: 'tag',
      reason: 'explicit project:global tag',
      confidence: 0.95,
      candidate: null,
      reviewStatus: 'none',
    };
  }

  const hint = input.scopeHint === 'global' || input.scopeHint === 'project'
    ? input.scopeHint
    : null;
  const hintConfidence = Number.isFinite(Number(input.scopeHintConfidence))
    ? Math.max(0, Math.min(1, Number(input.scopeHintConfidence)))
    : 0.75;

  if (hint === 'global') {
    if (project) {
      // Do not auto-publish a project lesson as global; queue it for review.
      return {
        scope: 'project',
        origin: 'normalizer',
        reason: 'normalizer suggested global; project-scoped until review',
        confidence: hintConfidence,
        candidate: 'global',
        reviewStatus: 'pending',
      };
    }
    return {
      scope: 'global',
      origin: 'normalizer',
      reason: 'normalizer suggested global; no project context',
      confidence: hintConfidence,
      candidate: null,
      reviewStatus: 'none',
    };
  }

  if (hint === 'project') {
    return {
      scope: project ? 'project' : 'global',
      origin: 'normalizer',
      reason: project ? 'normalizer suggested project' : 'project hint without context; stored global',
      confidence: hintConfidence,
      candidate: null,
      reviewStatus: 'none',
    };
  }

  const projectSpecific = isProjectSpecific(content);

  if (!project) {
    return {
      scope: 'global',
      origin: 'default',
      reason: projectSpecific
        ? 'project-specific content without project context; stored global'
        : 'no project context',
      confidence: 0.7,
      candidate: null,
      reviewStatus: 'none',
    };
  }

  if (projectSpecific) {
    return {
      scope: 'project',
      origin: 'heuristic',
      reason: 'project-specific identifier detected',
      confidence: 0.9,
      candidate: null,
      reviewStatus: 'none',
    };
  }

  if (isGeneric(content) && source !== 'seed') {
    return {
      scope: 'project',
      origin: 'heuristic',
      reason: 'generic lesson inside a project; global candidate',
      confidence: 0.65,
      candidate: 'global',
      reviewStatus: 'pending',
    };
  }

  return {
    scope: 'project',
    origin: 'context',
    reason: 'project context default',
    confidence: 0.6,
    candidate: null,
    reviewStatus: 'none',
  };
}

module.exports = {
  resolveScope,
  isProjectSpecific,
  isGeneric,
  normalizeProject,
  PROJECT_MARKERS,
  GENERIC_MARKERS,
};
