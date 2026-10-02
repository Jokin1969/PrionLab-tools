-- ──────────────────────────────────────────────────────────────────────────────
-- Allow the same physical Journal Club document to be attached to more
-- than one article's presentation.
--
-- Migration 014 made dropbox_path globally UNIQUE across every JC file
-- row, on the assumption that one document = one presentation. In
-- practice a single JC session sometimes covers several articles from
-- the same slide deck — the document is genuinely the same file, just
-- associated with multiple articles. That produced
--   psycopg2.errors.UniqueViolation: duplicate key value violates
--   unique constraint "prionvault_jc_file_path_uniq"
-- The uniqueness now applies per (presentation_id, dropbox_path)
-- instead: still blocks attaching the exact same file twice to the
-- SAME presentation, but lets different presentations share one file.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP INDEX IF EXISTS prionvault_jc_file_path_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS prionvault_jc_file_pres_path_uniq
    ON prionvault_jc_file (presentation_id, dropbox_path);

COMMIT;
