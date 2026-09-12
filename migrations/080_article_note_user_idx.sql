-- The "📝 Con notas" filter (has_summary=human) queries
-- prionvault_article_note filtered by the viewer's user id — but the
-- only index on this table starts with article_id (migration 052's
-- pv_article_note_lookup_idx), which can't accelerate a user_id-only
-- lookup. A dedicated (user_id, article_id) index lets that query (and
-- the sidebar/head "con notas" counters) resolve as an index-only scan
-- instead of a sequential scan of the whole table.

BEGIN;

CREATE INDEX IF NOT EXISTS pv_article_note_user_idx
  ON prionvault_article_note (user_id, article_id);

-- /api/articles/stats (the sidebar/head facet counters, incl. the
-- notes badge) runs on every page load and does
-- `summary_ai NOT ILIKE '%OBJETIVOS%'` over every row with a summary —
-- a leading-wildcard ILIKE that a plain btree can't accelerate, so it
-- forced a sequential scan/full-text comparison over the whole
-- articles table on every call. Same fix family as
-- 075_articles_trgm_search_indexes.sql, just for the one column that
-- migration didn't cover (summary_ai wasn't part of free-text search
-- at the time).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS articles_summary_ai_trgm_idx
  ON articles USING GIN (summary_ai gin_trgm_ops);

COMMIT;
