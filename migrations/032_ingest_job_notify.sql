-- ──────────────────────────────────────────────────────────────────────────────
-- Track who to email-notify when an ingest job reaches a terminal state.
--
-- Jobs created by the email-ingest daemon (services/email_ingest.py)
-- populate these columns so the worker can reply to the original sender
-- once the article is in the catalogue — with resolved metadata
-- (title / DOI / authors / link to PrionVault) and the original PDF
-- attached. Hand-uploaded, Dropbox-watch and DOI-add jobs leave both
-- columns NULL, suppressing the reply entirely.
--
-- Both are nullable plain text, indexless: the daemon writes them once
-- and the worker reads them once, so an index would just be dead weight.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prionvault_ingest_job
  ADD COLUMN IF NOT EXISTS notify_email   TEXT,
  ADD COLUMN IF NOT EXISTS notify_subject TEXT;

COMMIT;
