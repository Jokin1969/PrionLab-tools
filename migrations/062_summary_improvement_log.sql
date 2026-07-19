-- ──────────────────────────────────────────────────────────────────────────────
-- PrionVault — Summary Improvement Tracking
--
-- Tracks all summary improvements done with glossary context.
-- Records: which version was used, what changed, when, for audit and re-processing.
--
-- Idempotent: safe to run multiple times.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS summary_improvement_log (
  id                      BIGSERIAL  PRIMARY KEY,
  article_id              UUID       NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  glossary_version_used   INTEGER    NOT NULL,
  improved_at             TIMESTAMPTZ DEFAULT NOW(),
  original_summary        TEXT       NOT NULL,
  improved_summary        TEXT       NOT NULL,
  changes_count           INTEGER    DEFAULT 0,
  batch_id                UUID,
  dry_run                 BOOLEAN    DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_summary_improvement_log_article_id
  ON summary_improvement_log (article_id);
CREATE INDEX IF NOT EXISTS idx_summary_improvement_log_glossary_version
  ON summary_improvement_log (glossary_version_used);
CREATE INDEX IF NOT EXISTS idx_summary_improvement_log_improved_at
  ON summary_improvement_log (improved_at);
CREATE INDEX IF NOT EXISTS idx_summary_improvement_log_batch_id
  ON summary_improvement_log (batch_id);

-- Correction details: individual changes made
CREATE TABLE IF NOT EXISTS summary_correction_detail (
  id                     BIGSERIAL   PRIMARY KEY,
  improvement_log_id     BIGINT      NOT NULL REFERENCES summary_improvement_log(id) ON DELETE CASCADE,
  original_text          TEXT        NOT NULL,
  corrected_text         TEXT        NOT NULL,
  term_en                VARCHAR(255),
  recommended_es         VARCHAR(255),
  correction_type        VARCHAR(50),
  confidence_score       DECIMAL(3,2),
  context_before         TEXT,
  context_after          TEXT
);

CREATE INDEX IF NOT EXISTS idx_summary_correction_detail_improvement_log_id
  ON summary_correction_detail (improvement_log_id);
CREATE INDEX IF NOT EXISTS idx_summary_correction_detail_term_en
  ON summary_correction_detail (term_en);

-- Stats cache for quick dashboard rendering
CREATE TABLE IF NOT EXISTS glossary_improvement_stats (
  id                      BIGSERIAL   PRIMARY KEY,
  calculated_at           TIMESTAMPTZ DEFAULT NOW(),
  total_articles_improved INTEGER     DEFAULT 0,
  total_changes           INTEGER     DEFAULT 0,
  articles_with_v1        INTEGER     DEFAULT 0,
  articles_with_v2        INTEGER     DEFAULT 0,
  articles_with_v3        INTEGER     DEFAULT 0,
  articles_with_v4        INTEGER     DEFAULT 0,
  articles_with_v5        INTEGER     DEFAULT 0,
  avg_changes_per_article DECIMAL(5,2) DEFAULT 0,
  most_common_correction  VARCHAR(255),
  last_improvement_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS glossary_stats_latest_idx
  ON glossary_improvement_stats ((1));

COMMIT;
