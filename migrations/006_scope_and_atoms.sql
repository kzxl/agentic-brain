-- 006_scope_and_atoms.sql
-- Phase 1: explicit scope, review queue, and atomic document/atom metadata.

ALTER TABLE agent_qa_cache
  ADD COLUMN IF NOT EXISTS scope TEXT,
  ADD COLUMN IF NOT EXISTS scope_origin TEXT,
  ADD COLUMN IF NOT EXISTS scope_reason TEXT,
  ADD COLUMN IF NOT EXISTS scope_confidence REAL,
  ADD COLUMN IF NOT EXISTS scope_candidate TEXT,
  ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES agent_qa_cache(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS atom_index INT,
  ADD COLUMN IF NOT EXISTS chunk_type TEXT DEFAULT 'atom',
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

UPDATE agent_qa_cache
SET scope = CASE
  WHEN 'project:global' = ANY(COALESCE(tags, '{}')) THEN 'global'
  ELSE 'project'
END
WHERE scope IS NULL;

UPDATE agent_qa_cache
SET scope_origin = COALESCE(scope_origin, 'migration'),
    scope_reason = COALESCE(scope_reason, 'backfilled from project tag'),
    review_status = COALESCE(review_status, 'none'),
    chunk_type = COALESCE(chunk_type, 'atom')
WHERE scope_origin IS NULL
   OR scope_reason IS NULL
   OR review_status IS NULL
   OR chunk_type IS NULL;

ALTER TABLE agent_qa_cache ALTER COLUMN scope SET DEFAULT 'project';
ALTER TABLE agent_qa_cache ALTER COLUMN scope SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qa_scope
  ON agent_qa_cache(scope);
CREATE INDEX IF NOT EXISTS idx_qa_review_status
  ON agent_qa_cache(review_status);
CREATE INDEX IF NOT EXISTS idx_qa_parent
  ON agent_qa_cache(parent_id);
CREATE INDEX IF NOT EXISTS idx_qa_source_ref
  ON agent_qa_cache(source_ref);
