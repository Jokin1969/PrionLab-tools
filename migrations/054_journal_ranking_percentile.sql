-- ──────────────────────────────────────────────────────────────────────────────
-- Enrich journal_ranking with country, primary ISSN and computed
-- percentile / decile, so the Gobierno Vasco export can fill ISSN,
-- Publication place and a richer quality indicator (Q1 · D1 · P94.8).
--
-- Percentile / decile are computed per SCImago category at import time
-- (rank of the journal by SJR within the category). `categories` keeps
-- the per-category quartile + percentile; the best_* columns cache the
-- winning category for fast lookup.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE journal_ranking
    ADD COLUMN IF NOT EXISTS country          TEXT,
    ADD COLUMN IF NOT EXISTS primary_issn     TEXT,
    ADD COLUMN IF NOT EXISTS best_percentile  NUMERIC,
    ADD COLUMN IF NOT EXISTS best_decile      TEXT;

COMMIT;
