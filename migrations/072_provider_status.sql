-- ──────────────────────────────────────────────────────────────────────────────
-- Persist the "Estado IA / APIs externas" tracker to the DB.
--
-- It used to live in a plain in-process dict (services/provider_status.py).
-- On Railway the app runs several gunicorn worker processes; the actual
-- LLM/embedding calls that call record_success()/record_error() almost
-- never land on the same worker that later serves the status GET request
-- (and background/scheduler work may run in a separate process
-- altogether), so the modal showed "Sin datos" for every provider
-- essentially always, even while calls were succeeding elsewhere.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_provider_status (
  provider              TEXT        PRIMARY KEY,
  status                TEXT        NOT NULL DEFAULT 'unknown',
  last_success_at       TIMESTAMPTZ,
  last_success_action   TEXT,
  last_error_at         TIMESTAMPTZ,
  last_error            TEXT,
  last_error_kind       TEXT,
  last_error_action     TEXT,
  success_count         INTEGER     NOT NULL DEFAULT 0,
  error_count           INTEGER     NOT NULL DEFAULT 0
);

COMMIT;
