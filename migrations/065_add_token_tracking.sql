-- Add token and cost tracking to summary_improvement_log
-- Allows showing users how much Claude API usage cost

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'summary_improvement_log'
    AND column_name = 'input_tokens'
  ) THEN
    ALTER TABLE summary_improvement_log ADD COLUMN input_tokens INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'summary_improvement_log'
    AND column_name = 'output_tokens'
  ) THEN
    ALTER TABLE summary_improvement_log ADD COLUMN output_tokens INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'summary_improvement_log'
    AND column_name = 'total_tokens'
  ) THEN
    ALTER TABLE summary_improvement_log ADD COLUMN total_tokens INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'summary_improvement_log'
    AND column_name = 'model_used'
  ) THEN
    ALTER TABLE summary_improvement_log ADD COLUMN model_used VARCHAR(100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'summary_improvement_log'
    AND column_name = 'cost_usd'
  ) THEN
    ALTER TABLE summary_improvement_log ADD COLUMN cost_usd DECIMAL(10, 6);
  END IF;
END $$;

-- Create index for cost queries
CREATE INDEX IF NOT EXISTS idx_improvement_log_cost ON summary_improvement_log(cost_usd DESC);
