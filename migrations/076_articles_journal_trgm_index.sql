-- Trigram index for the "R" (Revista/journal) search-field button added
-- alongside title/authors/abstract in 075 — journal ILIKE search was
-- missing its own index, so restricting a search to R alone forced a
-- sequential scan just like the other columns did before 075.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS articles_journal_trgm_idx
  ON articles USING GIN (journal gin_trgm_ops);

COMMIT;
