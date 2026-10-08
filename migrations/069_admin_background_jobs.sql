-- ──────────────────────────────────────────────────────────────────────────────
-- Background job tracking for long-running admin operations (e.g. the
-- emergency database restore). Railway runs multiple app workers, so an
-- in-process/in-memory job registry is invisible to whichever worker
-- handles a later status-poll request. Persisting to the shared Postgres
-- database instead makes job status visible regardless of which worker
-- picks up the request.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS admin_background_job (
    id            TEXT        PRIMARY KEY,
    kind          TEXT        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'running',
    stage         TEXT,
    filename      TEXT,
    downloaded_mb NUMERIC,
    result        JSONB,
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_background_job_started_idx
    ON admin_background_job (started_at);

COMMIT;
