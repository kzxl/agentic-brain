-- 005_question_hash_not_global_unique.sql
-- Phase 0 has no project_id column yet, so a global UNIQUE(question_hash)
-- prevents the same question from existing in two projects. Application-level
-- dedup in core/knowledge.js is already project-scoped.
-- Phase 1 will replace this with UNIQUE(project_id, question_hash).

DROP INDEX IF EXISTS idx_qa_unique_question;

CREATE INDEX IF NOT EXISTS idx_qa_question_hash
  ON agent_qa_cache(question_hash);
