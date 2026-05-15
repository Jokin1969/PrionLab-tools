#!/usr/bin/env python3
"""CLI entrypoint for the scheduled Postgres backup.

Invoked by the systemd timer (or cron) to:
  1. Run pg_dump locally into ``${DATA_DIR}/backups/``.
  2. Mirror the dump to Dropbox under ``${PRIONLAB_BACKUP_DIR}``
     (default ``/PrionLab tools/Backups``).
  3. Apply the retention policy (``PRIONLAB_BACKUP_RETAIN_DAILY``
     daily backups + ``PRIONLAB_BACKUP_RETAIN_MONTHLY`` first-of-month
     backups) on the Dropbox folder.
  4. Trim the local working copy to the last 10 dumps.

Exit code is 0 on success, 1 on failure (so systemd / cron can flag
failures). Logs go to stdout for journalctl.

Run manually:
    python -m scripts.backup_postgres
"""
from __future__ import annotations

import logging
import sys


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("prionlab.backup")

    try:
        from database.backup import BackupManager
    except Exception as exc:
        log.error("Could not import BackupManager: %s", exc)
        return 1

    res = BackupManager().create_backup()
    if not res.get("success"):
        log.error("Backup failed: %s", res.get("error", "unknown"))
        return 1

    parts = [
        f"local={res.get('filename')}",
        f"size={res.get('size_mb')} MB",
    ]
    if res.get("dropbox_path"):
        parts.append(f"dropbox={res['dropbox_path']}")
    else:
        parts.append("dropbox=(skipped: not configured)")
    if res.get("dropbox_pruned"):
        parts.append(f"pruned={res['dropbox_pruned']}")
    log.info("Backup OK — %s", " ".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
