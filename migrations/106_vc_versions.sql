-- VC generator: version history of the current-year draft (every AI
-- generation, AI revision requested in free text, manual edit, restore),
-- and the citation style (PMID — as in 2024/2025 — or DOI — as 2021–2023).
CREATE TABLE IF NOT EXISTS prionvault_vc_version (
  id          BIGSERIAL PRIMARY KEY,
  year        INT  NOT NULL,
  kind        TEXT NOT NULL,                 -- generated | revision | manual | restored | final
  request     TEXT NOT NULL DEFAULT '',      -- what the authors asked (revisions)
  summary     TEXT NOT NULL DEFAULT '',      -- what the AI changed
  title       TEXT NOT NULL DEFAULT '',
  authors     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  info        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- validation / fact-check
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS prionvault_vc_version_year_idx ON prionvault_vc_version (year, id);
ALTER TABLE prionvault_vc_report ADD COLUMN IF NOT EXISTS cite_style TEXT NOT NULL DEFAULT 'pmid';
