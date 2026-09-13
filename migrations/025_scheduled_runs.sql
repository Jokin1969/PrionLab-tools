-- ──────────────────────────────────────────────────────────────────────────────
-- Generic scheduler-state table for PrionVault background tasks.
--
-- The auto-scan-folder daemon (services/auto_scan.py) reads + writes
-- this on every tick to decide whether enough time has passed since
-- the last run AND to claim a lease atomically — two gunicorn workers
-- can never run the same scheduled task at the same time because the
-- UPSERT guards on last_run_at < NOW() - <interval>.
--
-- One row per scheduled job. `name` is a stable identifier
-- ("auto-scan-folder"), `payload` is JSONB so each job type can stash
-- its own counters / config snapshot for the admin status panel.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_scheduled_runs (
    name            VARCHAR(64)  PRIMARY KEY,
    last_run_at     TIMESTAMPTZ,
    last_status     VARCHAR(20),   -- 'running' | 'ok' | 'error'
    last_error      TEXT,
    last_runtime_ms INTEGER,
    payload         JSONB         DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMIT;
