-- ──────────────────────────────────────────────────────────────────────────────
-- Translation glossary for AI-generated text (summaries + article chat).
--
-- Lets an admin pin the correct Spanish translation for terms the models
-- get wrong. Classic example: "bank vole" must be "topillo rojo", never
-- "musaraña de banco". Every AI summary / chat prompt gets these mappings
-- injected as a mandatory glossary so the model stops guessing.
--
-- `source_term` is matched case-insensitively; uniqueness is enforced on
-- its lowercased form so you can't register two conflicting rules.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_translation_glossary (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_term  TEXT        NOT NULL,        -- e.g. 'bank vole' (usually English)
    target_term  TEXT        NOT NULL,        -- e.g. 'topillo rojo'
    note         TEXT,                        -- optional context / usage note
    created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One rule per source term (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS pv_glossary_source_lower_idx
    ON prionvault_translation_glossary (LOWER(source_term));

COMMIT;
