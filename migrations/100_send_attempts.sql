-- Atomic claim + bounded retries for the every-minute senders (both gunicorn
-- workers run them): each attempt bumps `attempts` and `last_attempt_at`;
-- a row is retried with backoff and abandoned after 5 attempts.
ALTER TABLE prionvault_scheduled_email          ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE prionvault_scheduled_email          ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE prionvault_jc_convocation_schedule  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE prionvault_jc_convocation_schedule  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE prionvault_reminder                 ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE prionvault_reminder                 ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
