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
  original_summary        TEXT       NOT NULL,        -- Snapshot before
  improved_summary        TEXT       NOT NULL,        -- Snapshot after
  changes_count           INTEGER    DEFAULT 0,
  batch_id                UUID,                       -- Group multiple improvements
  dry_run                 BOOLEAN    DEFAULT FALSE,
  INDEX (article_id),
  INDEX (glossary_version_used),
  INDEX (improved_at),
  INDEX (batch_id)
);

-- Correction details: individual changes made
CREATE TABLE IF NOT EXISTS summary_correction_detail (
  id                     BIGSERIAL   PRIMARY KEY,
  improvement_log_id     BIGSERIAL   NOT NULL REFERENCES summary_improvement_log(id) ON DELETE CASCADE,
  original_text          TEXT        NOT NULL,
  corrected_text         TEXT        NOT NULL,
  term_en                VARCHAR(255),              -- Linked to glossary term if found
  recommended_es         VARCHAR(255),
  correction_type        VARCHAR(50),               -- 'fuzzy_match' | 'claude_suggestion'
  confidence_score       DECIMAL(3,2),              -- 0.0-1.0
  context_before         TEXT,                      -- 50 chars context
  context_after          TEXT,
  INDEX (improvement_log_id),
  INDEX (term_en)
);

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
  last_improvement_at     TIMESTAMPTZ,
  UNIQUE INDEX IF NOT EXISTS glossary_stats_latest_idx ((1))
);

COMMIT;
