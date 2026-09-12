-- Track token usage per AI summary for cost estimation and quality insight.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_tokens_in  INTEGER;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_tokens_out INTEGER;
