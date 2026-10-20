-- ──────────────────────────────────────────────────────────────────────────────
-- Promote articles.title and articles.journal from VARCHAR(255) to TEXT.
--
-- Migration 022 tried this but failed in production with
--   "cannot alter type of a column used in a trigger definition"
-- because `articles_search_vector_trg` lists `title` and `journal` in its
-- column-update list. PostgreSQL forbids ALTER COLUMN TYPE when a trigger
-- declares a dependency on the column even if it would still be valid
-- after the change.
--
-- This migration drops the trigger, alters the columns to TEXT, and
-- recreates the trigger with the exact same definition. The function
-- body (articles_search_vector_update) is not touched, so the FTS
-- behaviour stays identical.
--
-- Idempotent: each ALTER COLUMN is wrapped in a DO block that gates on
-- information_schema.columns.data_type, so re-running this on a DB
-- where the promotion already happened is a no-op.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Drop the trigger that blocks ALTER COLUMN TYPE.
DROP TRIGGER IF EXISTS articles_search_vector_trg ON articles;

-- 2) Promote the columns (idempotent — only fires if still VARCHAR).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'articles' AND column_name = 'title'
       AND data_type   = 'character varying'
  ) THEN
    ALTER TABLE articles ALTER COLUMN title TYPE TEXT;
    RAISE NOTICE 'articles.title promoted from VARCHAR to TEXT';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'articles' AND column_name = 'journal'
       AND data_type   = 'character varying'
  ) THEN
    ALTER TABLE articles ALTER COLUMN journal TYPE TEXT;
    RAISE NOTICE 'articles.journal promoted from VARCHAR to TEXT';
  END IF;
END $$;

-- 3) Recreate the trigger exactly as it was (the function definition
-- is preserved across DROP TRIGGER, so we just re-attach it).
CREATE TRIGGER articles_search_vector_trg
  BEFORE INSERT OR UPDATE OF title, abstract, summary_ai, summary_human,
                             authors, journal, extracted_text
  ON articles
  FOR EACH ROW EXECUTE FUNCTION articles_search_vector_update();

COMMIT;
