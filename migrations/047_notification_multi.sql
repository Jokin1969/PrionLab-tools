-- ─────────────────────────────────────────────────────────────────────────────
-- Allow multiple notification subscriptions per user.
--
-- Changes vs 046:
--   • DROP the UNIQUE(user_id) constraint → multiple subs per user allowed.
--   • ADD name            – human label for the subscription card in the UI.
--   • ADD source          – 'pubmed' (existing behaviour) or 'flagged'
--                           (PrionVault Picks: send random flagged articles).
--   • ADD articles_per_email – how many flagged articles to include per email
--                               (only used when source = 'flagged').
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prionvault_notification_subscriptions
    DROP CONSTRAINT IF EXISTS prionvault_notification_subscriptions_user_id_key;

ALTER TABLE prionvault_notification_subscriptions
    ADD COLUMN IF NOT EXISTS name
        TEXT NOT NULL DEFAULT 'Mi suscripción',
    ADD COLUMN IF NOT EXISTS source
        TEXT NOT NULL DEFAULT 'pubmed',
    ADD COLUMN IF NOT EXISTS articles_per_email
        SMALLINT NOT NULL DEFAULT 5;

-- Add CHECK constraints separately so they are idempotent-safe on re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'pv_notif_subs_source_check'
    ) THEN
        ALTER TABLE prionvault_notification_subscriptions
            ADD CONSTRAINT pv_notif_subs_source_check
            CHECK (source IN ('pubmed','flagged'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'pv_notif_subs_ape_check'
    ) THEN
        ALTER TABLE prionvault_notification_subscriptions
            ADD CONSTRAINT pv_notif_subs_ape_check
            CHECK (articles_per_email BETWEEN 1 AND 50);
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS pv_notif_subs_user_idx
    ON prionvault_notification_subscriptions (user_id);

COMMIT;
