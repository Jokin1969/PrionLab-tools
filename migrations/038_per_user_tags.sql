-- ──────────────────────────────────────────────────────────────────────────────
-- Per-user article tags: take the existing `added_by` column on
-- article_tag_link and promote it to a PK column so each user can
-- carry their own tag set independently.
--
-- Until this migration the PK was (article_id, tag_id), which meant
-- only ONE row per (article, tag) could ever exist; whoever tagged
-- first won. After the migration the PK is (article_id, tag_id,
-- added_by), so each user maintains their own associations.
--
-- The tag dictionary (`article_tag` — name + color) stays shared:
-- creating a new tag still creates a globally-visible entry, but
-- assigning it to an article is now a per-user act.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Step 1: backfill any existing rows whose added_by is still NULL
-- (legacy state) onto the FIRST admin, falling back to the FIRST
-- user if no admin exists yet on this deployment.
UPDATE article_tag_link
   SET added_by = COALESCE(
     (SELECT id FROM users WHERE role = 'admin'
        ORDER BY created_at ASC LIMIT 1),
     (SELECT id FROM users
        ORDER BY created_at ASC LIMIT 1)
   )
 WHERE added_by IS NULL;

-- Step 2: drop any rows that are STILL null (the users table is
-- empty — only possible on a freshly seeded dev instance).
DELETE FROM article_tag_link WHERE added_by IS NULL;

-- Step 3: enforce NOT NULL on added_by. Wrapped in DO so a re-run
-- on an already-tightened column is a no-op rather than an error.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'article_tag_link'
       AND column_name = 'added_by'
       AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE article_tag_link
      ALTER COLUMN added_by SET NOT NULL;
  END IF;
END $$;

-- Step 4: swap the primary key. Only rebuilds when the PK doesn't
-- already span 3 columns, so re-running this migration on a fully
-- migrated DB is a no-op.
DO $$ BEGIN
  IF (
    SELECT count(*) FROM information_schema.key_column_usage
     WHERE constraint_name = 'article_tag_link_pkey'
       AND table_name      = 'article_tag_link'
  ) <> 3 THEN
    ALTER TABLE article_tag_link
      DROP CONSTRAINT IF EXISTS article_tag_link_pkey;
    ALTER TABLE article_tag_link
      ADD CONSTRAINT article_tag_link_pkey
      PRIMARY KEY (article_id, tag_id, added_by);
  END IF;
END $$;

-- Step 5: hot-path index for "tags this user has on this article"
-- (the listing's tag filter + the row decoration query) and the
-- reverse "articles this user tagged with X" (sidebar tag count).
CREATE INDEX IF NOT EXISTS article_tag_link_user_article_idx
  ON article_tag_link (added_by, article_id);
CREATE INDEX IF NOT EXISTS article_tag_link_user_tag_idx
  ON article_tag_link (added_by, tag_id);

COMMIT;
