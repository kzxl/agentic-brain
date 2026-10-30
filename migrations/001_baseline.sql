-- 001_baseline.sql
-- Idempotent baseline schema for Semantic Brain.
-- Matches the live PostgreSQL schema as of 2026-10-30, including objects
-- that were previously missing from maintenance/setup.js.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Skill / workflow registry
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_registry (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('skill', 'workflow')),
  path TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  keywords TEXT[] DEFAULT '{}',
  content_preview TEXT DEFAULT '',
  search_text TEXT DEFAULT '',
  embedding vector(1024),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(name, type)
);

CREATE INDEX IF NOT EXISTS idx_registry_vector
  ON agent_registry USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_registry_keywords
  ON agent_registry USING GIN(keywords);

-- ============================================================
-- Procedural memory (recipes)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_recipes (
  id SERIAL PRIMARY KEY,
  intent TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'general',
  target_pattern TEXT DEFAULT '',
  steps JSONB NOT NULL DEFAULT '[]',
  skills_used TEXT[] DEFAULT '{}',
  tools_used TEXT[] DEFAULT '{}',
  search_text TEXT DEFAULT '',
  embedding vector(1024),
  keywords TEXT[] DEFAULT '{}',
  hit_count INT DEFAULT 0,
  success_count INT DEFAULT 0,
  registry_ids INT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipes_vector
  ON agent_recipes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_recipes_keywords
  ON agent_recipes USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_recipes_category
  ON agent_recipes(category);

-- ============================================================
-- Episodic / semantic knowledge cache
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_qa_cache (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer_context TEXT NOT NULL,
  source VARCHAR(50) DEFAULT 'manual',
  category VARCHAR(50) DEFAULT 'general',
  tags TEXT[] DEFAULT '{}',
  search_text TEXT DEFAULT '',
  embedding vector(1024),
  keywords TEXT[] DEFAULT '{}',
  question_hash TEXT GENERATED ALWAYS AS (md5(lower(question))) STORED,
  hit_count INT DEFAULT 0,
  useful_count INT DEFAULT 0,
  confidence_score FLOAT DEFAULT 1.0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_embedding_hnsw
  ON agent_qa_cache USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_qa_keywords
  ON agent_qa_cache USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_qa_tags
  ON agent_qa_cache USING GIN(tags);
-- Phase 0: non-unique because scope is a tag. Phase 1 replaces this with
-- UNIQUE(project_id, question_hash).
CREATE INDEX IF NOT EXISTS idx_qa_question_hash
  ON agent_qa_cache(question_hash);
CREATE INDEX IF NOT EXISTS idx_qa_category
  ON agent_qa_cache(category);
CREATE INDEX IF NOT EXISTS idx_qa_hit_count
  ON agent_qa_cache(hit_count DESC);

-- ============================================================
-- Audit + telemetry
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_qa_history (
  id SERIAL PRIMARY KEY,
  qa_id INT REFERENCES agent_qa_cache(id) ON DELETE CASCADE,
  old_answer TEXT,
  new_answer TEXT,
  changed_by VARCHAR(50) DEFAULT 'agent',
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_qa_querylog (
  id SERIAL PRIMARY KEY,
  query TEXT NOT NULL,
  top_result_id INT,
  score REAL,
  tags TEXT[],
  source VARCHAR(50) DEFAULT 'cli',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  tokens_saved INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_querylog_created
  ON agent_qa_querylog(created_at DESC);

-- ============================================================
-- Embedding cache
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_query_embedding_cache (
  query_hash VARCHAR(32) PRIMARY KEY,
  query_text TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Codebase index
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_codebase_index (
  id SERIAL PRIMARY KEY,
  file_path TEXT UNIQUE NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  embedding vector(1024),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_codebase_embedding
  ON agent_codebase_index USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================
-- Operational views (were present in the live DB, missing from setup.js)
-- ============================================================
CREATE OR REPLACE VIEW v_qa_dashboard AS
SELECT
  count(*)::int AS total,
  count(CASE WHEN hit_count > 0 THEN 1 END)::int AS used,
  round(100.0 * count(CASE WHEN hit_count > 0 THEN 1 END)::numeric
        / NULLIF(count(*), 0)::numeric, 1) AS use_pct,
  sum(hit_count)::int AS total_hits,
  count(CASE WHEN COALESCE(useful_count, 0) > 0 THEN 1 END)::int AS proven_useful,
  avg(length(answer_context))::int AS avg_answer_len,
  count(CASE WHEN tags IS NULL OR array_length(tags, 1) IS NULL THEN 1 END)::int AS no_tags,
  count(CASE WHEN answer_context LIKE '%[CODE]%' THEN 1 END)::int AS has_code
FROM agent_qa_cache;

CREATE OR REPLACE VIEW v_qa_quality AS
SELECT
  id,
  question,
  answer_context,
  source,
  tags,
  hit_count,
  COALESCE(useful_count, 0) AS useful_count,
  confidence_score,
  length(answer_context) AS answer_len,
  EXTRACT(DAY FROM NOW() - COALESCE(updated_at, created_at))::int AS age_days,
  round((
    LEAST(hit_count::float / 10.0, 1.0) * 0.30
    + LEAST(COALESCE(useful_count, 0)::float / 3.0, 1.0) * 0.25
    + CASE
        WHEN length(answer_context) >= 200 AND length(answer_context) <= 1000 THEN 1.0
        WHEN length(answer_context) >= 100 AND length(answer_context) < 200 THEN 0.7
        WHEN length(answer_context) > 1000 THEN 0.8
        ELSE 0.4
      END * 0.15
    + GREATEST(1.0 - EXTRACT(EPOCH FROM NOW() - COALESCE(updated_at, created_at))
               / (86400.0 * 180), 0.5) * 0.15
    + CASE WHEN answer_context LIKE '%[CODE]%' THEN 1.0 ELSE 0.5 END * 0.15
  )::numeric, 3) AS quality_score
FROM agent_qa_cache;

CREATE OR REPLACE VIEW v_querylog_summary AS
SELECT
  date(created_at) AS day,
  count(*)::int AS queries,
  count(DISTINCT query)::int AS unique_queries,
  round(avg(score)::numeric, 3) AS avg_score,
  count(CASE WHEN score > 0.7 THEN 1 END)::int AS good_hits,
  count(CASE WHEN score <= 0.7 THEN 1 END)::int AS weak_hits
FROM agent_qa_querylog
GROUP BY date(created_at)
ORDER BY date(created_at) DESC
LIMIT 30;
