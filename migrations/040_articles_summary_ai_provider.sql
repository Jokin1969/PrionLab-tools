-- Track which AI provider generated the summary_ai field.
-- Values: 'anthropic' | 'openai' | 'gemini' (or NULL for legacy summaries)
ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_ai_provider TEXT;
