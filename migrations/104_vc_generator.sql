-- Vigilancia competitiva — AI generator for the current year's report.
-- prionvault_vc_item: every candidate paper of the year with its AI scores;
-- `selected` = goes into the report (editable by the user between steps).
-- The report row (prionvault_vc_report, status 'draft') keeps the themes
-- and the pipeline log.
CREATE TABLE IF NOT EXISTS prionvault_vc_item (
  id           BIGSERIAL PRIMARY KEY,
  year         INT  NOT NULL,
  pmid         TEXT,
  doi          TEXT,
  article_id   UUID,
  title        TEXT NOT NULL DEFAULT '',
  authors      TEXT NOT NULL DEFAULT '',
  journal      TEXT NOT NULL DEFAULT '',
  pub_year     INT,
  quartile     TEXT,
  in_library   BOOLEAN NOT NULL DEFAULT FALSE,
  abstract     TEXT,
  screen_score REAL,              -- round 1 (title) 0..10
  score        REAL,              -- round 2 (abstract) 0..100
  reason       TEXT NOT NULL DEFAULT '',
  theme        TEXT,
  selected     BOOLEAN NOT NULL DEFAULT FALSE,
  manual       BOOLEAN NOT NULL DEFAULT FALSE,  -- added/toggled by the user
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS prionvault_vc_item_pmid_uniq ON prionvault_vc_item (year, pmid) WHERE pmid IS NOT NULL;
CREATE INDEX IF NOT EXISTS prionvault_vc_item_year_idx ON prionvault_vc_item (year, selected);

ALTER TABLE prionvault_vc_report ADD COLUMN IF NOT EXISTS themes   JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE prionvault_vc_report ADD COLUMN IF NOT EXISTS pipeline JSONB NOT NULL DEFAULT '{}'::jsonb;
