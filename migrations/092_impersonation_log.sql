-- Audit trail for "Ver como" (admin impersonating another user's full
-- session, to see exactly what their role/permissions show them). Not
-- PrionVault-specific — this is an app-wide admin tool — so it picks up
-- the generic migration runner (database/config.py's db.run_migrations(),
-- called automatically on app startup) rather than PrionVault's separate
-- allow-listed one.
CREATE TABLE IF NOT EXISTS impersonation_log (
    id               SERIAL      PRIMARY KEY,
    admin_username   TEXT        NOT NULL,
    target_username  TEXT        NOT NULL,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_impersonation_log_admin
    ON impersonation_log (admin_username, started_at DESC);
