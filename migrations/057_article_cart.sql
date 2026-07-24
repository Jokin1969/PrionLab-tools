-- ──────────────────────────────────────────────────────────────────────────────
-- Server-side PrionPacks cart (one per user).
--
-- The cart used to move articles from PrionVault to PrionPacks lived in the
-- browser's localStorage, so it was per-device and not tied to the account.
-- It's an admin task and the admin switches devices, so we persist it in the
-- DB keyed by user_id. Each row is one article in that user's cart; `data`
-- holds the display snapshot (title, authors, year, journal, doi, pmid,
-- has_pdf) so the cart panel renders without re-querying the article.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_cart (
    user_id     UUID        NOT NULL,
    article_id  UUID        NOT NULL,
    data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS prionvault_cart_user_created
    ON prionvault_cart (user_id, created_at DESC);

COMMIT;
