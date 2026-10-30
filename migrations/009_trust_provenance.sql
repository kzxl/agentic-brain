-- 009_trust_provenance.sql
-- Phase 2: trust levels, provenance, and temporal validity.

ALTER TABLE agent_qa_cache
  ADD COLUMN IF NOT EXISTS trust_level TEXT,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS evidence JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS verifier TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

UPDATE agent_qa_cache
SET trust_level = CASE
  WHEN source IN ('seed','teach','manual','reviewed-agent','reviewed-cloud','user') THEN 'verified_fact'
  WHEN source IN ('auto-harvest','proxy-auto','auto-qa','smart-rag') THEN 'inference'
  ELSE 'observation'
END
WHERE trust_level IS NULL;

UPDATE agent_qa_cache
SET source_type = COALESCE(source_type, source),
    evidence = COALESCE(evidence, '[]'::jsonb),
    status = COALESCE(status, 'active'),
    valid_from = COALESCE(valid_from, created_at, NOW())
WHERE source_type IS NULL
   OR evidence IS NULL
   OR status IS NULL
   OR valid_from IS NULL;

ALTER TABLE agent_qa_cache ALTER COLUMN trust_level SET DEFAULT 'observation';
ALTER TABLE agent_qa_cache ALTER COLUMN trust_level SET NOT NULL;
ALTER TABLE agent_qa_cache ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE agent_qa_cache ALTER COLUMN status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qa_trust_level
  ON agent_qa_cache(trust_level);
CREATE INDEX IF NOT EXISTS idx_qa_status
  ON agent_qa_cache(status);
CREATE INDEX IF NOT EXISTS idx_qa_valid_to
  ON agent_qa_cache(valid_to);

DO $$
BEGIN
  ALTER TABLE agent_qa_cache
    ADD CONSTRAINT chk_qa_trust_level
    CHECK (trust_level IN ('observation','hypothesis','inference','verified_fact','user_decision'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE agent_qa_cache
    ADD CONSTRAINT chk_qa_status
    CHECK (status IN ('active','stale','archived','superseded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
