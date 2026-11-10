-- OA PDF fetcher: count transient failures instead of giving up on the first.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS pdf_oa_attempts INTEGER NOT NULL DEFAULT 0;
