-- ──────────────────────────────────────────────────────────────────────────────
-- Per-user article marks (phase 1: schema + backfill).
--
-- Until now, is_flagged / is_milestone / color_label / priority lived
-- on the `articles` row — meaning every user saw and modified the
-- same flag. The user reasonably wants those to be a personal
-- preference, like is_favorite already is.
--
-- This migration adds the four columns to the existing
-- `prionvault_user_state` table (same composite PK (user_id,
-- article_id)). We extend it instead of creating a new table because
-- conceptually all of these answer the question "what does THIS
-- user think of THIS article?" and grouping them keeps the per-user
-- lookup at one JOIN.
--
-- The `articles` columns are kept for now; a follow-up migration
-- will drop them once we've confirmed nothing else reads them. That
-- gives us a clean rollback path during the transition.
--
-- The actual backfill of existing marks (articles.* → the first
-- admin's prionvault_user_state row) happens in Python at app boot
-- because SQL alone can't pick "the first admin" without app
-- context. See backfill_user_marks_once() in app.py.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prionvault_user_state
  ADD COLUMN IF NOT EXISTS is_flagged    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_milestone  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS color_label   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS priority      INTEGER;

-- Hot-path indexes for the listing endpoint's per-user filters.
-- Partial indexes keep them small: most rows are unmarked.
CREATE INDEX IF NOT EXISTS prionvault_user_state_flagged_idx
  ON prionvault_user_state (user_id) WHERE is_flagged IS TRUE;
CREATE INDEX IF NOT EXISTS prionvault_user_state_milestone_idx
  ON prionvault_user_state (user_id) WHERE is_milestone IS TRUE;
CREATE INDEX IF NOT EXISTS prionvault_user_state_color_idx
  ON prionvault_user_state (user_id, color_label)
  WHERE color_label IS NOT NULL;

-- Bootstrap row: it's now perfectly valid for a user to have a
-- prionvault_user_state row with neither is_favorite nor read_at
-- set, just because they set a color_label. The defaults above
-- (FALSE / NULL) make the constraint cleanly satisfiable.

COMMIT;
