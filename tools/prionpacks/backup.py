import hashlib
import logging
import os
from datetime import datetime, timezone

import config
from core.dropbox_client import get_client

logger = logging.getLogger(__name__)

_PACKAGES_FILE = os.path.join(config.DATA_DIR, "prionpacks.json")
_HASH_FILE = os.path.join(config.DATA_DIR, "prionpacks_backup_hash.txt")


def _current_hash() -> str:
    if not os.path.exists(_PACKAGES_FILE):
        return ""
    with open(_PACKAGES_FILE, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def _last_hash() -> str:
    if os.path.exists(_HASH_FILE):
        with open(_HASH_FILE) as f:
            return f.read().strip()
    return ""


def _save_hash(h: str):
    with open(_HASH_FILE, "w") as f:
        f.write(h)


def _cleanup_old_backups(dbx) -> None:
    try:
        result = dbx.files_list_folder(config.DROPBOX_PRIONPACKS_BACKUP_FOLDER)
        entries = sorted(
            [e for e in result.entries if e.name.startswith("prionpacks_") and e.name.endswith(".json")],
            key=lambda e: e.name,
        )
        for entry in entries[: -config.PRIONPACKS_BACKUP_RETENTION]:
            dbx.files_delete_v2(entry.path_lower)
            logger.info("PrionPacks backup deleted (retention): %s", entry.name)
    except Exception as exc:
        logger.warning("PrionPacks backup cleanup failed: %s", exc)


def run_backup(force: bool = False) -> dict:
    """Upload prionpacks.json to Dropbox only if it changed since the last backup."""
    current = _current_hash()
    if not current:
        return {"status": "skipped", "message": "prionpacks.json not found"}

    if not force and current == _last_hash():
        return {"status": "skipped", "message": "Sin cambios desde el último backup"}

    dbx = get_client()
    if dbx is None:
        return {"status": "error", "message": "Dropbox no configurado"}

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    remote_path = f"{config.DROPBOX_PRIONPACKS_BACKUP_FOLDER}/prionpacks_{timestamp}.json"

    try:
        # Ensure folder exists
        try:
            dbx.files_create_folder_v2(config.DROPBOX_PRIONPACKS_BACKUP_FOLDER)
        except Exception:
            pass  # folder already exists

        with open(_PACKAGES_FILE, "rb") as f:
            data = f.read()
        dbx.files_upload(data, remote_path)
        _save_hash(current)
        _cleanup_old_backups(dbx)
        logger.info("PrionPacks backup OK: %s", remote_path)
        return {"status": "ok", "path": remote_path, "timestamp": timestamp}
    except Exception as exc:
        logger.error("PrionPacks backup failed: %s", exc)
        return {"status": "error", "message": str(exc)}


def list_backups() -> list:
    """Return list of available backups in Dropbox, newest first."""
    dbx = get_client()
    if dbx is None:
        return []
    try:
        result = dbx.files_list_folder(config.DROPBOX_PRIONPACKS_BACKUP_FOLDER)
        entries = sorted(
            [e for e in result.entries if e.name.startswith("prionpacks_") and e.name.endswith(".json")],
            key=lambda e: e.name,
            reverse=True,
        )
        return [
            {
                "name": e.name,
                "path": e.path_lower,
                "size_kb": round(getattr(e, "size", 0) / 1024, 1),
                "timestamp": e.name.replace("prionpacks_", "").replace(".json", ""),
            }
            for e in entries
        ]
    except Exception as exc:
        logger.warning("PrionPacks backup list failed: %s", exc)
        return []


def restore_backup(remote_path: str) -> dict:
    """Download a backup from Dropbox and replace the local prionpacks.json."""
    import json

    dbx = get_client()
    if dbx is None:
        return {"status": "error", "message": "Dropbox no configurado"}

    try:
        _, response = dbx.files_download(remote_path)
        data = response.content
        # Validate JSON before overwriting
        json.loads(data)

        # Save current as emergency local snapshot before overwriting
        if os.path.exists(_PACKAGES_FILE):
            emergency = _PACKAGES_FILE + ".pre_restore"
            with open(_PACKAGES_FILE, "rb") as src, open(emergency, "wb") as dst:
                dst.write(src.read())

        with open(_PACKAGES_FILE, "wb") as f:
            f.write(data)

        # Reset hash so next scheduled backup uploads the restored version
        _save_hash(_current_hash())
        logger.info("PrionPacks restored from: %s", remote_path)
        return {"status": "ok", "restored_from": remote_path}
    except Exception as exc:
        logger.error("PrionPacks restore failed: %s", exc)
        return {"status": "error", "message": str(exc)}
