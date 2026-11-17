-- Slimmer database (the database's size is what its memory bill follows).
--
-- 1. The original search vector ('simple' config) no longer carries the PDF
--    text: search_vector2 (migrations 112-114) already indexes it, stemmed and
--    accent-folded, so the copy only doubled the largest column and index.
--    Existing rows are rebuilt by the background job (search_ver 4).
-- 2. Two trigram indexes nothing uses any more (0 scans): the search no
--    longer runs ILIKE over AI summaries, and abstracts are matched through
--    the text-search vectors (the abstract-only field filter scans the few
--    thousand rows directly).

CREATE OR REPLACE FUNCTION pv_build_search_vector1(
    p_title text, p_abstract text, p_summary_ai text, p_summary_human text,
    p_authors text, p_journal text) RETURNS tsvector AS $$
  SELECT setweight(to_tsvector('simple', coalesce(p_title, '')), 'A') ||
         setweight(to_tsvector('simple', coalesce(p_abstract, '')), 'B') ||
         setweight(to_tsvector('simple', coalesce(p_summary_ai, '')), 'B') ||
         setweight(to_tsvector('simple', coalesce(p_summary_human, '')), 'B') ||
         setweight(to_tsvector('simple', coalesce(p_authors, '')), 'B') ||
         setweight(to_tsvector('simple', coalesce(p_journal, '')), 'C');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION articles_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := pv_build_search_vector1(
    NEW.title, NEW.abstract, NEW.summary_ai, NEW.summary_human, NEW.authors, NEW.journal);
  BEGIN
    NEW.search_vector2 := pv_build_search_vector2(
      NEW.title, NEW.abstract, NEW.summary_ai, NEW.summary_human,
      NEW.authors, NEW.journal, NEW.extracted_text);
    NEW.rank_vector := pv_build_rank_vector(NEW.title, NEW.authors, NEW.abstract, NEW.journal);
    NEW.search_ver := 4;
  EXCEPTION WHEN OTHERS THEN
    NEW.search_vector2 := NULL;
    NEW.rank_vector := NULL;
    NEW.search_ver := NULL;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS articles_summary_ai_trgm_idx;
DROP INDEX IF EXISTS articles_abstract_trgm_idx;
