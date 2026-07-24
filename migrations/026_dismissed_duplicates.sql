-- ──────────────────────────────────────────────────────────────────────────────
-- Tracks pairs of articles that the admin has explicitly marked as
-- "no son duplicados" in the Find-duplicates modal, so the heuristic
-- detector (DOI / PMID / Jaccard ≥ 0.75) stops surfacing them on
-- subsequent scans.
--
-- The pair is stored with `article_a < article_b` lexicographically
-- so a given pair only exists once regardless of the order the user
-- clicked. ON DELETE CASCADE on both columns means deleting either
-- article automatically clears the dismissal too — re-importing the
-- paper later will start fresh.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prionvault_dismissed_duplicates (
    article_a    UUID         NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    article_b    UUID         NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    dismissed_by UUID,
    dismissed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    reason       TEXT,
    PRIMARY KEY (article_a, article_b),
    CHECK (article_a < article_b)
);

-- One index per column for the WHERE clauses the duplicate scanner runs.
CREATE INDEX IF NOT EXISTS dismissed_duplicates_a_idx
  ON prionvault_dismissed_duplicates (article_a);
CREATE INDEX IF NOT EXISTS dismissed_duplicates_b_idx
  ON prionvault_dismissed_duplicates (article_b);

COMMIT;
