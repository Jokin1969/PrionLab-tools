-- Lets an email sent to the reader-facing prionvault_lab@ mailbox ask
-- for the article to also be flagged as a Journal Club candidate, by
-- putting "JC" or "Journal Club" somewhere in the Subject line — see
-- services/email_ingest.py's JC keyword detection and
-- ingestion/worker.py's _apply_jc_flag (sets articles.is_jc once the
-- article is created or found as a duplicate).
ALTER TABLE prionvault_ingest_job
    ADD COLUMN IF NOT EXISTS notify_jc BOOLEAN NOT NULL DEFAULT FALSE;
