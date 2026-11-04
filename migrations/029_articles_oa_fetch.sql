-- ──────────────────────────────────────────────────────────────────────────────
-- Open-access PDF auto-fetch for articles that came in via metadata
-- only (PubMed inventory import, or any other source that landed a
-- row without a `dropbox_path`).
--
-- Two new columns:
--   pmc_id           PubMed Central identifier (e.g. PMC1234567) when
--                    PubMed reports one. Lets the OA fetcher hit
--                    Europe PMC directly without rejoining the
--                    inventory table.
--   pdf_oa_status    NULL = not tried yet
--                    'fetched_unpaywall' = downloaded via Unpaywall
--                    'fetched_pmc'       = downloaded via PMC direct
--                    'not_available'     = tried both, no OA copy
--                    'failed'            = transient failure (retry next pass)
--
-- The partial index keeps the "still eligible for OA fetch" probe
-- O(log eligible) even as the catalogue grows. Once an article has
-- a dropbox_path it drops out of the index for good.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS pmc_id        TEXT,
  ADD COLUMN IF NOT EXISTS pdf_oa_status TEXT;

CREATE INDEX IF NOT EXISTS articles_oa_eligible_idx
  ON articles (id)
  WHERE dropbox_path IS NULL
    AND pdf_oa_status IS NULL
    AND (doi IS NOT NULL OR pmc_id IS NOT NULL);

-- A small helper index for the "imported without PDF" listing in the
-- PubMed-inventory modal stats panel.
CREATE INDEX IF NOT EXISTS articles_inventory_imported_idx
  ON articles (source)
  WHERE source = 'pubmed_inventory';

COMMIT;
