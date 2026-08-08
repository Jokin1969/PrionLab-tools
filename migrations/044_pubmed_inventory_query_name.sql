ALTER TABLE prionvault_pubmed_inventory
    ADD COLUMN IF NOT EXISTS query_name VARCHAR(100) DEFAULT 'prion';

UPDATE prionvault_pubmed_inventory SET query_name = 'prion' WHERE query_name IS NULL;
