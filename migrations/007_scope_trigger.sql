-- 007_scope_trigger.sql
-- Safety net for direct INSERTs (seed/import/replay/legacy tools):
-- derive scope from tags when the caller did not provide one.

ALTER TABLE agent_qa_cache ALTER COLUMN scope DROP DEFAULT;

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

  IF NEW.scope = 'global'
     AND NOT ('project:global' = ANY(COALESCE(NEW.tags, '{}'))) THEN
    NEW.tags := array_append(COALESCE(NEW.tags, '{}'), 'project:global');
  END IF;

  NEW.review_status := COALESCE(NEW.review_status, 'none');
  NEW.chunk_type := COALESCE(NEW.chunk_type, 'atom');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_qa_scope ON agent_qa_cache;
CREATE TRIGGER trg_qa_scope
BEFORE INSERT ON agent_qa_cache
FOR EACH ROW
EXECUTE FUNCTION sync_qa_scope();
