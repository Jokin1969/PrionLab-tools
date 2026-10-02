-- ──────────────────────────────────────────────────────────────────────────────
-- Trigram indexes to speed up the main article listing's free-text search.
--
-- /api/articles' `q` filter has always combined a full-text (GIN,
-- indexed) match with ILIKE '%...%' substring matches against
-- title/authors/abstract (kept alongside FTS because FTS's stemmed
-- tokens miss partial-word/substring queries). Those ILIKE conditions
-- had no supporting index — Postgres cannot use a plain btree for a
-- leading-wildcard pattern — so ANY search that took the ILIKE branch
-- (which is every search, since it's OR'd with the FTS branch) forced
-- a sequential scan over the whole `articles` table just to evaluate
-- that branch, even when the FTS side alone would have been enough to
-- narrow things down. This is very likely the main reason the general
-- listing search is visibly slower than e.g. the Journal Club modal's
-- search, which just filters an already-small, already-loaded
-- client-side array — apples to oranges, but the seq scan here is the
-- part actually within our control.
--
-- pg_trgm's GIN indexes support ILIKE '%term%' natively, and Postgres
-- can combine multiple GIN/trigram index scans for OR'd conditions via
-- a BitmapOr plan node — so a query like
--   search_vector @@ ... OR title ILIKE ... OR authors ILIKE ... OR abstract ILIKE ...
-- can now be answered by unioning several fast index scans instead of
-- reading every row. `authors` was excluded from the plain btree
-- index in 034 (values can exceed btree's row-size limit) but trigram
-- GIN indexes don't have that limitation — they index token n-grams,
-- not whole values — so it's included here.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS articles_title_trgm_idx
  ON articles USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS articles_authors_trgm_idx
  ON articles USING GIN (authors gin_trgm_ops);

CREATE INDEX IF NOT EXISTS articles_abstract_trgm_idx
  ON articles USING GIN (abstract gin_trgm_ops);

COMMIT;
