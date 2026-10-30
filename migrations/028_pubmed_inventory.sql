-- ──────────────────────────────────────────────────────────────────────────────
-- PubMed inventory.
--
-- A persistent mirror of every PMID that PubMed returns for the
-- catalogue's umbrella query (`prion[Title/Abstract] OR prions[MeSH
-- Major Topic]`). The harvester (tools/prionvault/services/pubmed_inventory.py)
-- runs on a 7-day lease + a manual button; on each pass it upserts
-- every PMID found and bumps `last_seen_at`. Rows that disappear from
-- PubMed (rare — retractions / withdrawals) stay in the table with
-- their old `last_seen_at` so the operator can still see them.
--
-- The "missing" listing is built by joining LEFT against `articles`
-- on `pubmed_id` and filtering `imported_at IS NULL AND dismissed = FALSE`.
-- `imported_at` is set by the reconciliation pass (run after every
-- harvest and on every stats call) so the catalogue ←→ inventory
-- alignment is eventually consistent even if a manual ingest bypassed
-- the inventory entirely.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_pubmed_inventory (
    pmid           VARCHAR(20)  PRIMARY KEY,
    title          TEXT,
    authors        TEXT,
    year           INTEGER,
    journal        TEXT,
    doi            TEXT,
    -- PMC ID when PubMed reports one (PMCNNNNNNN). Cheap signal of
    -- "fulltext available on PMC" — surfaced as the OA badge in the UI.
    pmcid          TEXT,
    discovered_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- TRUE once the operator imported this PMID (the matching row in
    -- `articles` has the same pubmed_id) OR an external ingest beat
    -- the inventory to it. Set by reconcile().
    imported_at    TIMESTAMPTZ,
    -- TRUE when the operator clicked "no me interesa"; the listing
    -- hides it but it stays in the table so a future harvest pass
    -- doesn't keep re-inserting it.
    dismissed      BOOLEAN      NOT NULL DEFAULT FALSE,
    dismissed_at   TIMESTAMPTZ,
    dismissed_by   UUID
);

-- Hot path: "still pending" — neither imported nor dismissed.
-- Partial index keeps it small even as the table grows past 30k rows.
CREATE INDEX IF NOT EXISTS pubmed_inventory_pending_idx
  ON prionvault_pubmed_inventory (year DESC NULLS LAST, last_seen_at DESC)
  WHERE imported_at IS NULL AND dismissed = FALSE;

-- For the "imported" / "dismissed" filter pages of the modal.
CREATE INDEX IF NOT EXISTS pubmed_inventory_year_idx
  ON prionvault_pubmed_inventory (year DESC NULLS LAST);

-- Lookup-by-DOI for the reconciliation pass when an article has a DOI
-- but no PMID stored (cross-check).
CREATE INDEX IF NOT EXISTS pubmed_inventory_doi_idx
  ON prionvault_pubmed_inventory (lower(doi))
  WHERE doi IS NOT NULL;

COMMIT;
