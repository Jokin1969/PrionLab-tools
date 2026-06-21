-- ──────────────────────────────────────────────────────────────────────────────
-- PrionVault — chunk-level full-text search (Phase 6 hybrid retrieval)
--
-- Adds a tsvector column + GIN index to `article_chunk`, fed by a trigger
-- on chunk_text so writes from the indexer don't have to know about it.
--
-- The retriever uses this to run a BM25-style lexical search in parallel
-- with the existing pgvector cosine search, then fuses the two rankings
-- with Reciprocal Rank Fusion. Exact-token queries (PrPSc, GFAP, 14-3-3)
-- recover the precision they sometimes lose under pure semantic search.
--
-- Idempotent: safe to run multiple times.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE article_chunk
  ADD COLUMN IF NOT EXISTS chunk_search_vector tsvector;

CREATE OR REPLACE FUNCTION article_chunk_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.chunk_search_vector := to_tsvector('simple', coalesce(NEW.chunk_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS article_chunk_search_vector_trg ON article_chunk;
CREATE TRIGGER article_chunk_search_vector_trg
  BEFORE INSERT OR UPDATE OF chunk_text ON article_chunk
  FOR EACH ROW EXECUTE FUNCTION article_chunk_search_vector_update();

-- Backfill: re-set chunk_text on existing rows so the trigger fires.
-- No-op for new tables; cheap even on large chunk pools.
UPDATE article_chunk SET chunk_text = chunk_text
  WHERE chunk_search_vector IS NULL;

CREATE INDEX IF NOT EXISTS article_chunk_search_idx
  ON article_chunk USING GIN (chunk_search_vector);

COMMIT;
