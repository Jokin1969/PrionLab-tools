-- ──────────────────────────────────────────────────────────────────────────────
-- Fix: Create glossary tracking tables if they don't exist
--
-- This migration recreates the glossary-related tables if they're missing.
-- The previous migration (062) may have failed to create them properly.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Create summary_improvement_log if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'summary_improvement_log'
    ) THEN
        CREATE TABLE summary_improvement_log (
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

        CREATE INDEX idx_summary_improvement_log_article_id
            ON summary_improvement_log (article_id);
        CREATE INDEX idx_summary_improvement_log_glossary_version
            ON summary_improvement_log (glossary_version_used);
        CREATE INDEX idx_summary_improvement_log_improved_at
            ON summary_improvement_log (improved_at);
        CREATE INDEX idx_summary_improvement_log_batch_id
            ON summary_improvement_log (batch_id);
    END IF;
END $$;

-- Create summary_correction_detail if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'summary_correction_detail'
    ) THEN
        CREATE TABLE summary_correction_detail (
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

        CREATE INDEX idx_summary_correction_detail_improvement_log_id
            ON summary_correction_detail (improvement_log_id);
        CREATE INDEX idx_summary_correction_detail_term_en
            ON summary_correction_detail (term_en);
    END IF;
END $$;

-- Create glossary_improvement_stats if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'glossary_improvement_stats'
    ) THEN
        CREATE TABLE glossary_improvement_stats (
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

        CREATE UNIQUE INDEX glossary_stats_latest_idx
            ON glossary_improvement_stats ((1));
    END IF;
END $$;

COMMIT;
