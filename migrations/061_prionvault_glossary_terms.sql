-- ──────────────────────────────────────────────────────────────────────────────
-- PrionVault — Glossary management for biomedical terminology
--
-- Tracks English → Spanish translations with recommendations, avoid-lists, and
-- categorization. Supports versioning to detect new/changed terms on re-import.
--
-- Idempotent: safe to run multiple times.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_glossary_terms (
  id                    BIGSERIAL  PRIMARY KEY,
  term_en               TEXT       NOT NULL,
  term_es_recommended   TEXT       NOT NULL,
  term_es_avoid         TEXT,
  notes                 TEXT,
  category              VARCHAR(100),
  version               INTEGER    DEFAULT 1,
  imported_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint on English term to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS prionvault_glossary_term_en_idx
  ON prionvault_glossary_terms (term_en);

-- Index by category for filtering
CREATE INDEX IF NOT EXISTS prionvault_glossary_category_idx
  ON prionvault_glossary_terms (category);

-- Index by version for tracking changes
CREATE INDEX IF NOT EXISTS prionvault_glossary_version_idx
  ON prionvault_glossary_terms (version);

-- Metadata table: track import history and current version
CREATE TABLE IF NOT EXISTS prionvault_glossary_metadata (
  id               BIGSERIAL  PRIMARY KEY,
  current_version  INTEGER    NOT NULL DEFAULT 1,
  total_terms      INTEGER    DEFAULT 0,
  imported_at      TIMESTAMPTZ DEFAULT NOW(),
  notes            TEXT
);

-- Ensure only one metadata row
CREATE UNIQUE INDEX IF NOT EXISTS prionvault_glossary_metadata_singleton_idx
  ON prionvault_glossary_metadata ((1));

COMMIT;
