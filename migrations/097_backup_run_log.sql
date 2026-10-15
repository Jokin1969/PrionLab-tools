-- One row per database backup attempt (scheduled, manual or catch-up),
-- so the Backups panel can show whether backups are actually happening
-- and succeeding, and alerts can fire when they don't.
CREATE TABLE IF NOT EXISTS backup_run (
    id             BIGSERIAL PRIMARY KEY,
    trigger        TEXT        NOT NULL,              -- scheduled | manual | catchup
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at    TIMESTAMPTZ,
    status         TEXT        NOT NULL DEFAULT 'running',  -- running | success | partial | failed | skipped
    filename       TEXT,
    size_mb        NUMERIC,
    dropbox_path   TEXT,
    dropbox_error  TEXT,
    error          TEXT,
    warning        TEXT,
    worker_pid     INTEGER
);

CREATE INDEX IF NOT EXISTS backup_run_started_idx ON backup_run (started_at DESC);
