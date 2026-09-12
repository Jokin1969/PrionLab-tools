# Restoring a PrionLab Postgres backup

The scheduled backup job in `scripts/backup_postgres.py` produces files
named `pgdump_YYYYMMDD_HHMMSS.sql.gz` and mirrors them to Dropbox under
`${PRIONLAB_BACKUP_DIR}` (default `/PrionLab tools/Backups`). Each file
is a **plain SQL dump compressed with gzip**, created with
`pg_dump --clean --if-exists`.

## 1. Pick the backup

From the Admin → Database page, copy the filename of the dump you want.
Alternatively, list the Dropbox folder via the desktop client / web UI.

## 2. Download it locally

Either copy it manually from Dropbox, or use the SDK:

```bash
python - <<'PY'
from core.dropbox_client import get_client
client = get_client()
client.files_download_to_file(
    "pgdump_20260515_030000.sql.gz",
    "/PrionLab tools/Backups/pgdump_20260515_030000.sql.gz",
)
PY
```

## 3. Restore into a target database

> **Caution** — `--clean --if-exists` drops existing objects before
> recreating them. Restore into a fresh DB unless you really want to
> overwrite the live one.

```bash
gunzip -c pgdump_20260515_030000.sql.gz \
  | psql "postgresql://user:pass@host:5432/prionlab_restored"
```

To create a fresh database first:

```bash
createdb -h host -U user prionlab_restored
```

## 4. Point the app at the restored DB

Edit `.env`:

```
DATABASE_URL=postgresql://user:pass@host:5432/prionlab_restored
```

Then restart the app. Migrations run automatically at boot and are
idempotent, so it is safe to launch the app on a freshly restored DB.

## Notes

- The CSV-export fallback (`csv_export_*.gz`) is a per-table dump and
  cannot be restored with `psql`. It is intended only as a last-resort
  data export when `pg_dump` is unavailable on the host running the
  backup script.
- PDFs are stored in Dropbox under `/PrionLab tools/PrionVault/<year>/`
  and are not part of the database dump — Dropbox keeps its own version
  history for them.
