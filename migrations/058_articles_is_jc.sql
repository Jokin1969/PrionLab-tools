-- ──────────────────────────────────────────────────────────────────────────────
-- Make the Journal Club mark SHARED (article-level) instead of per-user.
--
-- The 📖 "Journal Club" mark was added per-user in prionvault_user_state (055),
-- so each user only saw their own. It should be a shared curation signal: the
-- admin marks which articles are to be reviewed in Journal Club and everyone
-- sees them. So the mark now lives on `articles` (admin-writable, all-readable).
--
-- Backfill: any article that ANY user had marked keeps the mark, so the
-- current selections aren't lost in the migration.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS is_jc BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE articles a
   SET is_jc = TRUE
 WHERE a.is_jc IS NOT TRUE
   AND EXISTS (SELECT 1 FROM prionvault_user_state s
                WHERE s.article_id = a.id AND s.is_jc IS TRUE);

CREATE INDEX IF NOT EXISTS articles_is_jc_idx
    ON articles (is_jc) WHERE is_jc IS TRUE;

COMMIT;
