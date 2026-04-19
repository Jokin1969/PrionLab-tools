# Railway Volume Configuration — PrionLab Tools

## Volume Mount

Railway automatically mounts the persistent volume at `/data` (or the path set
in the `DATA_DIR` environment variable).  The app creates all subdirectories on
startup via `_ensure_data_dirs()`.

```
/data/
├── csv/          ← CSV exports pulled from / pushed to Dropbox
├── papers/       ← Uploaded PDF files
├── cache/        ← Temporary cache files (cleared on optimize)
├── logs/         ← Rotating log files (prionlab.log)
├── backups/      ← pg_dump / CSV archive backups
└── prionlab.db   ← SQLite metadata DB (sync timestamps, app_meta)
```

## Required Environment Variables

| Variable | Description | Required |
|---|---|---|
| `DATA_DIR` | Volume mount path (default `/data`) | No |
| `DATABASE_URL` | PostgreSQL connection string | No (CSV fallback) |
| `DROPBOX_APP_KEY` | Dropbox OAuth app key | For cloud backup |
| `DROPBOX_APP_SECRET` | Dropbox OAuth app secret | For cloud backup |
| `DROPBOX_REFRESH_TOKEN` | Dropbox OAuth refresh token | For cloud backup |
| `BACKUP_RETENTION_COUNT` | Number of local backups to keep (default `10`) | No |

## Data Persistence Strategy

### Critical data → Railway Volume `/data`
- SQLite metadata DB: sync timestamps, app configuration
- PostgreSQL data: publications, manuscripts, users (backed up weekly via `pg_dump`)
- CSV exports: local copies of all tables, synced with Dropbox
- PDF papers and uploads

### Backup data → Dropbox `/Web-tools/PrionLab tools/`
- CSV files pushed automatically on change (content-hash based)
- Timestamped `.bak.YYYYMMDD-HHMMSS.csv` versions preserved automatically
- Full DB backup archives uploaded to Dropbox on request

### Scheduled maintenance (APScheduler, UTC)
| Task | Schedule | Description |
|---|---|---|
| Session cleanup | Every hour | Marks expired sessions inactive |
| Log cleanup | Daily 02:00 | Removes logs older than 90 days |
| Search vector update | Daily 02:30 | Updates FTS vectors (PostgreSQL) |
| Weekly backup | Sunday 03:00 | `pg_dump` or CSV archive |
| Vacuum/Analyze | Sunday 04:00 | PostgreSQL maintenance |

## Deployment Verification

Run from the Railway shell or a one-off process:

```python
python -c "
import os, sqlite3
assert os.path.exists('/data'), 'Volume /data not mounted'
conn = sqlite3.connect('/data/prionlab.db')
conn.execute('CREATE TABLE IF NOT EXISTS _probe (id INTEGER)')
conn.commit(); conn.close()
print('Volume persistence OK')
"
```

## Data Management Dashboard

Accessible at `/data-management/` (admin users only).  Provides:
- Real-time storage status for volume, CSVs, backups, PostgreSQL, Dropbox
- One-click backup (pg_dump or CSV archive fallback)
- Integrity check across all storage layers
- Storage optimization (cache cleanup + DB vacuum)
- Manual Dropbox push / pull

## API Endpoints

All require authentication.  Admin role required for write operations.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/data-management/api/status` | Storage status JSON |
| POST | `/data-management/api/backup` | Trigger backup (`{"backup_type":"auto"\|"csv_only"}`) |
| GET | `/data-management/api/backups` | List local backups |
| POST | `/data-management/api/integrity-check` | Run integrity check |
| POST | `/data-management/api/optimize` | Optimize storage |
| POST | `/data-management/api/sync/push` | Push CSVs to Dropbox |
| POST | `/data-management/api/sync/pull` | Pull CSVs from Dropbox |
| GET | `/data-management/api/export/<table>` | Export DB table to CSV |
