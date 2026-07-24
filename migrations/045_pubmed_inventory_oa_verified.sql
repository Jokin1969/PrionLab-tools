ALTER TABLE prionvault_pubmed_inventory
    ADD COLUMN IF NOT EXISTS oa_verified BOOLEAN DEFAULT FALSE;
