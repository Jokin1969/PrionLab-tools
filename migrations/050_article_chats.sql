-- ──────────────────────────────────────────────────────────────────────────────
-- Per-article AI chat conversations.
--
-- A user can hold multiple conversations about a single article. Each
-- conversation ("chat") is a thread of alternating user/assistant
-- messages. The assistant messages record which provider actually
-- answered (may differ from the requested provider when the fallback
-- chain Claude → GPT → Gemini kicked in) plus token/cost accounting.
--
-- Conversations are deliberately kept forever: they are a research
-- asset the lab may mine later, so there is no auto-expiry.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_article_chat (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id         UUID        NOT NULL
                                     REFERENCES articles(id) ON DELETE CASCADE,
    user_id            UUID        NOT NULL
                                     REFERENCES users(id) ON DELETE CASCADE,
    -- The provider the user picked when starting the thread. Individual
    -- answers may have been served by a fallback provider (see the
    -- message-level `provider` column).
    requested_provider TEXT        NOT NULL DEFAULT 'anthropic',
    title              TEXT,           -- derived from the first question
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pv_article_chat_lookup_idx
    ON prionvault_article_chat (article_id, user_id, updated_at DESC);


CREATE TABLE IF NOT EXISTS prionvault_article_chat_message (
    id           BIGSERIAL   PRIMARY KEY,
    chat_id      UUID        NOT NULL
                               REFERENCES prionvault_article_chat(id) ON DELETE CASCADE,
    role         TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
    content      TEXT        NOT NULL,
    -- For assistant messages: the provider that actually produced this
    -- answer, plus the model id and token/cost accounting. NULL for
    -- user messages.
    provider     TEXT,
    model        TEXT,
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    cost_usd     NUMERIC(10, 5),
    -- JSON list of fallback attempts, e.g.
    --   [{"provider":"anthropic","kind":"rate_limit","reason":"..."}]
    -- empty/NULL when the requested provider answered on the first try.
    fallback     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pv_article_chat_msg_thread_idx
    ON prionvault_article_chat_message (chat_id, created_at);

COMMIT;
