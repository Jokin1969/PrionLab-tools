-- Add ai_summary_glossary_version to articles table
-- Tracks which glossary version was used when AI summary was generated
-- NULL = summary generated before glossary system, or generated without glossary

ALTER TABLE articles
ADD COLUMN ai_summary_glossary_version INTEGER DEFAULT NULL;

CREATE INDEX idx_articles_ai_summary_glossary_version
  ON articles(ai_summary_glossary_version)
  WHERE ai_summary_glossary_version IS NULL;
