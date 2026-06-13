-- ──────────────────────────────────────────────────────────────────────────────
-- Mirror of migration 021 (abstract_unavailable) for PMIDs.
--
-- The auto-backfill in /api/admin/pmid-backfill is good (~99% on a
-- prion catalogue) but the long tail are papers that genuinely don't
-- have a PubMed entry — books, conference abstracts, theses, technical
-- reports, items in non-indexed journals. We want a way to say "this
-- one has no PMID, stop trying" so:
--
--   - the backfill batch doesn't waste NCBI roundtrips on it
--   - the manual-entry list doesn't keep showing it
--   - the listing UI can mark it visually so the admin doesn't try
--     "🤖 Buscar PMID con IA" on it either
--
-- TRUE  → we've looked and confirmed there's no PMID.
-- FALSE → either we already have a PMID, or we haven't ruled it out.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS pubmed_unavailable BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index for the "still needs PMID" listing.
CREATE INDEX IF NOT EXISTS articles_needs_pmid_idx
  ON articles (id)
  WHERE pubmed_id IS NULL AND pubmed_unavailable = FALSE;

COMMIT;
