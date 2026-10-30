-- ──────────────────────────────────────────────────────────────────────────────
-- PrionVault migration 003: widen prionvault_ingest_job.step to TEXT
--
-- The original schema declared `step VARCHAR(40)` which is too short for the
-- verbose progress strings the worker writes (e.g.
-- "done | doi=10.1234/abc | /PrionLab tools/PrionVault/2024/...pdf").
-- PostgreSQL would raise "value too long for type character varying(40)",
-- silently aborting the job after all the hard work was already done.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Check if table exists before trying to alter it
-- (migration 001 should create it, but this ensures idempotency)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'prionvault_ingest_job'
  ) THEN
    ALTER TABLE prionvault_ingest_job
      ALTER COLUMN step TYPE TEXT;
  END IF;
END $$;

COMMIT;
