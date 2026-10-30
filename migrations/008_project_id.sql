-- 008_project_id.sql
-- Phase 2: project_id is a real column, not a tag convention.

ALTER TABLE agent_qa_cache
  ADD COLUMN IF NOT EXISTS project_id TEXT;

UPDATE agent_qa_cache
SET project_id = CASE
  WHEN scope = 'global' THEN 'global'
  ELSE COALESCE(
    (
      SELECT split_part(t, ':', 2)
      FROM unnest(COALESCE(tags, '{}')) AS t
      WHERE t LIKE 'project:%'
        AND t <> 'project:global'
      LIMIT 1
    ),
    'unknown'
  )
END
WHERE project_id IS NULL;

ALTER TABLE agent_qa_cache ALTER COLUMN project_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qa_project_id
  ON agent_qa_cache(project_id);

-- One atom per question per project. Documents are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_unique_project_question
  ON agent_qa_cache(project_id, question_hash)
  WHERE COALESCE(chunk_type, 'atom') = 'atom';

-- Keep direct INSERTs correct (seed/import/replay/legacy tools).
CREATE OR REPLACE FUNCTION sync_qa_scope() RETURNS trigger AS $$
BEGIN
  IF NEW.scope IS NULL THEN
    NEW.scope := CASE
      WHEN 'project:global' = ANY(COALESCE(NEW.tags, '{}')) THEN 'global'
      ELSE 'project'
    END;
    NEW.scope_origin := COALESCE(NEW.scope_origin, 'trigger');
    NEW.scope_reason := COALESCE(NEW.scope_reason, 'derived from tags');
    NEW.scope_confidence := COALESCE(NEW.scope_confidence, 0.6);
  END IF;

  IF NEW.project_id IS NULL THEN
    NEW.project_id := CASE
      WHEN NEW.scope = 'global' THEN 'global'
      ELSE COALESCE(
        (
          SELECT split_part(t, ':', 2)
          FROM unnest(COALESCE(NEW.tags, '{}')) AS t
          WHERE t LIKE 'project:%'
            AND t <> 'project:global'
          LIMIT 1
        ),
        'unknown'
      )
    END;
  END IF;

  IF NEW.scope = 'global'
     AND NOT ('project:global' = ANY(COALESCE(NEW.tags, '{}'))) THEN
    NEW.tags := array_append(COALESCE(NEW.tags, '{}'), 'project:global');
  END IF;

  NEW.review_status := COALESCE(NEW.review_status, 'none');
  NEW.chunk_type := COALESCE(NEW.chunk_type, 'atom');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
