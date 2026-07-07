-- ──────────────────────────────────────────────────────────────────────────────
-- Per-user "Journal Club" mark on an article, alongside is_favorite and
-- read_at. Lets a user flag articles they want for a Journal Club, and
-- filter by it — exactly like favourites / read.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prionvault_user_state
    ADD COLUMN IF NOT EXISTS is_jc BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS pv_user_state_jc_idx
    ON prionvault_user_state (user_id) WHERE is_jc IS TRUE;

COMMIT;
