-- ──────────────────────────────────────────────────────────────────────────────
-- Track whether each article's PDF in Dropbox already has an
-- embedded text layer (so Ctrl+F / Spotlight / screen readers work).
--
-- TRUE  → the PDF is born-digital (pdfplumber extracted text), or has
--         been passed through ocrmypdf so the OCR'd text now lives as
--         an invisible layer in the file itself.
-- FALSE → the PDF is a pure scan (only images). The "Make PDFs
--         searchable" batch will pick these up.
--
-- We backfill from prionvault_usage: every paper that produced a
-- text_extract row already had a real text layer (pdfplumber wouldn't
-- have recovered anything otherwise), so we can mark it TRUE without
-- re-checking each file.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS pdf_searchable BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill the "already searchable" set from existing usage history.
UPDATE articles a
SET pdf_searchable = TRUE
WHERE pdf_searchable = FALSE
  AND EXISTS (
    SELECT 1 FROM prionvault_usage u
    WHERE u.action = 'text_extract'
      AND (u.metadata->>'article_id')::uuid = a.id
  );

-- Partial index optimised for "what's still pending" queries.
CREATE INDEX IF NOT EXISTS articles_pdf_searchable_pending_idx
  ON articles (id)
  WHERE pdf_searchable = FALSE AND dropbox_path IS NOT NULL;

COMMIT;
