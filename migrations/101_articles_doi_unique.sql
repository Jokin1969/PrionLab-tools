-- One article per DOI: two PDFs of the same paper ingested at once (both
-- gunicorn workers run an ingest thread) used to create two rows. Only
-- created when the library has no duplicate DOIs yet — otherwise a NOTICE
-- is raised and the "Buscar duplicados" tool should be used first; the
-- migration still counts as applied (re-run it from "Force migrations").
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'articles_doi_lower_uniq') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT lower(doi) FROM articles
              WHERE doi IS NOT NULL AND btrim(doi) <> ''
              GROUP BY lower(doi) HAVING count(*) > 1) THEN
    RAISE NOTICE 'articles_doi_lower_uniq NOT created: duplicate DOIs exist';
    RETURN;
  END IF;
  CREATE UNIQUE INDEX articles_doi_lower_uniq ON articles (lower(doi))
   WHERE doi IS NOT NULL AND btrim(doi) <> '';
END $$;
