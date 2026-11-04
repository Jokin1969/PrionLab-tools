-- ──────────────────────────────────────────────────────────────────────────────
-- PubMed inventory: persistent "keep" decision.
--
-- The operator can now click "Esta sí" on a row to mark it as
-- explicitly wanted but not yet imported. The mark survives forever
-- (until the article actually lands in `articles` and reconcile()
-- sets imported_at), so the row keeps surfacing in search results
-- without losing the operator's earlier "yes I want this" decision.
--
-- "Esta no" remains backed by the existing `dismissed` boolean — no
-- schema change needed for the negative case, just for the positive
-- one.
--
-- Both columns are nullable, indexless metadata. A new partial index
-- speeds up the "kept but not yet imported" listing, which is the
-- hot path for the new "⭐ Marcados" tab.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prionvault_pubmed_inventory
  ADD COLUMN IF NOT EXISTS kept_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kept_by UUID;

CREATE INDEX IF NOT EXISTS pubmed_inventory_kept_idx
  ON prionvault_pubmed_inventory (year DESC NULLS LAST, kept_at DESC)
  WHERE kept_at IS NOT NULL AND imported_at IS NULL AND dismissed = FALSE;

COMMIT;
