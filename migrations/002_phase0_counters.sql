-- 002_phase0_counters.sql
-- Phase 0: separate "retrieved" from "used" signals.

ALTER TABLE agent_qa_cache
  ADD COLUMN IF NOT EXISTS retrieval_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS use_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Preserve historical signal without conflating it with future feedback.
UPDATE agent_qa_cache
SET use_count = COALESCE(useful_count, 0)
WHERE COALESCE(use_count, 0) = 0
  AND COALESCE(useful_count, 0) > 0;

UPDATE agent_qa_cache
SET retrieval_count = COALESCE(hit_count, 0)
WHERE COALESCE(retrieval_count, 0) = 0
  AND COALESCE(hit_count, 0) > 0;

CREATE INDEX IF NOT EXISTS idx_qa_use_count
  ON agent_qa_cache(use_count DESC);
CREATE INDEX IF NOT EXISTS idx_qa_retrieval_count
  ON agent_qa_cache(retrieval_count DESC);
