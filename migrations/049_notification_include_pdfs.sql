BEGIN;
ALTER TABLE prionvault_notification_subscriptions
    ADD COLUMN IF NOT EXISTS include_pdfs BOOLEAN NOT NULL DEFAULT TRUE;
COMMIT;
