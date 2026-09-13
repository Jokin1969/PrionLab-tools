-- ──────────────────────────────────────────────────────────────────────────────
-- Promote variable-length text columns from VARCHAR(255) to TEXT.
--
-- Sequelize created these as STRING (= VARCHAR 255), which is fine
-- for admin-typed metadata but rejects real-world scientific titles
-- and long journal names that CrossRef / PubMed routinely return:
--
--   "Differentiation of prion protein glycoforms from naturally
--    occurring sheep scrapie, sheep-passaged scrapie strains
--    (CH1641 and SSBP1), bovine spongiform encephalopathy (BSE) …"
--
-- PrionVault's ingest worker inserts via raw SQL — there's no
-- application-side truncation, so the row crashes with
-- StringDataRightTruncation and the whole job goes to failed.
--
-- TEXT in Postgres has no length limit and the same storage profile
-- as VARCHAR for short strings, so there is no penalty for the
-- existing well-formed rows.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Drop trigger that references these columns (cannot change column type while trigger is active)
DROP TRIGGER IF EXISTS articles_search_vector_trg ON articles;

-- Promote columns to TEXT
ALTER TABLE articles ALTER COLUMN title         TYPE TEXT;
ALTER TABLE articles ALTER COLUMN journal       TYPE TEXT;
ALTER TABLE articles ALTER COLUMN doi           TYPE TEXT;
ALTER TABLE articles ALTER COLUMN dropbox_path  TYPE TEXT;

-- Recreate the trigger
CREATE OR REPLACE FUNCTION articles_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.abstract, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary_ai, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary_human, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.authors, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.journal, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.extracted_text, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER articles_search_vector_trg
  BEFORE INSERT OR UPDATE OF title, abstract, summary_ai, summary_human,
                              authors, journal, extracted_text
  ON articles
  FOR EACH ROW EXECUTE FUNCTION articles_search_vector_update();

COMMIT;
