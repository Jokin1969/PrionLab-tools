-- ──────────────────────────────────────────────────────────────────────────────
-- New articles default to priority 3 (medium).
--
-- PrionRead's Sequelize model already carries defaultValue: 3 but
-- `sequelize.sync({ alter: true })` does not reliably back-fill column
-- defaults across deploys. PrionVault's ingest worker (see
-- tools/prionvault/ingestion/worker.py) does a raw INSERT that omits
-- `priority` and therefore relied on whatever the column-level DEFAULT
-- happened to be — which on production was NULL.
--
-- We don't touch existing rows; only future INSERTs that don't supply
-- `priority` will pick up the new default.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles ALTER COLUMN priority SET DEFAULT 3;

COMMIT;
