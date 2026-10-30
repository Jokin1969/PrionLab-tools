-- The blue JC book now means "in the Journal Club circuit": it stays on while
-- an article is reserved. Backfill reservations made when claiming cleared it.
UPDATE articles a SET is_jc = TRUE
 WHERE a.jc_claimed_by IS NOT NULL
   AND a.is_jc IS NOT TRUE
   AND NOT EXISTS (SELECT 1 FROM prionvault_jc_presentation p WHERE p.article_id = a.id);
