-- Recover historical glossary improvements (before summary_improvement_log existed)
-- This migration creates log entries for articles that were improved but lack tracking

BEGIN;

-- Crear entradas en summary_improvement_log para artículos mejorados históricamente
INSERT INTO summary_improvement_log (
    article_id,
    glossary_version_used,
    original_summary,
    improved_summary,
    changes_count,
    batch_id,
    improved_at,
    dry_run,
    input_tokens,
    output_tokens,
    model_used
)
SELECT
    a.id,
    a.ai_summary_glossary_version,
    a.summary_ai,  -- Use current summary as placeholder
    a.summary_ai,  -- Mark as 0 changes since we don't have the original
    0,             -- No changes recorded (we don't have before/after comparison)
    'recovered-' || gen_random_uuid()::text,
    a.updated_at,
    FALSE,
    0,
    0,
    'recovered-from-field'
FROM articles a
WHERE a.ai_summary_glossary_version IS NOT NULL
  AND a.id NOT IN (
    SELECT DISTINCT article_id FROM summary_improvement_log
  )
ON CONFLICT DO NOTHING;

-- Log count of recovered articles
DO $$
DECLARE
    recovered_count INT;
BEGIN
    SELECT COUNT(*)
    INTO recovered_count
    FROM summary_improvement_log
    WHERE model_used = 'recovered-from-field';

    RAISE NOTICE 'Recovered % historical glossary improvements', recovered_count;
END $$;

COMMIT;
