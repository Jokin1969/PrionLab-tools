-- Lets a chat thread span several articles at once (the cart-wide "Chat IA"
-- button): all rows sharing the same group_id are one logical conversation,
-- one row per article so each article still counts as having its own chat
-- (the existing per-article "has_own_chat" badge query only checks
-- article_id, so it keeps working unmodified). Only the is_primary row ever
-- holds messages; the others are markers.
ALTER TABLE prionvault_article_chat
    ADD COLUMN IF NOT EXISTS group_id UUID,
    ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_pv_article_chat_group ON prionvault_article_chat (group_id);
