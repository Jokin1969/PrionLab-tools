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

ALTER TABLE articles ALTER COLUMN title         TYPE TEXT;
ALTER TABLE articles ALTER COLUMN journal       TYPE TEXT;
ALTER TABLE articles ALTER COLUMN doi           TYPE TEXT;
ALTER TABLE articles ALTER COLUMN dropbox_path  TYPE TEXT;

COMMIT;
