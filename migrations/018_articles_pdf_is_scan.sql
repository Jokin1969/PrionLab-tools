-- ──────────────────────────────────────────────────────────────────────────────
-- Track whether each article's PDF was originally an image-based scan
-- (no embedded text layer when uploaded).
--
-- `pdf_searchable` (migration 009) only tells us "this PDF has text now"
-- — true for both born-digital PDFs and OCR-rescued scans. The new flag
-- preserves the original nature of the file so the UI can show a chip
-- alongside the "indexed" badge.
--
-- Backfill: any article that produced an `ocr_extract` usage row was
-- a scan (pdfplumber would have extracted natural text otherwise, and
-- the batch_ocr worker only touches papers whose text layer was empty).
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS pdf_is_scan BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE articles a
SET pdf_is_scan = TRUE
WHERE pdf_is_scan = FALSE
  AND EXISTS (
    SELECT 1 FROM prionvault_usage u
    WHERE u.action = 'ocr_extract'
      AND (u.metadata->>'article_id')::uuid = a.id
  );

COMMIT;
