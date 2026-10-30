-- ──────────────────────────────────────────────────────────────────────────────
-- Allow manual journal entries to carry a year and coexist with the
-- SCImago row for the same (title, year): the uniqueness key now includes
-- `source`. A manual entry (source='manual') can be atemporal (year=0) or
-- year-specific, and takes priority over SCImago in lookups.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Drop the old (title_norm, year) unique constraint (default name from the
-- inline UNIQUE in migration 053).
ALTER TABLE journal_ranking
    DROP CONSTRAINT IF EXISTS journal_ranking_title_norm_year_key;

-- New uniqueness: one row per (title, year, source).
CREATE UNIQUE INDEX IF NOT EXISTS journal_ranking_tns_uniq
    ON journal_ranking (title_norm, year, source);

COMMIT;
