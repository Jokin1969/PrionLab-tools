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

ALTER TABLE prionvault_ingest_job
  ADD COLUMN IF NOT EXISTS source_dropbox_path TEXT;

COMMIT;
