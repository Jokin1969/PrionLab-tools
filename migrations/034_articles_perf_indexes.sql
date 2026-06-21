-- ──────────────────────────────────────────────────────────────────────────────
-- Performance indexes for the main article listing.
--
-- Profiling on a 4 000-article catalogue showed three hot paths in
-- /api/articles that were going through sequential scans:
--
--   1. Sort by lower(authors|title|journal): the sort_map exposes
--      "authors A→Z", "title A→Z", "journal A→Z" as default UI options
--      but there was no expression index over the lower() of any of
--      them. Each sort triggered a Sort node over the whole table.
--
--   2. The per-row jc_count subquery (refactored out of the SELECT in
--      this same change) is now a single batched COUNT() GROUP BY
--      article_id over prionvault_jc_presentation, which needs an
--      index on article_id to be cheap. Without it, that batch is a
--      full table scan over the JC table.
--
--   3. The is_favorite / is_read EXISTS predicates against
--      prionvault_user_state need a composite index on
--      (article_id, user_id) so the planner can fetch the matching
--      row directly instead of scanning the user's whole state.
--
-- All indexes are IF NOT EXISTS, so re-applying the migration on an
-- already-indexed cluster is a no-op (and Railway snapshot restores
-- can re-create them via the self-heal entry without errors).
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Sort accelerators. Functional indexes match the exact expression
-- the ORDER BY uses (lower(col)) so Postgres can read them in order
-- and skip the Sort node entirely.
CREATE INDEX IF NOT EXISTS articles_lower_authors_idx
  ON articles (lower(authors));
CREATE INDEX IF NOT EXISTS articles_lower_title_idx
  ON articles (lower(title));
CREATE INDEX IF NOT EXISTS articles_lower_journal_idx
  ON articles (lower(journal));

-- Lookups by PMID — used by reconcile(), de-dup checks, and the
-- /api/articles?pmid= path.
CREATE INDEX IF NOT EXISTS articles_pubmed_id_idx
  ON articles (pubmed_id)
  WHERE pubmed_id IS NOT NULL;

-- Joined / batched lookups.
CREATE INDEX IF NOT EXISTS jc_presentation_article_id_idx
  ON prionvault_jc_presentation (article_id);

CREATE INDEX IF NOT EXISTS user_state_article_user_idx
  ON prionvault_user_state (article_id, user_id);

COMMIT;
