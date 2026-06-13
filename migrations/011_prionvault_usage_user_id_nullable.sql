-- ──────────────────────────────────────────────────────────────────────────────
-- Make prionvault_usage.user_id nullable.
--
-- The column is a NOT NULL FK to users.id, which means every code path
-- that inserts into prionvault_usage has to know who the viewer is
-- BEFORE it can write the row. In practice the viewer can be:
--   - a logged-in admin whose session has user_id            → fine
--   - a logged-in admin whose session lacks user_id (the CSV
--     fallback path, or a session opened before the auth fix)
--     and the auto-provision in core.auth._lookup_db_user_id
--     could not run for some reason                          → NOT fine,
--     the INSERT explodes with NotNullViolation and bubbles
--     all the way up, killing the surrounding flow (summary
--     generation, batch extract, OCR, …) even though all the
--     actual work succeeded.
--
-- The usage row is purely a cost-tracking aid; it should never be the
-- reason the main work fails. Relax the constraint so we can keep the
-- row anonymous when we genuinely can't pin it to a user.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prionvault_usage
    ALTER COLUMN user_id DROP NOT NULL;

COMMIT;
