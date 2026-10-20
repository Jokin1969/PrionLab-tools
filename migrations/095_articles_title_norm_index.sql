-- Fast exact-title lookup for the PrionVault search box.
--
-- A title pasted between quotes ("...") is matched against a
-- NORMALIZED form of the title: lower-case, with every run of
-- non-alphanumeric characters (spaces, punctuation, dashes, quotes)
-- removed. That makes the match immune to spacing/punctuation
-- differences between where the title was copied from and how it is
-- stored, and lets both indexes below answer it directly instead of
-- the per-word ILIKE chain used for normal searches.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Exact (whole-title) match.
CREATE INDEX IF NOT EXISTS articles_title_norm_idx
    ON articles ((lower(regexp_replace(title, '[^[:alnum:]]+', '', 'g'))));

-- Substring match (quoted phrase that is only part of a title).
CREATE INDEX IF NOT EXISTS articles_title_norm_trgm_idx
    ON articles USING GIN ((lower(regexp_replace(title, '[^[:alnum:]]+', '', 'g'))) gin_trgm_ops);
