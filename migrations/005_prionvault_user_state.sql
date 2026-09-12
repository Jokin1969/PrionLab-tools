-- ──────────────────────────────────────────────────────────────────────────────
-- PrionVault — per-user article state
--
-- Tracks each user's personal interaction with an article, separately from
-- PrionRead's `user_articles` (which represents an admin-curated assignment
-- to a student with a workflow status).
--
-- Use cases:
--   • is_favorite — the user starred this article in PrionVault.
--   • read_at     — the user marked this article as personally read.
--
-- A future column for personal tags or last-opened-at can be added the same way.
-- Composite PK avoids duplicates and gives us the natural lookup index.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_user_state (
    user_id     UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    is_favorite BOOLEAN     NOT NULL DEFAULT FALSE,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, article_id)
);

-- Reverse lookup: "all favourites of this user" / "all readers of this article"
CREATE INDEX IF NOT EXISTS prionvault_user_state_article_idx
    ON prionvault_user_state (article_id);

-- Partial index for the most common filter: "my favourites"
CREATE INDEX IF NOT EXISTS prionvault_user_state_favorites_idx
    ON prionvault_user_state (user_id)
    WHERE is_favorite = TRUE;

COMMIT;
