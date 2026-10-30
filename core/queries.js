/**
 * queries.js - Shared SQL queries for Semantic Brain
 * 
 * Tập trung toàn bộ scoring queries ở 1 nơi duy nhất.
 * Tránh duplicate SQL across find-qa.js, find-qa-context.js, find-qa-deep.js, server.js
 */

/**
 * Core QA ranking query with Hybrid Search (RRF)
 * 
 * Factors:
 *   - Vector Search Rank (cosine)
 *   - Full-text Search Rank (ts_rank_cd)
 *   - RRF Fusion: (1/(60+rank_vec) + 1/(60+rank_fts)) * 30.5
 *   - Time decay freshness (max -30% for >180 days)
 *   - Confidence and Useful Count signals
 * 
 * @param {object} opts
 * @param {number} opts.limit - Max results (default 3)
 * @param {number} opts.minSimilarity - Min cosine similarity threshold (default 0.35)
 * @param {boolean} opts.withTags - Include tag filtering (default true)
 * @param {string} [opts.project] - Project scope; when omitted, only global knowledge is searched
 * @param {boolean} [opts.allProjects] - Explicit cross-project search (admin/analytics)
 * @param {number} [opts.candidateK] - ANN/FTS candidate budget (default 100)
 * @returns {{ text: string, params: (tokens, vec, tags, rawQuery, project) => any[] }}
 */
function qaRankingQuery(opts = {}) {
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 3));
  const minSim = Number.isFinite(Number(opts.minSimilarity))
    ? Math.max(0, Math.min(1, Number(opts.minSimilarity)))
    : 0.35;
  const withTags = opts.withTags !== false;
  const allProjects = opts.allProjects === true;
  const candidateK = Math.max(10, Math.min(1000, parseInt(opts.candidateK, 10) || 100));

  const text = `
    WITH ann AS (
      SELECT id
      FROM agent_qa_cache
      WHERE ($2::text[] IS NULL OR tags && $2::text[])
        AND COALESCE(chunk_type, 'atom') = 'atom'
        AND COALESCE(status, 'active') = 'active'
        AND (valid_to IS NULL OR valid_to > NOW())
        AND (
          $6::boolean = true
          OR ($5::text IS NULL AND scope = 'global')
          OR ($5::text IS NOT NULL AND (project_id = $5::text OR scope = 'global'))
        )
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $7
    ),
    fts AS (
      SELECT id
      FROM agent_qa_cache
      WHERE ($2::text[] IS NULL OR tags && $2::text[])
        AND COALESCE(chunk_type, 'atom') = 'atom'
        AND COALESCE(status, 'active') = 'active'
        AND (valid_to IS NULL OR valid_to > NOW())
        AND (
          $6::boolean = true
          OR ($5::text IS NULL AND scope = 'global')
          OR ($5::text IS NOT NULL AND (project_id = $5::text OR scope = 'global'))
        )
        AND tsv @@ plainto_tsquery('simple', $3)
      ORDER BY ts_rank_cd(tsv, plainto_tsquery('simple', $3)) DESC
      LIMIT $7
    ),
    cand AS (
      SELECT id FROM ann
      UNION
      SELECT id FROM fts
    ),
    base_filter AS (
      SELECT id, question, answer_context, confidence_score, tags, updated_at, use_count,
        scope, project_id, chunk_type, parent_id,
        trust_level, source_type, verifier, valid_from, valid_to, status,
        1 - (embedding <=> $1::vector) AS vector_similarity,
        ts_rank_cd(tsv, plainto_tsquery('simple', $3)) AS fts_score,
        GREATEST(1.0 - LEAST(EXTRACT(EPOCH FROM NOW() - updated_at) / (86400.0 * 180), 0.3), 0.7) AS freshness
      FROM agent_qa_cache
      WHERE id IN (SELECT id FROM cand)
    ),
    ranked AS (
      SELECT *,
        RANK() OVER (ORDER BY vector_similarity DESC) as vector_rank,
        RANK() OVER (ORDER BY fts_score DESC) as fts_rank
      FROM base_filter
      WHERE vector_similarity > ${minSim} OR fts_score > 0.01
    )
    SELECT *,
      (
        ((1.0 / (60.0 + vector_rank)) + (CASE WHEN fts_score > 0 THEN 1.0 / (60.0 + fts_rank) ELSE 0 END)) * 30.5
      ) * freshness
      + confidence_score * 0.05
      + LEAST(COALESCE(use_count, 0)::float / 5.0, 1.0) * 0.05
      AS final_score
    FROM ranked
    ORDER BY final_score DESC
    LIMIT $4
  `;

  return {
    text,
    /**
     * Build params array for pool.query()
     *
     * @param {string[]} tokens
     * @param {string} vecJson
     * @param {string[]|null} tags
     * @param {string} rawQuery
     * @param {string|null} project  project name (without the `project:` prefix)
     */
    params(tokens, vecJson, tags = null, rawQuery = '', project = null) {
      const q = rawQuery || (tokens || []).join(' ');
      return [vecJson, withTags ? tags : null, q, limit, project, allProjects, candidateK];
    }
  };
}

