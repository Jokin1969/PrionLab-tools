-- ──────────────────────────────────────────────────────────────────────────────
-- Track the originating Dropbox path on ingest jobs so the watch-folder
-- scanner can clean up successful imports without losing track of the
-- source file.
--
-- Hand-uploaded jobs (queue.enqueue_pdf called from the regular Import
-- PDFs modal) leave the column NULL — the worker only deletes a source
-- file when a path was actually recorded.
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
      ADD COLUMN IF NOT EXISTS source_dropbox_path TEXT;
  END IF;
END $$;

COMMIT;
