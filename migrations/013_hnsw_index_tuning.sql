-- ──────────────────────────────────────────────────────────────────────────────
-- Tune the HNSW vector index for better recall/latency at scale.
--
-- Migration 001 created the index with pgvector defaults
--     m = 12, ef_construction = 64
-- which are fine for tens of thousands of vectors but start to lose
-- recall as the table grows past ~100 k chunks. Bumping the
-- construction-time parameters costs a one-off rebuild but gives
-- us materially better quality for the next 10× of growth.
--
-- We can't ALTER the index parameters in place; the only way is to
-- DROP and CREATE, which is what we do here. The CREATE INDEX takes
-- O(n log n) and is non-blocking against SELECTs.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP INDEX IF EXISTS article_chunk_embedding_idx;

CREATE INDEX IF NOT EXISTS article_chunk_embedding_idx
    ON article_chunk
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128);

COMMIT;
