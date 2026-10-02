-- "Repositorio de carritos": lets a user snapshot their current cart under
-- a name, then later browse and restore it (replacing whatever's in the
-- cart at the time). One row per saved snapshot; the article list itself
-- is stored as a JSONB array of the same {id, title, authors, year,
-- journal, doi, pubmed_id, has_pdf} shape already used by prionvault_cart's
-- `data` column, so restoring is just re-inserting into prionvault_cart —
-- no join back to `articles` needed (and the snapshot survives even if an
-- article is later deleted).
CREATE TABLE IF NOT EXISTS prionvault_saved_cart (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users(id),
    name       TEXT        NOT NULL,
    items      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pv_saved_cart_user ON prionvault_saved_cart (user_id, created_at DESC);
