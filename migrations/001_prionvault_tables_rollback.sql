-- ──────────────────────────────────────────────────────────────────────────────
-- Rollback for migrations/001_prionvault_tables.sql
--
-- Use ONLY if PrionVault has not yet been deployed and you need to undo
-- the additive migration. Drops PrionVault-exclusive tables and removes
-- the columns added to `articles`. PrionRead is left intact.
--
-- ⚠ Running this after PrionVault has stored articles will lose the
-- extracted_text, summaries, chunks and tags. The PrionRead-managed data
-- (title, abstract, doi, etc.) is preserved.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Drop PrionVault-only tables.
DROP TABLE IF EXISTS prionvault_usage;
DROP TABLE IF EXISTS prionvault_ingest_job;
DROP TABLE IF EXISTS article_annotation;
DROP TABLE IF EXISTS article_tag_link;
DROP TABLE IF EXISTS article_tag;
DROP TABLE IF EXISTS article_chunk;

-- Remove the trigger and function on `articles`.
DROP TRIGGER  IF EXISTS articles_search_vector_trg ON articles;
DROP FUNCTION IF EXISTS articles_search_vector_update();

-- Drop the additive indexes.
DROP INDEX IF EXISTS articles_search_idx;
DROP INDEX IF EXISTS articles_year_idx;
DROP INDEX IF EXISTS articles_added_at_idx;
DROP INDEX IF EXISTS articles_doi_lower_idx;
DROP INDEX IF EXISTS articles_pdf_md5_uniq;

-- Remove the FK and added columns from `articles`.
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_added_by_fk;
ALTER TABLE articles
  DROP COLUMN IF EXISTS search_vector,
  DROP COLUMN IF EXISTS added_by_id,
  DROP COLUMN IF EXISTS source_metadata,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS index_version,
  DROP COLUMN IF EXISTS indexed_at,
  DROP COLUMN IF EXISTS summary_human,
  DROP COLUMN IF EXISTS summary_ai,
  DROP COLUMN IF EXISTS extraction_error,
  DROP COLUMN IF EXISTS extraction_status,
  DROP COLUMN IF EXISTS extracted_text,
  DROP COLUMN IF EXISTS pdf_pages,
  DROP COLUMN IF EXISTS pdf_size_bytes,
  DROP COLUMN IF EXISTS pdf_md5;

-- Extensions (vector / citext) are intentionally NOT dropped — they may be
-- in use by other future modules and are harmless to leave installed.

COMMIT;
