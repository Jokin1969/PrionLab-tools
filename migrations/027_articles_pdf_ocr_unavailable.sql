-- ──────────────────────────────────────────────────────────────────────────────
-- "No insistas más con esta PDF" flag for the Make-PDFs-searchable batch.
--
-- ocrmypdf fails on some files for structural reasons (linearised PDFs
-- with broken xref, corrupt page streams, encrypted-but-no-password,
-- vector-only pages, etc.). Without this flag, every subsequent batch
-- run picks the same file again, fails again, and pollutes the log.
--
-- TRUE  → operator confirmed there's no point retrying; the batch
--         skips the row entirely.
-- FALSE → either we already embedded the text layer, or we haven't
--         tried yet, or the failure was transient.
--
-- Mirror of migration 024 (pubmed_unavailable) — same pattern, same
-- guarantees: idempotent, partial-index over the still-actionable
-- subset so the batch's per-row probe stays cheap.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS pdf_ocr_unavailable BOOLEAN NOT NULL DEFAULT FALSE;

-- "Still eligible for ocrmypdf" — drives the batch query AND the
-- modal's "pending" counter. Partial index keeps it tiny once most
-- of the library is searchable.
CREATE INDEX IF NOT EXISTS articles_ocr_pending_idx
  ON articles (id)
  WHERE dropbox_path IS NOT NULL
    AND pdf_searchable = FALSE
    AND pdf_ocr_unavailable = FALSE;

COMMIT;
