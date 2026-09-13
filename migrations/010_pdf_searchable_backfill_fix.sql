-- ──────────────────────────────────────────────────────────────────────────────
-- Re-do the pdf_searchable backfill from 009 with the right criterion.
--
-- 009 keyed off `prionvault_usage.action = 'text_extract'`, but those
-- rows were never persisted on this deployment: the first batch_extract
-- run happened before the auth fix landed, so the usage INSERT had
-- viewer_user_id=NULL, the NOT NULL constraint on
-- prionvault_usage.user_id rejected it, and the row was dropped
-- (the surrounding UPDATE survived because we later split the two
-- writes into separate transactions). Net effect: 0 rows match,
-- backfill is a no-op, every article stays pdf_searchable=FALSE.
--
-- batch_ocr ran AFTER the auth fix, so 'ocr_extract' rows do exist
-- for the 31 scanned papers. Flip the question: an article with
-- extracted_text that was NOT OCR'd was extracted by pdfplumber,
-- which means its PDF already had a real text layer.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

UPDATE articles a
SET pdf_searchable = TRUE
WHERE pdf_searchable = FALSE
  AND extracted_text IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM prionvault_usage u
    WHERE u.action = 'ocr_extract'
      AND (u.metadata->>'article_id')::uuid = a.id
  );

COMMIT;
