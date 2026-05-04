-- ──────────────────────────────────────────────────────────────────────────────
-- PrionVault — initial schema migration
--
-- Strategy: PrionRead's `articles` table is the canonical paper entity.
-- We *extend* it with the columns PrionVault needs (full-text extraction,
-- AI summary, indexing metadata, dedup hash, etc.) and create new sibling
-- tables exclusive to PrionVault (chunks, tags, annotations, ingest queue,
-- usage tracking).
--
-- This migration is fully additive: it never drops, renames or rewrites
-- anything PrionRead currently uses. Safe to run on a live database.
--
-- Apply on Railway PostgreSQL. Recommended:
--   psql "$DATABASE_URL" -f migrations/001_prionvault_tables.sql
--
-- Roll-back script: migrations/001_prionvault_tables_rollback.sql
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Extensions ────────────────────────────────────────────────────────────────
-- pgvector for embeddings (Phase 4-5). Safe to enable now even if unused.
CREATE EXTENSION IF NOT EXISTS vector;
-- citext for case-insensitive uniqueness on DOI / pubmed_id.
CREATE EXTENSION IF NOT EXISTS citext;


-- ── 1. Extend the existing `articles` table ─────────────────────────────────-─

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS pdf_md5            CHAR(32),
  ADD COLUMN IF NOT EXISTS pdf_size_bytes     BIGINT,
  ADD COLUMN IF NOT EXISTS pdf_pages          INTEGER,
  ADD COLUMN IF NOT EXISTS extracted_text     TEXT,
  ADD COLUMN IF NOT EXISTS extraction_status  VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS extraction_error   TEXT,
  ADD COLUMN IF NOT EXISTS summary_ai         TEXT,
  ADD COLUMN IF NOT EXISTS summary_human      TEXT,
  ADD COLUMN IF NOT EXISTS indexed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS index_version      VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source             VARCHAR(40) DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_metadata    JSONB       DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS added_by_id        UUID;

