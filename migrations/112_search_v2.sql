-- Search v2: stemming ("prion" finds "prions"), accent folding ("Erana"
-- finds "Eraña") and a small vector for relevance ranking.
--
-- Purely additive: the existing search_vector ('simple') and its index stay
-- and keep being used; search_vector2/rank_vector are filled for new/edited
-- rows by the trigger and for existing rows by a background job
-- (services/search_v2.py), never here — a full-table rewrite at boot would
-- outlast the deploy healthcheck.

CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pv_search') THEN
    CREATE TEXT SEARCH CONFIGURATION pv_search (COPY = english);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
    ALTER TEXT SEARCH CONFIGURATION pv_search
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, english_stem;
  END IF;
END $$;

ALTER TABLE articles ADD COLUMN IF NOT EXISTS search_vector2 tsvector;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS rank_vector tsvector;

CREATE INDEX IF NOT EXISTS articles_search_vector2_idx ON articles USING GIN (search_vector2);

CREATE OR REPLACE FUNCTION pv_build_search_vector2(
    p_title text, p_abstract text, p_summary_ai text, p_summary_human text,
    p_authors text, p_journal text, p_extracted text) RETURNS tsvector AS $$
  SELECT setweight(to_tsvector('pv_search', coalesce(p_title, '')), 'A') ||
         setweight(to_tsvector('pv_search', coalesce(p_abstract, '')), 'B') ||
         setweight(to_tsvector('pv_search', coalesce(p_summary_ai, '')), 'B') ||
         setweight(to_tsvector('pv_search', coalesce(p_summary_human, '')), 'B') ||
         setweight(to_tsvector('pv_search', coalesce(p_authors, '')), 'B') ||
         setweight(to_tsvector('pv_search', coalesce(p_journal, '')), 'C') ||
         setweight(to_tsvector('pv_search', left(coalesce(p_extracted, ''), 800000)), 'D');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION pv_build_rank_vector(
    p_title text, p_authors text, p_abstract text, p_journal text) RETURNS tsvector AS $$
  SELECT setweight(to_tsvector('pv_search', coalesce(p_title, '')), 'A') ||
         setweight(to_tsvector('pv_search', coalesce(p_authors, '')), 'B') ||
         setweight(to_tsvector('pv_search', coalesce(p_abstract, '')), 'C') ||
         setweight(to_tsvector('pv_search', coalesce(p_journal, '')), 'D');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION articles_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.abstract, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary_ai, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary_human, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.authors, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.journal, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.extracted_text, '')), 'D');
  BEGIN
    NEW.search_vector2 := pv_build_search_vector2(
      NEW.title, NEW.abstract, NEW.summary_ai, NEW.summary_human,
      NEW.authors, NEW.journal, NEW.extracted_text);
    NEW.rank_vector := pv_build_rank_vector(NEW.title, NEW.authors, NEW.abstract, NEW.journal);
  EXCEPTION WHEN OTHERS THEN
    -- never block saving an article because of the v2 vectors
    NEW.search_vector2 := NULL;
    NEW.rank_vector := NULL;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
