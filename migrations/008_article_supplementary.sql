-- ──────────────────────────────────────────────────────────────────────────────
-- Supplementary material attached to an article.
--
-- Each row points to a single file stored in Dropbox under
--   /PrionLab tools/PrionVault/<year>/supp/<slug>-supp-<short>.<ext>
-- and lets the admin annotate it with a free-text caption. The file
-- type is recorded as `kind` (pdf, xlsx, csv, video, image, archive,
-- doc, other) so the UI can pick the right icon and decide whether to
-- offer an inline preview vs a plain download.
--
-- extracted_text is reserved for a future text-extraction pass on
-- PDF/CSV/TXT supplementaries — kept here so the same column can later
-- feed the FTS / RAG pipeline without a schema change.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS article_supplementary (
    id             UUID         PRIMARY KEY,
    article_id     UUID         NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    kind           VARCHAR(20)  NOT NULL DEFAULT 'other',
    filename       TEXT         NOT NULL,
    dropbox_path   TEXT         NOT NULL,
    size_bytes     BIGINT,
    caption        TEXT,
    extracted_text TEXT,
    added_by       UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS article_supplementary_article_idx
    ON article_supplementary (article_id);

-- Dedup safety: same file uploaded twice for the same article should be
-- caught by the dropbox_path unique constraint (we generate a short
-- random suffix so genuine re-uploads still go through).
CREATE UNIQUE INDEX IF NOT EXISTS article_supplementary_path_uniq
    ON article_supplementary (dropbox_path);

COMMIT;