/**
 * Recipe ranking query
 * 
 * @param {object} opts
 * @param {number} opts.limit - Max results (default 1)
 * @returns {{ text: string, params: (tokens, vec, pathVal) => any[] }}
 */
function recipeRankingQuery(opts = {}) {
  const limit = opts.limit || 1;

  const text = `
    WITH scored AS (
      SELECT 
        id, intent, category, target_pattern, steps, skills_used, tools_used,
        hit_count, success_count,
        1 - (embedding <=> $2::vector) AS similarity_score,
        (SELECT COUNT(*) FROM unnest(keywords) kw WHERE kw = ANY($1::text[])) AS kw_score,
        GREATEST(1.0 - LEAST(EXTRACT(EPOCH FROM NOW() - updated_at) / (86400.0 * 90), 0.2), 0.8) AS freshness
      FROM agent_recipes
    )
    SELECT *,
      (
        similarity_score * 0.7 + 
        LEAST(kw_score::float / GREATEST(array_length($1::text[], 1), 1), 1.0) * 0.3 + 
        (CASE 
           WHEN hit_count >= 2 AND (success_count::float / hit_count) < 0.5 THEN -0.5 
           ELSE LEAST(success_count::float / GREATEST(hit_count, 1), 1.0) * 0.1 
         END) +
        (CASE 
           WHEN $3::text != '' AND target_pattern != '' AND $3::text LIKE REPLACE(target_pattern, '*', '%') THEN 0.2 
           ELSE 0 
         END)
      ) * freshness AS final_score
    FROM scored
    WHERE similarity_score > 0.3 OR kw_score >= 1
    ORDER BY final_score DESC
    LIMIT ${limit}
  `;

  return {
    text,
    params(tokens, vecJson, pathVal = '') {
      return [tokens, vecJson, pathVal || ''];
    }
  };
}

/**
 * Skill ranking query
 */
function skillRankingQuery(opts = {}) {
  const text = `
    WITH scored AS (
      SELECT name, type, path, description,
        1 - (embedding <=> $3::vector) AS similarity_score,
        (SELECT COUNT(*) FROM unnest(keywords) kw WHERE kw = ANY($1::text[])) AS kw_score
      FROM agent_registry
    )
    SELECT name, type, path, description,
      (similarity_score * 0.7 + LEAST(kw_score::float / GREATEST(array_length($1::text[], 1), 1), 1.0) * 0.3) AS final_score
    FROM scored
    WHERE similarity_score > 0.3 OR kw_score > 0
    ORDER BY final_score DESC
    LIMIT $2
  `;

  return {
    text,
    params(tokens, topN, vecJson) {
      return [tokens, topN || 3, vecJson];
    }
  };
}

/**
 * Common helper: tokenize a query string into keyword tokens
 */
function tokenize(text) {
  return text.trim().toLowerCase().split(/[\s,.\-_]+/).filter(t => t.length > 2);
}

module.exports = {
  qaRankingQuery,
  recipeRankingQuery,
  skillRankingQuery,
  tokenize,
};
