-- 003_global_project_tag.sql
-- Phase 0: make the interim project filter safe.
-- Every record must either belong to a project or be explicitly global.

UPDATE agent_qa_cache
SET tags = array_append(COALESCE(tags, '{}'), 'project:global')
WHERE NOT EXISTS (
  SELECT 1
  FROM unnest(COALESCE(tags, '{}')) AS t
  WHERE t LIKE 'project:%'
);
