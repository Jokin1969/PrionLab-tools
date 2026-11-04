-- ──────────────────────────────────────────────────────────────────────────────
-- Library chat — the "AI search" modal reborn as a persistent, memory-capable
-- chat. Distinct from prionvault_article_chat (scoped to one article): this
-- one spans the whole library, mixes PrionVault's own knowledge (retrieved via
-- the same hybrid vector+BM25 pipeline used by rag.py) with the model's
-- general knowledge, and is itself searchable — messages get embedded the
-- same way article chunks do, so past conversations surface in the same
-- hybrid search.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_library_chat (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_provider  TEXT NOT NULL DEFAULT 'anthropic',
    title               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pv_library_chat_user_idx
  ON prionvault_library_chat (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS prionvault_library_chat_message (
    id             BIGSERIAL PRIMARY KEY,
    chat_id        UUID NOT NULL REFERENCES prionvault_library_chat(id) ON DELETE CASCADE,
    role           TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content        TEXT NOT NULL,
    provider       TEXT,
    model          TEXT,
    tokens_in      INTEGER,
    tokens_out     INTEGER,
    cost_usd       NUMERIC(10, 5),
    fallback       JSONB,
    -- Articles the answer actually drew PrionVault context from (subset of
    -- what was retrieved) — the UI renders these as reference chips, same
    -- idea as rag.py's citations but persisted per message.
    cited_article_ids UUID[],
    -- Same embedding setup as article_chunk (voyage-4-large, 1024-dim,
    -- HNSW cosine) so "search my past conversations" reuses the exact
    -- retrieval machinery already built for articles, just pointed at a
    -- different table.
    embedding      vector(1024),
    search_vector  tsvector,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pv_library_chat_msg_chat_idx
  ON prionvault_library_chat_message (chat_id, created_at);

CREATE INDEX IF NOT EXISTS pv_library_chat_msg_embedding_idx
  ON prionvault_library_chat_message USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS pv_library_chat_msg_search_idx
  ON prionvault_library_chat_message USING GIN (search_vector);

CREATE OR REPLACE FUNCTION pv_library_chat_message_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pv_library_chat_message_search_vector_trg ON prionvault_library_chat_message;
CREATE TRIGGER pv_library_chat_message_search_vector_trg
  BEFORE INSERT OR UPDATE OF content ON prionvault_library_chat_message
  FOR EACH ROW EXECUTE FUNCTION pv_library_chat_message_search_vector_update();

COMMIT;
