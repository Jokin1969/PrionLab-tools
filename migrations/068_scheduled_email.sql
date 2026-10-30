-- ──────────────────────────────────────────────────────────────────────────────
-- Scheduled email shares — send articles by email at a specific time.
--
-- When a user programs an email share with a scheduled_at datetime, a row
-- is created here. The APScheduler job checks every minute for any rows with
-- scheduled_at in the past and sends the email, then marks it as sent.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_scheduled_email (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id   UUID        NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    to_email     TEXT        NOT NULL,
    sender_name  TEXT        NOT NULL DEFAULT '',
    include_summary BOOLEAN  NOT NULL DEFAULT true,
    comment      TEXT        NOT NULL DEFAULT '',
    scheduled_at TIMESTAMPTZ NOT NULL,
    sent_at      TIMESTAMPTZ,
    error_msg    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pv_scheduled_email_to_send_idx
    ON prionvault_scheduled_email (scheduled_at)
    WHERE sent_at IS NULL;

COMMIT;
