-- ──────────────────────────────────────────────────────────────────────────────
-- Allow NULL in articles.authors and articles.year.
--
-- Sequelize created the column as NOT NULL because the PrionRead admin
-- form forces both fields. PrionVault's ingest worker, however, accepts
-- PDFs whose metadata pipeline produces no DOI / PMID (source =
-- 'no_metadata' — typically old scans). Those papers come in with the
-- filename as the only "title" and authors / year unknown.
--
-- The Sequelize model keeps allowNull: false at the application layer,
-- so admin-driven inserts still require both fields. This change only
-- affects raw INSERTs from the worker.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles ALTER COLUMN authors DROP NOT NULL;
ALTER TABLE articles ALTER COLUMN year    DROP NOT NULL;

COMMIT;
