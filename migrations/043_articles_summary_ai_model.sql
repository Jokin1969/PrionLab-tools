-- Track the exact model name used to generate each AI summary.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_ai_model VARCHAR(60);
