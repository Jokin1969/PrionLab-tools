-- Accent/diacritic folding that does not depend on any extension: "Erana"
-- must find "Eraña" (and "Muller" → "Müller", "Lopez" → "López",
-- "Soren" → "Søren"…) whether or not the server allows `unaccent`.
-- pv_fold() maps every accented Latin letter to its plain one (case kept, so
-- the search operators OR / NOT still work) and is applied to BOTH the indexed
-- text and the query.

CREATE OR REPLACE FUNCTION pv_fold(t text) RETURNS text AS $$
  SELECT translate(
           replace(replace(replace(replace(replace(replace(coalesce(t, ''),
             'ß', 'ss'), 'æ', 'ae'), 'Æ', 'AE'), 'œ', 'oe'), 'Œ', 'OE'), 'þ', 'th'),
           'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝàáâãäåçèéêëìíîïðñòóôõöøùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĴĵĶķĹĺĻļĽľŁłŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳḀḁḂḃḄḅḆḇḈḉḊḋḌḍḎḏḐḑḒḓḔḕḖḗḘḙḚḛḜḝḞḟḠḡḢḣḤḥḦḧḨḩḪḫḬḭḮḯḰḱḲḳḴḵḶḷḸḹḺḻḼḽḾḿṀṁṂṃṄṅṆṇṈṉṊṋṌṍṎṏṐṑṒṓṔṕṖṗṘṙṚṛṜṝṞṟṠṡṢṣṤṥṦṧṨṩṪṫṬṭṮṯṰṱṲṳṴṵṶṷṸṹṺṻṼṽṾṿẀẁẂẃẄẅẆẇẈẉẊẋẌẍẎẏẐẑẒẓẔẕẖẗẘẙẛẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹ',
           'AAAAAACEEEEIIIIDNOOOOOOUUUUYaaaaaaceeeeiiiidnoooooouuuuyyAaAaAaCcCcCcCcDdDdEeEeEeEeEeGgGgGgGgHhHhIiIiIiIiIiJjKkLlLlLlLlNnNnNnOoOoOoRrRrRrSsSsSsSsTtTtTtUuUuUuUuUuUuWwYyYZzZzZzOoUuAaIiOoUuUuUuUuUuAaAaGgKkOoOojGgNnAaAaAaEeEeIiIiOoOoRrRrUuUuSsTtHhAaEeOoOoOoOoYyAaBbBbBbCcDdDdDdDdDdEeEeEeEeEeFfGgHhHhHhHhHhIiIiKkKkKkLlLlLlLlMmMmMmNnNnNnNnOoOoOoOoPpPpRrRrRrRrSsSsSsSsSsTtTtTtTtUuUuUuUuUuVvVvWwWwWwWwWwXxXxYyZzZzZzhtwysAaAaAaAaAaAaAaAaAaAaAaAaEeEeEeEeEeEeEeEeIiIiOoOoOoOoOoOoOoOoOoOoOoOoUuUuUuUuUuUuUuYyYyYyYy');
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Marks which version of the vectors a row carries, so the background job
-- re-indexes the rows built before the folding (no table rewrite here).
ALTER TABLE articles ADD COLUMN IF NOT EXISTS search_ver SMALLINT;

CREATE OR REPLACE FUNCTION pv_build_search_vector2(
    p_title text, p_abstract text, p_summary_ai text, p_summary_human text,
    p_authors text, p_journal text, p_extracted text) RETURNS tsvector AS $$
  SELECT setweight(to_tsvector('pv_search', pv_fold(p_title)), 'A') ||
         setweight(to_tsvector('pv_search', pv_fold(p_abstract)), 'B') ||
         setweight(to_tsvector('pv_search', pv_fold(p_summary_ai)), 'B') ||
         setweight(to_tsvector('pv_search', pv_fold(p_summary_human)), 'B') ||
         setweight(to_tsvector('pv_search', pv_fold(p_authors)), 'B') ||
         setweight(to_tsvector('pv_search', pv_fold(p_journal)), 'C') ||
         setweight(to_tsvector('pv_search', pv_fold(left(coalesce(p_extracted, ''), 800000))), 'D');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION pv_build_rank_vector(
    p_title text, p_authors text, p_abstract text, p_journal text) RETURNS tsvector AS $$
  SELECT setweight(to_tsvector('pv_search', pv_fold(p_title)), 'A') ||
         setweight(to_tsvector('pv_search', pv_fold(p_authors)), 'B') ||
         setweight(to_tsvector('pv_search', pv_fold(p_abstract)), 'C') ||
         setweight(to_tsvector('pv_search', pv_fold(p_journal)), 'D');
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
    NEW.search_ver := 2;
  EXCEPTION WHEN OTHERS THEN
    NEW.search_vector2 := NULL;
    NEW.rank_vector := NULL;
    NEW.search_ver := NULL;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Accent-insensitive "autor:" / "revista:" filters without a table scan.
CREATE INDEX IF NOT EXISTS articles_authors_fold_trgm_idx ON articles USING GIN (pv_fold(authors) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS articles_journal_fold_trgm_idx ON articles USING GIN (pv_fold(journal) gin_trgm_ops);
