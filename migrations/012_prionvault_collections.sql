-- ──────────────────────────────────────────────────────────────────────────────
-- PrionVault Collections — named groups of articles.
--
-- A collection is the user's own taxonomy on top of the
-- system-defined marks (priority, color label, flag, milestone). It
-- is meant for workflow groupings ("Para manuscrito X", "Lectura
-- pendiente", "Citas grant 2026", …) and as an input to PrionPacks.
--
-- Two flavours:
--   - kind = 'manual'  → membership stored in
--     prionvault_collection_article (a paper is in the collection
--     until the user removes it).
--   - kind = 'smart'   → membership is computed live from `rules`
--     (a JSON object with the same filter shape the list endpoint
--     already accepts). No rows in the link table.
--
-- The schema accommodates both from day one so smart collections
-- can land in a follow-up without another migration.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_collection (
    id           UUID         PRIMARY KEY,
    name         TEXT         NOT NULL,
    description  TEXT,
    kind         VARCHAR(20)  NOT NULL DEFAULT 'manual'
                              CHECK (kind IN ('manual', 'smart')),
    rules        JSONB        DEFAULT '{}'::jsonb,
    color        VARCHAR(7),
    created_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- name UNIQUE (case-insensitive) so the sidebar list is predictable.
CREATE UNIQUE INDEX IF NOT EXISTS prionvault_collection_name_uniq
    ON prionvault_collection (lower(name));

CREATE INDEX IF NOT EXISTS prionvault_collection_kind_idx
    ON prionvault_collection (kind);

CREATE TABLE IF NOT EXISTS prionvault_collection_article (
    collection_id UUID         NOT NULL
                  REFERENCES prionvault_collection(id) ON DELETE CASCADE,
    article_id    UUID         NOT NULL
                  REFERENCES articles(id) ON DELETE CASCADE,
    added_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    added_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
    note          TEXT,
    PRIMARY KEY (collection_id, article_id)
);

CREATE INDEX IF NOT EXISTS prionvault_collection_article_article_idx
    ON prionvault_collection_article (article_id);

COMMIT;
