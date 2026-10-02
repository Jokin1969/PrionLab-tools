-- ──────────────────────────────────────────────────────────────────────────────
-- Query expansion dictionary for biomedical retrieval.
--
-- Holds the (term → expansions) mapping that the RAG query pipeline
-- uses to broaden a user question before embedding it. Covers
-- domain acronyms (PrP → prion protein), conceptual hyper/hyponyms
-- (GAG → glycosaminoglycan, heparan sulfate, …) and pre-seeded
-- MeSH-derived synonyms for terms common in prion / neurodegeneration
-- literature.
--
-- The same table powers both kinds of expansion because the data
-- model and lookup path are identical — we keep them apart via
-- `kind` so an admin UI can filter / sort / edit per category.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_query_expansion (
    id            BIGSERIAL PRIMARY KEY,
    -- The lookup key, stored lowercase so the matcher can do an
    -- exact compare without a function index. Word boundaries are
    -- enforced by the matcher, not the storage layer.
    term          TEXT NOT NULL,
    -- One or more strings that the term should be broadened into.
    -- Comma-separated, lowercased on insert. The matcher emits them
    -- alongside the original term so the embedder sees both.
    expansions    TEXT NOT NULL,
    kind          VARCHAR(16) NOT NULL,
        -- 'acronym' (PrP → prion protein),
        -- 'synonym' (heparan sulfate → glycosaminoglycan),
        -- 'mesh'    (descriptor pulled from MeSH 2024).
    source        VARCHAR(32) NOT NULL DEFAULT 'seed',
        -- 'seed' for the bundled dictionary;
        -- 'admin' for entries added through the UI;
        -- 'mesh_2024' for the curated MeSH subset.
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by    UUID,
    UNIQUE (term, kind)
);

-- Hot path: lower(term) lookup by the matcher. Lowercased on insert
-- already; index is a plain btree so the planner can use it for
-- IN-list lookups when the matcher batches multiple tokens.
CREATE INDEX IF NOT EXISTS prionvault_query_expansion_term_idx
  ON prionvault_query_expansion (term);

COMMIT;
