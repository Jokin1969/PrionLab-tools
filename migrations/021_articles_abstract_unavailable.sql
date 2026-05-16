-- ──────────────────────────────────────────────────────────────────────────────
-- Distinguish "abstract not searched yet" from "PubMed/CrossRef
-- confirmed there is no abstract for this paper". The first state is
-- actionable; the second one isn't, so we want to colour them
-- differently in the UI and stop suggesting a re-fetch.
--
-- TRUE  → we asked CrossRef and PubMed and both came back empty.
-- FALSE → either we already have an abstract, or we haven't tried yet.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS abstract_unavailable BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index for the "needs attention" listing.
CREATE INDEX IF NOT EXISTS articles_needs_abstract_idx
  ON articles (id)
  WHERE abstract IS NULL AND abstract_unavailable = FALSE;

COMMIT;
