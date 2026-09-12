-- ──────────────────────────────────────────────────────────────────────────────
-- Per-user article selection: the multi-select checkboxes in the
-- PrionVault listing used to live exclusively in the browser
-- (state.selectedIds = new Set()), so a refresh, a deploy, or
-- opening a second browser dropped every tick the operator had
-- placed for bulk operations.
--
-- This table persists each user's currently-ticked article IDs so
-- the selection survives reloads, devices and server restarts.
-- Composite PK keeps the table denormalised and fast: typical
-- working selections are O(10²); a power-user "tick everything
-- visible" pass on a 4 k-article query is O(10³). The hottest
-- lookup is "give me every id this user has ticked", served
-- straight off the (user_id, article_id) PK without a secondary
-- index.
--
-- Cascades on both FKs: deleting a user or an article also wipes
-- their selection rows, so no orphan references survive.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_user_selection (
    user_id     UUID NOT NULL
                  REFERENCES users(id)    ON DELETE CASCADE,
    article_id  UUID NOT NULL
                  REFERENCES articles(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, article_id)
);

-- The "show me my selection on page load" hot path filters by user
-- alone. PK index covers it, but a partial index ordered by
-- created_at helps the "what did I tick most recently" view that
-- the UI may want later. Cheap to add now, expensive to add later
-- on a large table.
CREATE INDEX IF NOT EXISTS prionvault_user_selection_user_recent_idx
  ON prionvault_user_selection (user_id, created_at DESC);

COMMIT;
