-- ──────────────────────────────────────────────────────────────────────────────
-- SCImago (SJR) journal quartile rankings.
--
-- Imported from the yearly SCImago CSV (scimagojr.com, freely downloadable).
-- One row per (normalized journal title, year). `best_quartile` /
-- `best_category` are precomputed from the per-category quartiles so the
-- Gobierno Vasco export can fill "Cuartil: Q1 (Category)" automatically.
--
-- Matching is by normalized journal title because PrionVault does not
-- store ISSNs; the raw ISSNs are kept in `issns` for future use.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS journal_ranking (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    title_norm     TEXT        NOT NULL,        -- normalized journal title (match key)
    title          TEXT,                        -- original SCImago title
    issns          JSONB,                       -- ["15320456","00278424"]
    year           INTEGER     NOT NULL,
    best_quartile  TEXT,                         -- 'Q1'..'Q4'
    best_category  TEXT,                         -- category behind best_quartile
    categories     JSONB,                        -- [{"category":...,"quartile":"Q1"}, ...]
    sjr            TEXT,                          -- SJR value (as printed)
    source         TEXT        NOT NULL DEFAULT 'scimago',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (title_norm, year)
);

CREATE INDEX IF NOT EXISTS journal_ranking_title_idx
    ON journal_ranking (title_norm);

COMMIT;
