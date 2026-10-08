-- ──────────────────────────────────────────────────────────────────────────────
-- Per-user PrionVault email digest subscriptions.
--
-- Each user can have at most one subscription row (UNIQUE on user_id).
-- The scheduler queries `enabled = TRUE` rows whose next fire time has
-- passed, sends the digest, then bumps `last_sent_at`.
--
-- `topics` is a JSONB array of preset keys from PRESET_QUERIES in
-- pubmed_inventory.py (e.g. ["prion","aav"]).
--
-- `frequency`: 'weekly' | 'biweekly' | 'monthly'
-- `day_of_week`: 0 = Monday … 6 = Sunday
-- `send_hour` / `send_minute`: local time expressed in `user_timezone`
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_notification_subscriptions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL
                                  REFERENCES users(id) ON DELETE CASCADE,
    enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
    email           TEXT        NOT NULL,
    topics          JSONB       NOT NULL DEFAULT '["prion"]',
    frequency       TEXT        NOT NULL DEFAULT 'weekly'
                                  CHECK (frequency IN ('weekly','biweekly','monthly')),
    day_of_week     SMALLINT    NOT NULL DEFAULT 4    -- 0=Mon … 6=Sun
                                  CHECK (day_of_week BETWEEN 0 AND 6),
    send_hour       SMALLINT    NOT NULL DEFAULT 15
                                  CHECK (send_hour BETWEEN 0 AND 23),
    send_minute     SMALLINT    NOT NULL DEFAULT 0
                                  CHECK (send_minute BETWEEN 0 AND 59),
    user_timezone   TEXT        NOT NULL DEFAULT 'UTC',
    lookback_days   SMALLINT    NOT NULL DEFAULT 7
                                  CHECK (lookback_days IN (7,14,30)),
    include_oa_only BOOLEAN     NOT NULL DEFAULT FALSE,
    last_sent_at    TIMESTAMPTZ,
    next_send_at    TIMESTAMPTZ,   -- pre-computed by scheduler after each send
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id)
);

-- Fast lookup for the scheduler: only enabled rows due to fire.
CREATE INDEX IF NOT EXISTS pv_notif_subs_due_idx
    ON prionvault_notification_subscriptions (next_send_at)
    WHERE enabled = TRUE;

COMMIT;
