-- Fix retroactive glossary version for articles that were reviewed but not marked
-- This updates ai_summary_glossary_version for articles that have entries in summary_improvement_log
-- but were created before the fix that auto-updates this column

UPDATE articles
SET ai_summary_glossary_version = (
    SELECT MAX(glossary_version_used)
    FROM summary_improvement_log
    WHERE article_id = articles.id
    AND dry_run = FALSE
)
WHERE ai_summary_glossary_version IS NULL
AND EXISTS (
    SELECT 1 FROM summary_improvement_log
    WHERE article_id = articles.id
    AND dry_run = FALSE
);
