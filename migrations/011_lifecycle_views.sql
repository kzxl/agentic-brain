-- 011_lifecycle_views.sql
-- Phase 3: lifecycle views use retrieval/use counters, not legacy hit/useful.

CREATE OR REPLACE VIEW v_qa_dashboard AS
SELECT
  count(*)::int AS total,
  count(CASE WHEN COALESCE(retrieval_count, 0) > 0 THEN 1 END)::int AS used,
  round(100.0 * count(CASE WHEN COALESCE(retrieval_count, 0) > 0 THEN 1 END)::numeric
        / NULLIF(count(*), 0)::numeric, 1) AS use_pct,
  sum(COALESCE(retrieval_count, 0))::int AS total_hits,
  count(CASE WHEN COALESCE(use_count, 0) > 0 THEN 1 END)::int AS proven_useful,
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
  COALESCE(retrieval_count, 0) AS hit_count,
  COALESCE(use_count, 0) AS useful_count,
  confidence_score,
  length(answer_context) AS answer_len,
  EXTRACT(DAY FROM NOW() - COALESCE(updated_at, created_at))::int AS age_days,
  round((
    LEAST(COALESCE(retrieval_count, 0)::float / 10.0, 1.0) * 0.30
    + LEAST(COALESCE(use_count, 0)::float / 3.0, 1.0) * 0.25
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
