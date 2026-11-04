-- ──────────────────────────────────────────────────────────────────────────────
-- Per-user sticky notes on an article (PrionVault).
--
-- Inspired by the PrionPack notes panel, but with a fixed model:
--   * up to 5 notes per (article, user)
--   * the colour is NOT chosen — it is derived from `color_index`:
--       0 = amarilla, 1 = azul, 2 = verde, 3 = morada, 4 = naranja
--   * a new note takes the lowest free colour slot; deleting a note frees
--     its slot so the grey "add" affordance reappears.
--
-- The UNIQUE(article_id, user_id, color_index) constraint enforces both
-- the 5-note cap (indices 0-4) and one-colour-per-slot atomically.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_article_note (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id   UUID        NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    color_index  SMALLINT    NOT NULL CHECK (color_index BETWEEN 0 AND 4),
    body         TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (article_id, user_id, color_index)
);

CREATE INDEX IF NOT EXISTS pv_article_note_lookup_idx
    ON prionvault_article_note (article_id, user_id, color_index);

COMMIT;
