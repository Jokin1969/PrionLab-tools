-- VC generator: richer evidence per candidate paper.
ALTER TABLE prionvault_vc_item ADD COLUMN IF NOT EXISTS citations INT;           -- OpenAlex cited_by_count
ALTER TABLE prionvault_vc_item ADD COLUMN IF NOT EXISTS own_lab   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE prionvault_vc_item ADD COLUMN IF NOT EXISTS evidence  TEXT;          -- AI/human summary + notes
ALTER TABLE prionvault_vc_item ADD COLUMN IF NOT EXISTS signals   JSONB NOT NULL DEFAULT '{}'::jsonb;
