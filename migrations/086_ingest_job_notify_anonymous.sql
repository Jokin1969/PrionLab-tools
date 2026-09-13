-- Browser extension "add article" flow, reader-key path: the reader's
-- identity is deliberately not tracked (kept simple for every user),
-- but the admin still gets a final outcome email once processing
-- finishes. notify_anonymous flags the job so the worker phrases that
-- email in the third person ("un usuario ha añadido...") and treats
-- notify_email as an admin recipient list instead of a reply to the
-- person who submitted it.
ALTER TABLE prionvault_ingest_job
    ADD COLUMN IF NOT EXISTS notify_anonymous BOOLEAN NOT NULL DEFAULT FALSE;
