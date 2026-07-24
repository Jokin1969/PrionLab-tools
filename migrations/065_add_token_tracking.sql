-- Add token and cost tracking to summary_improvement_log
-- Allows showing users how much Claude API usage cost

ALTER TABLE summary_improvement_log ADD COLUMN IF NOT EXISTS (
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    model_used VARCHAR(100),
    cost_usd DECIMAL(10, 6)
);

-- Create index for cost queries
CREATE INDEX IF NOT EXISTS idx_improvement_log_cost ON summary_improvement_log(cost_usd DESC);
