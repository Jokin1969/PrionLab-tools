-- Second email-ingest mailbox for non-admin users (prionvault_lab@...):
-- unlike the admin mailbox, its outcome replies also go out BCC to
-- every admin, so the admin can see who used it and how each
-- submission resolved without the sender knowing they're copied.
-- Stored on the job row (comma-separated addresses) so the worker's
-- final notify — which fires later, from a different process/request
-- than the one that enqueued the job — still knows who to BCC.
ALTER TABLE prionvault_ingest_job
    ADD COLUMN IF NOT EXISTS notify_bcc TEXT;
