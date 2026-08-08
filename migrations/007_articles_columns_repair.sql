-- ──────────────────────────────────────────────────────────────────────────────
-- Repair: ensure PrionVault columns + dependent objects exist on `articles`
--
-- Background: migration 001 used a single BEGIN/COMMIT block, and the
-- runner (tools/prionvault/migrate.py) splits each statement into its
-- own transaction. If an early statement failed in a particular env
-- (e.g. CREATE EXTENSION refused on managed Postgres, or the row was
-- skipped for any reason), the column-adding ALTER TABLE further down
-- never ran, yet the migration got marked as applied because the
-- runner is intentionally resilient.
--
-- This file re-asserts every additive object that PrionVault relies on
-- (columns, indexes, trigger, sibling tables). Every statement uses
-- IF NOT EXISTS / OR REPLACE / DO blocks, so re-running on a database
-- where everything is already in place is a no-op.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. PrionVault columns on `articles` (was the symptom).
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
  ADD COLUMN IF NOT EXISTS added_by_id        UUID,
  ADD COLUMN IF NOT EXISTS dropbox_path       TEXT,
  ADD COLUMN IF NOT EXISTS dropbox_link       TEXT,
  ADD COLUMN IF NOT EXISTS search_vector      tsvector;

-- 2. FK to users.id, idempotent.
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

-- 3. Indexes the app expects.
CREATE UNIQUE INDEX IF NOT EXISTS articles_pdf_md5_uniq
  ON articles (pdf_md5) WHERE pdf_md5 IS NOT NULL;
CREATE INDEX IF NOT EXISTS articles_doi_lower_idx ON articles (lower(doi));
CREATE INDEX IF NOT EXISTS articles_year_idx      ON articles (year);
CREATE INDEX IF NOT EXISTS articles_added_at_idx  ON articles (created_at DESC);
CREATE INDEX IF NOT EXISTS articles_search_idx
  ON articles USING GIN (search_vector);

-- 4. FTS trigger that keeps search_vector in sync.
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

-- 5. Backfill search_vector on existing rows so FTS works immediately.
UPDATE articles SET title = title WHERE search_vector IS NULL;

-- 6. ArticleChunk (vector embeddings). Recreate only if it never landed.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS article_chunk (
  id            BIGSERIAL  PRIMARY KEY,
  article_id    UUID       NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  chunk_index   INTEGER    NOT NULL,
  source_field  VARCHAR(20) NOT NULL DEFAULT 'extracted_text',
  chunk_text    TEXT       NOT NULL,
  tokens        INTEGER,
  page_from     INTEGER,
  page_to       INTEGER,
  embedding     vector(1024),
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE (article_id, chunk_index, source_field)
);

CREATE INDEX IF NOT EXISTS article_chunk_article_idx
  ON article_chunk (article_id);
CREATE INDEX IF NOT EXISTS article_chunk_embedding_idx
  ON article_chunk USING hnsw (embedding vector_cosine_ops);

-- 7. Tags + annotations + ingest queue + usage tracking — all sibling
--    tables from 001 that should exist by now. Re-create defensively.
CREATE EXTENSION IF NOT EXISTS citext;

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
CREATE INDEX IF NOT EXISTS article_tag_link_tag_idx
  ON article_tag_link (tag_id);

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

CREATE TABLE IF NOT EXISTS prionvault_usage (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action       VARCHAR(40)  NOT NULL,
  cost_usd     NUMERIC(10,5),
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  metadata     JSONB        DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS prionvault_usage_user_created_idx
  ON prionvault_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prionvault_usage_action_idx
  ON prionvault_usage (action, created_at DESC);

COMMIT;
