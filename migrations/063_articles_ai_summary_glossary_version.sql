-- Add ai_summary_glossary_version to articles table
-- Tracks which glossary version was used when AI summary was generated
-- NULL = summary generated before glossary system, or generated without glossary

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'articles'
    AND column_name = 'ai_summary_glossary_version'
  ) THEN
    ALTER TABLE articles
    ADD COLUMN ai_summary_glossary_version INTEGER DEFAULT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_articles_ai_summary_glossary_version
  ON articles(ai_summary_glossary_version)
  WHERE ai_summary_glossary_version IS NULL;
