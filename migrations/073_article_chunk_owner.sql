-- ──────────────────────────────────────────────────────────────────────────────
-- Let article_chunk carry per-user content (sticky notes) alongside the
-- shared sources (PDF text, abstract, AI summary) without leaking one
-- user's private notes into another user's AI-search results.
--
-- owner_user_id NULL  → shared source, visible to every viewer (existing
--                        extracted_text / abstract / summary_ai rows).
-- owner_user_id = uid → belongs to that user only (source_field='notes').
--                        The retriever filters these out unless the
--                        searching viewer IS that user.
--
-- The old UNIQUE(article_id, chunk_index, source_field) constraint is
-- replaced with two partial unique indexes so ON CONFLICT can still
-- target the right one depending on whether owner_user_id is NULL.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE article_chunk
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS article_chunk_owner_idx
  ON article_chunk (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

DO $$
DECLARE
  cname text;
BEGIN
  SELECT tc.constraint_name INTO cname
  FROM information_schema.table_constraints tc
  WHERE tc.table_name = 'article_chunk'
    AND tc.constraint_type = 'UNIQUE'
    AND EXISTS (
      SELECT 1 FROM information_schema.constraint_column_usage ccu
      WHERE ccu.constraint_name = tc.constraint_name
        AND ccu.column_name = 'chunk_index'
    )
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE article_chunk DROP CONSTRAINT %I', cname);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS article_chunk_uniq_shared
  ON article_chunk (article_id, chunk_index, source_field)
  WHERE owner_user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS article_chunk_uniq_owned
  ON article_chunk (article_id, chunk_index, source_field, owner_user_id)
  WHERE owner_user_id IS NOT NULL;

COMMIT;
