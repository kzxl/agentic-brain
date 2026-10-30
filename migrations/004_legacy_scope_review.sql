-- 004_legacy_scope_review.sql
-- Migration 003 tagged every unscoped legacy record as project:global.
-- Sampling showed those records are overwhelmingly ERP/MDS/MOP-specific.
-- Keep only explicit seeds global; assign the rest to the ERP umbrella and
-- flag them for review instead of silently exposing them to every project.

UPDATE agent_qa_cache
SET tags = ARRAY(
  SELECT DISTINCT t
  FROM unnest(
    array_remove(COALESCE(tags, '{}'), 'project:global')
    || ARRAY['project:erp', 'project-review:assumed-erp']
  ) AS t
)
WHERE 'project:global' = ANY(tags)
  AND source <> 'seed';
