-- Store the full citation metadata (title/authors/doi/pmid/has_pdf) for
-- each assistant message's retrieved PrionVault fragments, not just the
-- article ids that ended up cited — the chat UI needs the full list to
-- resolve a hover card for every [N] token that appears in the answer,
-- including reloaded (not just freshly-sent) messages.

BEGIN;

ALTER TABLE prionvault_library_chat_message
  ADD COLUMN IF NOT EXISTS citations JSONB;

COMMIT;
