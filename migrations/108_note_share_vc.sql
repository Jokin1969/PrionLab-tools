-- Sticky notes are per-user; a note flagged share_vc is also read by the
-- Vigilancia competitiva generator whoever runs it (e.g. the PI's notes
-- when Hasier generates the report).
ALTER TABLE prionvault_article_note ADD COLUMN IF NOT EXISTS share_vc BOOLEAN NOT NULL DEFAULT FALSE;