-- Foreign key to users.id (UUID) — added separately because the column
-- already may exist from a previous partial run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'articles_added_by_fk'
  ) THEN
    ALTER TABLE articles
      ADD CONSTRAINT articles_added_by_fk
      FOREIGN KEY (added_by_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Unique constraints: the dedup hash and a normalised DOI lookup.
CREATE UNIQUE INDEX IF NOT EXISTS articles_pdf_md5_uniq
  ON articles (pdf_md5) WHERE pdf_md5 IS NOT NULL;

-- DOI index (functional, lowercase) for fast dedup checks.
CREATE INDEX IF NOT EXISTS articles_doi_lower_idx
  ON articles (lower(doi));

-- Year + journal lookups for the listing filters.
CREATE INDEX IF NOT EXISTS articles_year_idx     ON articles (year);
CREATE INDEX IF NOT EXISTS articles_added_at_idx ON articles (created_at DESC);

-- Full-text search (PostgreSQL `simple` config so PrPSc / GFAP don't get
-- mangled by english stemming). We keep it as a separate column populated
-- by trigger, not GENERATED, to allow PrionRead's existing ORM writes to
-- work without specifying it.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION articles_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.abstract, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary_ai, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary_human, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.authors, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.journal, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.extracted_text, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS articles_search_vector_trg ON articles;
CREATE TRIGGER articles_search_vector_trg
  BEFORE INSERT OR UPDATE OF title, abstract, summary_ai, summary_human,
                              authors, journal, extracted_text
  ON articles
  FOR EACH ROW EXECUTE FUNCTION articles_search_vector_update();

-- Backfill the vector on existing rows (safe — only runs the function).
UPDATE articles SET title = title;

CREATE INDEX IF NOT EXISTS articles_search_idx
  ON articles USING GIN (search_vector);


-- ── 2. ArticleChunk: vector index for semantic search (Phase 4-5) ───────────-─

CREATE TABLE IF NOT EXISTS article_chunk (
  id            BIGSERIAL  PRIMARY KEY,
  article_id    UUID       NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  chunk_index   INTEGER    NOT NULL,
  source_field  VARCHAR(20) NOT NULL DEFAULT 'extracted_text',
  chunk_text    TEXT       NOT NULL,
  tokens        INTEGER,
  page_from     INTEGER,
  page_to       INTEGER,
  -- Voyage `voyage-3-large` returns 1024-dim vectors. If we ever switch
  -- providers we can ALTER COLUMN with a USING cast and re-embed.
  embedding     vector(1024),
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE (article_id, chunk_index, source_field)
);

CREATE INDEX IF NOT EXISTS article_chunk_article_idx ON article_chunk (article_id);

-- HNSW index (pgvector >= 0.5). Build it AFTER bulk indexing for speed,
-- but creating it now is fine — it is empty and grows incrementally.
CREATE INDEX IF NOT EXISTS article_chunk_embedding_idx
  ON article_chunk USING hnsw (embedding vector_cosine_ops);


-- ── 3. PrionVault tags (separate from the existing articles.tags array) ─────-─
-- The existing articles.tags ARRAY(VARCHAR) stays for PrionRead. PrionVault
-- uses these new tables for richer tagging (color, admin-managed, audit).

CREATE TABLE IF NOT EXISTS article_tag (
  id          BIGSERIAL    PRIMARY KEY,
  name        CITEXT       UNIQUE NOT NULL,
  color       VARCHAR(7),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS article_tag_link (
  article_id  UUID    NOT NULL REFERENCES articles(id)    ON DELETE CASCADE,
  tag_id      BIGINT  NOT NULL REFERENCES article_tag(id) ON DELETE CASCADE,
  added_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (article_id, tag_id)
);

CREATE INDEX IF NOT EXISTS article_tag_link_tag_idx ON article_tag_link (tag_id);


-- ── 4. ArticleAnnotation: per-user notes on an article ─────────────────────-─

CREATE TABLE IF NOT EXISTS article_annotation (
  id            BIGSERIAL    PRIMARY KEY,
  article_id    UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  page          INTEGER,
  body          TEXT NOT NULL,
  is_published  BOOLEAN DEFAULT FALSE NOT NULL,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS article_annotation_article_idx
  ON article_annotation (article_id);
CREATE INDEX IF NOT EXISTS article_annotation_user_idx
  ON article_annotation (user_id);


-- ── 5. Ingest queue: persistent so Railway restarts can resume ─────────────-─

CREATE TABLE IF NOT EXISTS prionvault_ingest_job (
  id            BIGSERIAL     PRIMARY KEY,
  article_id    UUID REFERENCES articles(id) ON DELETE SET NULL,
  pdf_filename  TEXT,
  pdf_md5       CHAR(32),
  status        VARCHAR(20)   NOT NULL DEFAULT 'queued',
                              -- queued | uploading | extracting | resolving
                              -- | indexing | done | failed | duplicate
  step          VARCHAR(40),
  error         TEXT,
  attempts      INTEGER       NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   DEFAULT NOW() NOT NULL,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS prionvault_ingest_job_status_idx
  ON prionvault_ingest_job (status, created_at);


-- ── 6. Usage tracking: cost guardrails for AI search per user ───────────────-─

CREATE TABLE IF NOT EXISTS prionvault_usage (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action       VARCHAR(40)  NOT NULL,
                            -- semantic_search | summary_view | summary_generate
                            -- | embedding_index
  cost_usd     NUMERIC(10,5),
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  metadata     JSONB        DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS prionvault_usage_user_day_idx
  ON prionvault_usage (user_id, (date_trunc('day', created_at)));
CREATE INDEX IF NOT EXISTS prionvault_usage_action_idx
  ON prionvault_usage (action, created_at DESC);


COMMIT;

-- ──────────────────────────────────────────────────────────────────────────────
-- Verification queries (run after the migration to sanity-check)
-- ──────────────────────────────────────────────────────────────────────────────

-- 1. Confirm new columns are present:
--    \d+ articles
--
-- 2. Confirm full-text trigger fires:
--    UPDATE articles SET title = title WHERE id = (SELECT id FROM articles LIMIT 1);
--    SELECT id, title, length(search_vector::text) > 0 AS has_fts FROM articles LIMIT 5;
--
-- 3. Confirm pgvector + HNSW are alive:
--    SELECT extversion FROM pg_extension WHERE extname = 'vector';
--    SELECT count(*) FROM article_chunk;          -- should be 0
--
-- 4. Confirm PrionRead writes still work: open the PrionRead admin UI and
--    add or edit any article. The new columns will simply stay NULL.
