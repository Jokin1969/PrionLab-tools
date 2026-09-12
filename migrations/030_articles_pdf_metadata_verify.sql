-- ──────────────────────────────────────────────────────────────────────────────
-- PDF ↔ metadata consistency verifier.
--
-- The operator imports a non-trivial fraction of papers by hand,
-- which means there's a real risk of the wrong PDF ending up
-- attached to a metadata row — same title-ish but the wrong year,
-- a different paper from the same group, etc. That contamination is
-- particularly painful because the AI summary gets generated from
-- the bad PDF and then trusted blindly downstream.
--
-- Three new columns on articles:
--   pdf_metadata_match_status     NULL = not checked
--                                'ok'         heuristic ≥ 80
--                                'suspect'    heuristic 40-79 OR
--                                              LLM says uncertain
--                                'mismatch'   heuristic < 40 OR
--                                              LLM says mismatch
--                                'manual_ok'  operator marked it
--                                              fine after review
--                                'no_pdf_text' nothing to compare
--                                              (extracted_text empty)
--   pdf_metadata_match_score      heuristic 0-100, NULL if not run
--   pdf_metadata_match_checked_at when the last verification ran
--   pdf_metadata_match_detail     short reason — e.g.
--                                "title=55 author=25 year=15"
--                                or "LLM: year reads 1996 in PDF, DB says 2007".
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS pdf_metadata_match_status     TEXT,
  ADD COLUMN IF NOT EXISTS pdf_metadata_match_score      INTEGER,
  ADD COLUMN IF NOT EXISTS pdf_metadata_match_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pdf_metadata_match_detail     TEXT;

-- Partial index for the "still pending verification" probe — keeps
-- the batch's per-iteration "next article" query O(log eligible).
CREATE INDEX IF NOT EXISTS articles_verify_pending_idx
  ON articles (id)
  WHERE pdf_metadata_match_status IS NULL
    AND dropbox_path IS NOT NULL
    AND extracted_text IS NOT NULL;

-- Index for the modal's "show suspects / mismatches" listing.
CREATE INDEX IF NOT EXISTS articles_verify_status_idx
  ON articles (pdf_metadata_match_status)
  WHERE pdf_metadata_match_status IS NOT NULL;

COMMIT;
