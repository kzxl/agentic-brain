-- 010_ann_first_retrieval.sql
-- Phase 2: full-text candidate generation on a generated tsvector.

ALTER TABLE agent_qa_cache
  ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      COALESCE(question, '') || ' ' || COALESCE(answer_context, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_qa_tsv
  ON agent_qa_cache USING GIN(tsv);
