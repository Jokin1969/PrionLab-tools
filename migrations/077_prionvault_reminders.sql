-- ──────────────────────────────────────────────────────────────────────────────
-- "Recordatorios" — one-time (not recurring) email reminders, distinct from
-- the recurring PrionVault Picks digest (prionvault_notification_subscriptions).
-- One row = one scheduled send at a specific date/time, optionally attaching
-- one JC (Journal Club) presentation file. Sending it clears the article's
-- purple-book `is_jc` mark as a side effect (see services/reminders.py), so
-- the same presentation never gets nagged about twice.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_reminder (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    to_email     TEXT NOT NULL,
    subject      TEXT NOT NULL DEFAULT '',
    message      TEXT NOT NULL DEFAULT '',
    article_id   UUID REFERENCES articles(id) ON DELETE SET NULL,
    jc_file_id   UUID REFERENCES prionvault_jc_file(id) ON DELETE SET NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    sent_at      TIMESTAMPTZ,
    error_msg    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pv_reminder_pending_idx
  ON prionvault_reminder (scheduled_at) WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS pv_reminder_created_by_idx
  ON prionvault_reminder (created_by);

COMMIT;
