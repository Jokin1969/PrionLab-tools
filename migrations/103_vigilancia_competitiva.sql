-- "Vigilancia competitiva" (ISO 56001 competitive-surveillance report):
-- one row per year (historical reports digested from the lab's .docx, and
-- the current year's draft), plus every reference each report cites and
-- the PrionVault article it was resolved to. The articles themselves are
-- grouped in the collections "VC <year>" (group "Vigilancia competitiva").
CREATE TABLE IF NOT EXISTS prionvault_vc_report (
  year        INT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  authors     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',          -- paragraphs separated by blank lines
  status      TEXT NOT NULL DEFAULT 'historical', -- historical | draft | final
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prionvault_vc_ref (
  id          BIGSERIAL PRIMARY KEY,
  year        INT NOT NULL,
  ref_key     TEXT NOT NULL,                     -- stable key within the year
  cite        TEXT NOT NULL DEFAULT '',          -- as written in the report
  doi         TEXT,
  pmid        TEXT,
  context     TEXT NOT NULL DEFAULT '',          -- sentence citing it (author-year refs)
  article_id  UUID,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | linked | created | ambiguous | not_found | error
  note        TEXT NOT NULL DEFAULT '',
  candidates  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year, ref_key)
);
CREATE INDEX IF NOT EXISTS prionvault_vc_ref_article_idx ON prionvault_vc_ref (article_id);
