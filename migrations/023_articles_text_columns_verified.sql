-- ──────────────────────────────────────────────────────────────────────────────
-- Belt-and-braces version of migration 022.
--
-- 022 wrapped four ALTER COLUMN TYPE TEXT statements in BEGIN/COMMIT.
-- The PrionVault migration runner strips BEGIN/COMMIT and runs each
-- statement in its own implicit transaction; if one ALTER hits a
-- transient lock / wedged transaction it logs WARNING and continues,
-- and the migration name gets recorded as "applied" anyway so a
-- subsequent boot won't retry. After 022 landed we still saw
-- StringDataRightTruncation on `title` in production — meaning at
-- least one of those ALTERs silently failed.
--
-- This migration is genuinely idempotent: each ALTER is gated on an
-- information_schema check, so re-running is a no-op when the column
-- is already TEXT. The whole thing lives in one DO $$ … $$ block so
-- the runner treats it as a single atomic statement; if any ALTER
-- raises, the block aborts and the runner records the migration as
-- having failed (instead of silently marking it complete).
-- ──────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  changed_any BOOLEAN := FALSE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'articles' AND column_name = 'title'
       AND data_type   = 'character varying'
  ) THEN
    ALTER TABLE articles ALTER COLUMN title TYPE TEXT;
    RAISE NOTICE 'articles.title promoted from VARCHAR to TEXT';
    changed_any := TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'articles' AND column_name = 'journal'
       AND data_type   = 'character varying'
  ) THEN
    ALTER TABLE articles ALTER COLUMN journal TYPE TEXT;
    RAISE NOTICE 'articles.journal promoted from VARCHAR to TEXT';
    changed_any := TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'articles' AND column_name = 'doi'
       AND data_type   = 'character varying'
  ) THEN
    ALTER TABLE articles ALTER COLUMN doi TYPE TEXT;
    RAISE NOTICE 'articles.doi promoted from VARCHAR to TEXT';
    changed_any := TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'articles' AND column_name = 'dropbox_path'
       AND data_type   = 'character varying'
  ) THEN
    ALTER TABLE articles ALTER COLUMN dropbox_path TYPE TEXT;
    RAISE NOTICE 'articles.dropbox_path promoted from VARCHAR to TEXT';
    changed_any := TRUE;
  END IF;

  IF NOT changed_any THEN
    RAISE NOTICE 'articles long-text columns already TEXT — nothing to do';
  END IF;
END $$;

-- Final safety check: assert the four columns ended up TEXT. If any
-- of them is still character varying after the DO block above, raise
-- so the migration runner records this in `errors[].statements_failed`
-- instead of silently marking the migration as applied.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO bad
    FROM information_schema.columns
   WHERE table_name = 'articles'
     AND column_name IN ('title', 'journal', 'doi', 'dropbox_path')
     AND data_type   = 'character varying';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '023: still VARCHAR after ALTER — %', bad;
  END IF;
END $$;
