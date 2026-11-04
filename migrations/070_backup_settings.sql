-- ──────────────────────────────────────────────────────────────────────────────
-- Configurable backup schedule + retention, editable from the new
-- "Backups" admin panel instead of only via env vars / hardcoded cron.
-- Single-row table (id is always TRUE) — simpler than a key-value store
-- for a handful of settings that are always read/written together.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS backup_settings (
    id             BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),
    frequency      TEXT        NOT NULL DEFAULT 'weekly',   -- 'daily' | 'weekly' | 'monthly'
    day_of_week    TEXT        NOT NULL DEFAULT 'sun',      -- used when frequency = 'weekly'
    day_of_month   INTEGER     NOT NULL DEFAULT 1,          -- used when frequency = 'monthly'
    hour_utc       INTEGER     NOT NULL DEFAULT 3,
    retain_count   INTEGER     NOT NULL DEFAULT 12,         -- how many recent backups to keep
    retain_monthly INTEGER     NOT NULL DEFAULT 24,         -- + 1 per month for this many months
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO backup_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

COMMIT;
