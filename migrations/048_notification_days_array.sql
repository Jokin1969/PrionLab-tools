-- ─────────────────────────────────────────────────────────────────────────────
-- Replace single day_of_week with days_of_week integer[] so users can pick
-- multiple days (e.g. Mon/Wed/Fri).
--
-- Migration is safe to re-run: all steps use IF EXISTS / IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prionvault_notification_subscriptions
    ADD COLUMN IF NOT EXISTS days_of_week INTEGER[] NOT NULL DEFAULT '{4}';

-- Migrate existing single-day values into the new array column, but only for
-- rows that still have the default placeholder {4} (i.e. not yet migrated).
UPDATE prionvault_notification_subscriptions
   SET days_of_week = ARRAY[day_of_week]
 WHERE days_of_week = '{4}'
   AND day_of_week IS NOT NULL
   AND day_of_week <> 4;

-- Keep day_of_week for now so a rollback is possible; scheduler now uses
-- days_of_week exclusively.  We can drop it in a later migration.

COMMIT;
