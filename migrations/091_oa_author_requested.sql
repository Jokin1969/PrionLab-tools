-- Tracks whether an operator has already sent a "please send me a reprint"
-- request to the corresponding author from the "🔓 Buscar PDF" modal, so
-- the 🔓 badge can show that and avoid asking the same author twice.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS oa_author_requested_at TIMESTAMPTZ;
