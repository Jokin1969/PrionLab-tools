-- Journal Club reservation ("claim") of an article.
--
-- Flow: an article marked as JC candidate (is_jc, the blue book) is
-- picked by someone to present → it is RESERVED for them: is_jc is
-- cleared (no longer offered as free) and the JC button turns red and
-- locked. Only the JC responsible / an admin can release it (back to
-- the pool) or unlock it early. Announcing the session (the lab-wide
-- convocation email) sets jc_announced_at, which unlocks the button for
-- the presenter so they can upload their presentation.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS jc_claimed_by      TEXT;         -- users.id (uuid, as text)
ALTER TABLE articles ADD COLUMN IF NOT EXISTS jc_claimed_by_name TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS jc_claimed_at      TIMESTAMPTZ;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS jc_announced_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS articles_jc_claimed_idx
    ON articles (jc_claimed_at) WHERE jc_claimed_by IS NOT NULL;
