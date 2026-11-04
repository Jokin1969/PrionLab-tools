-- Smart tags: a tag whose article membership is generated automatically
-- from a rule set, instead of being assigned by hand — same idea as
-- smart collections (migration 012), reusing the identical "kind" +
-- "rules" JSONB pattern so both features share one rule-evaluation
-- engine (see tools/prionvault/services/smart_rules.py).
--
-- Unlike smart collections (evaluated live, never persisted), smart
-- tags ARE persisted into article_tag_link: tags render as chips on
-- every listing row, so live per-row rule evaluation would be far more
-- expensive than the equivalent for collections (which only evaluate
-- once per page load, as a filter). is_auto marks which links were
-- written by the rule engine (vs a manual assignment), so re-syncing a
-- smart tag only ever touches its own auto-generated rows.
--
-- Tag assignments are per-user since migration 038 (article_tag_link's
-- PK includes added_by) — a smart tag's rule-driven matches are
-- therefore materialized under its own creator's added_by, same as if
-- that user had tagged the articles by hand. Two consequences: (1) a
-- smart tag's rules are restricted to article-level criteria only (no
-- per-viewer marks like priority/color/flag/favorite/read — those
-- would make "does this article match" depend on WHO is asking, which
-- doesn't fit a single materialized set), and (2) each user who wants
-- a given smart tag creates their own — there is no "shared" smart tag
-- that auto-populates for everyone at once.

BEGIN;

ALTER TABLE article_tag
    ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'manual'
        CHECK (kind IN ('manual', 'smart')),
    ADD COLUMN IF NOT EXISTS rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS article_tag_kind_idx ON article_tag (kind);

ALTER TABLE article_tag_link
    ADD COLUMN IF NOT EXISTS is_auto BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS article_tag_link_auto_idx
    ON article_tag_link (tag_id, is_auto);

COMMIT;
