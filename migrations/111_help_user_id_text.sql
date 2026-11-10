-- Help tutorials progress/feedback: user ids are UUID strings (session
-- "user_id"), but these columns were INTEGER, so every save failed silently.
DO $$
BEGIN
  IF to_regclass('public.help_user_progress') IS NOT NULL THEN
    ALTER TABLE help_user_progress ALTER COLUMN user_id TYPE TEXT USING user_id::text;
  END IF;
  IF to_regclass('public.help_feedback') IS NOT NULL THEN
    ALTER TABLE help_feedback ALTER COLUMN user_id TYPE TEXT USING user_id::text;
  END IF;
END $$;
