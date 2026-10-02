-- ──────────────────────────────────────────────────────────────────────────────
-- Recreate prionvault_ingest_job if it is missing.
--
-- Migration 001 created this table, but it no longer exists in the live
-- schema (it was likely dropped as collateral damage during an early,
-- since-fixed backup-restore attempt). Every ingest-queue operation
-- (enqueue, worker claim, "Limpiar terminados", per-job delete) was
-- failing with `UndefinedTable: relation "prionvault_ingest_job" does
-- not exist`. Recreate it with the full schema, including the columns
-- added later by migrations 003 (step widened to TEXT), 020
-- (source_dropbox_path) and 032 (notify_email / notify_subject).
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_ingest_job (
  id                   BIGSERIAL     PRIMARY KEY,
  article_id           UUID REFERENCES articles(id) ON DELETE SET NULL,
  pdf_filename         TEXT,
  pdf_md5              CHAR(32),
  status               VARCHAR(20)   NOT NULL DEFAULT 'queued',
                                     -- queued | uploading | extracting | resolving
                                     -- | indexing | done | failed | duplicate
  step                 TEXT,
  error                TEXT,
  attempts             INTEGER       NOT NULL DEFAULT 0,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  source_dropbox_path  TEXT,
  notify_email         TEXT,
  notify_subject       TEXT,
  created_at           TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
  started_at           TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS prionvault_ingest_job_status_idx
  ON prionvault_ingest_job (status, created_at);

COMMIT;
