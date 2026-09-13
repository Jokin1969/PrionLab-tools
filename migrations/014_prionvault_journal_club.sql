-- ──────────────────────────────────────────────────────────────────────────────
-- Journal Club presentations.
--
-- Two tables because a "presentation" is conceptually one event
-- (one date, one presenter, optional notes-but-we-skip-them-for-now)
-- that may carry N files (typically 1 .pptx, occasionally a
-- supporting .pdf). Same article can be presented twice in different
-- years, by different people — composite uniqueness would be wrong.
--
-- presenter_name is the source of truth (free text — covers external
-- speakers). presenter_id is an optional link to the internal users
-- table for analytics (e.g. "how many JCs has Castilla led this year")
-- without forcing the constraint when somebody from outside presents.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_jc_presentation (
    id              UUID         PRIMARY KEY,
    article_id      UUID         NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    presented_at    DATE         NOT NULL,
    presenter_name  TEXT         NOT NULL,
    presenter_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prionvault_jc_pres_article_idx
    ON prionvault_jc_presentation (article_id);
CREATE INDEX IF NOT EXISTS prionvault_jc_pres_date_idx
    ON prionvault_jc_presentation (presented_at DESC);
CREATE INDEX IF NOT EXISTS prionvault_jc_pres_presenter_idx
    ON prionvault_jc_presentation (lower(presenter_name));


CREATE TABLE IF NOT EXISTS prionvault_jc_file (
    id                UUID         PRIMARY KEY,
    presentation_id   UUID         NOT NULL
                                   REFERENCES prionvault_jc_presentation(id)
                                   ON DELETE CASCADE,
    filename          TEXT         NOT NULL,
    dropbox_path      TEXT         NOT NULL,
    size_bytes        BIGINT,
    kind              VARCHAR(20)  NOT NULL DEFAULT 'pptx',
    uploaded_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prionvault_jc_file_pres_idx
    ON prionvault_jc_file (presentation_id);
CREATE UNIQUE INDEX IF NOT EXISTS prionvault_jc_file_path_uniq
    ON prionvault_jc_file (dropbox_path);

COMMIT;
