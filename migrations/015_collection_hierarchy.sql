-- ──────────────────────────────────────────────────────────────────────────────
-- Two-level hierarchy on top of prionvault_collection: every row may
-- carry an optional `group_name` and `subgroup_name`, both free text.
--
-- Example usage:
--     group_name    = "PrionPacks"
--     subgroup_name = "Introducción"
--     name          = "Manuscrito Cell 2026"
--
-- We deliberately keep the labels as plain text rather than promoting
-- groups / subgroups to their own tables. Renaming a group is a
-- single UPDATE statement and the user has zero secondary behaviour
-- attached to the group label (no permissions, no separate metadata).
--
-- Both columns are nullable so existing rows stay valid. The
-- case-folded indexes back the new "filter by group" queries that
-- the article list endpoint runs.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prionvault_collection
    ADD COLUMN IF NOT EXISTS group_name    TEXT,
    ADD COLUMN IF NOT EXISTS subgroup_name TEXT;

CREATE INDEX IF NOT EXISTS prionvault_collection_group_idx
    ON prionvault_collection (lower(group_name))
    WHERE group_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS prionvault_collection_subgroup_idx
    ON prionvault_collection (lower(group_name), lower(subgroup_name))
    WHERE subgroup_name IS NOT NULL;

COMMIT;
