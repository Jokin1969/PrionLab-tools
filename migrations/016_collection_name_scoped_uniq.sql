-- ──────────────────────────────────────────────────────────────────────────────
-- Loosen the uniqueness on prionvault_collection.name.
--
-- The old constraint was case-insensitive but GLOBAL: a single
-- "Introducción" was allowed across the whole library. With hierarchical
-- groups/subgroups, the same descriptive name belongs in many places
-- ("PrionPacks > PRP-001 > Introducción" should not clash with
-- "PrionPacks > PRP-002 > Introducción").
--
-- New uniqueness: the tuple (group, subgroup, name), all case-folded.
-- COALESCE with the empty string so NULLs participate (otherwise two
-- ungrouped collections could share the same name on PG, since NULLs
-- are distinct by default).
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP INDEX IF EXISTS prionvault_collection_name_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS prionvault_collection_name_uniq
    ON prionvault_collection (
        lower(COALESCE(group_name,    '')),
        lower(COALESCE(subgroup_name, '')),
        lower(name)
    );

COMMIT;
