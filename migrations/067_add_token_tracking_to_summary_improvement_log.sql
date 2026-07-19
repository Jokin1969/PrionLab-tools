-- Add token tracking and cost columns to summary_improvement_log
-- These columns track Claude API usage for cost analysis and audit

BEGIN;

-- Add columns if they don't exist
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'summary_improvement_log' AND column_name = 'input_tokens'
    ) THEN
        ALTER TABLE summary_improvement_log ADD COLUMN input_tokens INTEGER DEFAULT 0;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'summary_improvement_log' AND column_name = 'output_tokens'
    ) THEN
        ALTER TABLE summary_improvement_log ADD COLUMN output_tokens INTEGER DEFAULT 0;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'summary_improvement_log' AND column_name = 'total_tokens'
    ) THEN
        ALTER TABLE summary_improvement_log ADD COLUMN total_tokens INTEGER DEFAULT 0;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'summary_improvement_log' AND column_name = 'model_used'
    ) THEN
        ALTER TABLE summary_improvement_log ADD COLUMN model_used VARCHAR(255) DEFAULT 'claude-haiku-4-5-20251001';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'summary_improvement_log' AND column_name = 'cost_usd'
    ) THEN
        ALTER TABLE summary_improvement_log ADD COLUMN cost_usd DECIMAL(10,6) DEFAULT 0;
    END IF;
END $$;

COMMIT;
