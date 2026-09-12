# PrionVault — Phase 1 testing checklist

Steps to validate the schema migration and the read-only blueprint
**before** moving to Phase 2 (bulk PDF ingestion).

## A. Apply the migration

### A.1 — Backup first
```bash
# Replace with your Railway connection string
pg_dump "$DATABASE_URL" > backups/before_prionvault_$(date +%Y%m%d_%H%M).sql
```

### A.2 — Run the migration
```bash
psql "$DATABASE_URL" -f migrations/001_prionvault_tables.sql
```
Expected: `BEGIN`, several `CREATE` / `ALTER` lines, `COMMIT`. No `ERROR`s.

### A.3 — Sanity checks
```sql
-- 1. New columns are present on `articles`
\d+ articles
-- Look for: pdf_md5, pdf_size_bytes, pdf_pages, extracted_text,
-- extraction_status, extraction_error, summary_ai, summary_human,
-- indexed_at, index_version, source, source_metadata, added_by_id,
-- search_vector.

-- 2. Trigger fires on title update
UPDATE articles SET title = title WHERE id = (SELECT id FROM articles LIMIT 1);
SELECT id, title, octet_length(search_vector::text) > 0 AS has_fts
FROM articles LIMIT 3;
-- has_fts should be TRUE.

-- 3. New tables exist and are empty
SELECT count(*) FROM article_chunk;       -- 0
SELECT count(*) FROM article_tag;          -- 0
SELECT count(*) FROM article_annotation;   -- 0
SELECT count(*) FROM prionvault_ingest_job; -- 0
SELECT count(*) FROM prionvault_usage;     -- 0

-- 4. pgvector is alive
SELECT extversion FROM pg_extension WHERE extname IN ('vector', 'citext');
-- Should return at least two rows.
```

If any check fails, run the rollback:
```bash
psql "$DATABASE_URL" -f migrations/001_prionvault_tables_rollback.sql
```

## B. Verify PrionRead still works

PrionRead's Sequelize backend writes to the same `articles` table.
**The migration is purely additive**, so PrionRead should be unaffected.

1. Open PrionRead at `/prionread/`.
2. Open an existing article in the admin view → confirm fields render correctly.
3. Edit any field (priority, tags) → save → confirm change persists.
4. Add a new article via "Add article" → confirm it lands in the DB:
   ```sql
   SELECT id, title, source, extraction_status FROM articles
   ORDER BY created_at DESC LIMIT 1;
   ```
   `source` should default to `'manual'`, `extraction_status` to `'pending'`
   (these are the new defaults we added). Everything else as before.

If anything breaks: rollback as above, file an issue.

## C. Verify PrionVault read endpoints

### C.1 — Open the page
Browse to `/prionvault/`. You should see the PrionVault index.

The sidebar shows:
- "📚 Library" with `All articles · count`
- Recently added / Without AI summary / Indexed for AI
- "🏷 Tags" (empty until you create some)
- "⚙ Tools" — **only if you are admin** (`pv-admin-only` class).

### C.2 — Endpoint smoke tests

While logged in as **admin**:
```bash
curl -s -b cookies.txt http://localhost:5000/prionvault/api/articles/stats | jq
# {
#   "total":           42,
#   "with_summary_ai": 0,
#   "with_extraction": 0,
#   "indexed":         0
# }

curl -s -b cookies.txt 'http://localhost:5000/prionvault/api/articles?size=3' | jq '.items[0]'
# Article shape with viewer_role=admin (includes pdf_md5, source, etc.)

curl -s -b cookies.txt 'http://localhost:5000/prionvault/api/articles?q=prion&size=5' | jq
# Full-text search; should match articles with "prion" in title/abstract/etc.
```

While logged in as **reader/editor**:
```bash
curl -s -b cookies.txt 'http://localhost:5000/prionvault/api/articles?size=3' | jq '.items[0]'
# Same shape but WITHOUT pdf_md5, source, pdf_dropbox_path
```

### C.3 — Admin gating
Logged in as reader, try a write operation:
```bash
curl -s -X POST -b cookies.txt \
     -H 'Content-Type: application/json' \
     -d '{"name":"prion"}' \
     http://localhost:5000/prionvault/api/tags
# Expected: HTTP 403 + {"error":"admin only"}
```

Logged in as admin, the same call returns 201 + the new tag.

### C.4 — Frontend role gating
- As **admin**, the sidebar shows "+ new" next to Tags and the entire
  "⚙ Tools" section (Import / Re-index / Manage queue — buttons disabled
  with tooltip "Available in Phase 2").
- As **reader**, those controls are NOT in the DOM (hidden by CSS class
  `pv-admin-only` toggling on `body`).

### C.5 — Search & filters
1. Type "prion" in the search input → results filter as you type.
2. Set Year `from = 2010, to = 2015` → list narrows.
3. Sort by "Year (newest)" → reorders.
4. Click a result card → modal opens showing detail.

## D. What is NOT yet implemented (expected)

Endpoints that return `501 Not Implemented Yet`:
- `POST /api/ingest/upload`
- `POST /api/articles/:aid/summary`
- `POST /api/search/semantic`

These are reserved for Phases 2-5 and are stubs by design. The frontend
buttons that would call them are either disabled or trigger a friendly
"coming soon" alert.

## E. Roll-forward path

When this checklist passes:
1. Tag the commit `prionvault-phase-1`.
2. Push to `main`. Railway redeploys both Flask service and PrionRead service.
3. Run the migration on Railway PostgreSQL via the Railway CLI:
   ```bash
   railway run psql "$DATABASE_URL" -f migrations/001_prionvault_tables.sql
   ```
4. Verify the production page at `/prionvault/` loads and counts match the DB.

Then we move to Phase 2: bulk PDF ingestion + admin import UI.
