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

ALTER TABLE prionvault_ingest_job
  ALTER COLUMN step TYPE TEXT;

COMMIT;
