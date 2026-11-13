-- The periodic schema self-heal re-ran migration 007 every five minutes, and
-- 007 re-created the article search trigger function with its ORIGINAL body,
-- switching off the v2 vectors (stemming, accents, prefixes) for every
-- article saved since. The self-heal no longer touches that function; this
-- bumps the vector version so the background job re-indexes every article
-- once and repairs the ones saved or edited in the meantime.

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
    NEW.search_ver := 3;
  EXCEPTION WHEN OTHERS THEN
    NEW.search_vector2 := NULL;
    NEW.rank_vector := NULL;
    NEW.search_ver := NULL;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
