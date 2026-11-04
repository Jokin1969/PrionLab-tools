-- Records who scheduled a share email, so that once it actually sends
-- we can mark the article as read for that person — mirrors what the
-- PrionVault Picks digest already does for its own emails.
ALTER TABLE prionvault_scheduled_email ADD COLUMN IF NOT EXISTS sender_user_id UUID;
