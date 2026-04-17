import os
import logging
from datetime import datetime
import dropbox
from dropbox.exceptions import ApiError
from dropbox.files import FileMetadata
from core.dropbox_client import get_client
from config import CSV_DIR, DROPBOX_REMOTE_FOLDER

logger = logging.getLogger(__name__)


def _ensure_csv_dir():
    os.makedirs(CSV_DIR, exist_ok=True)


def _remote_path(filename: str) -> str:
    return f"{DROPBOX_REMOTE_FOLDER}/{filename}"


def list_remote_csvs() -> list[dict]:
    client = get_client()
    if client is None:
        return []
    try:
        result = client.files_list_folder(DROPBOX_REMOTE_FOLDER)
        entries = []
        while True:
            for entry in result.entries:
                if isinstance(entry, FileMetadata) and entry.name.endswith(".csv"):
                    entries.append({
                        "name": entry.name,
                        "size": entry.size,
                        "modified": entry.server_modified.isoformat() if entry.server_modified else None,
                        "content_hash": entry.content_hash,
                    })
            if not result.has_more:
                break
            result = client.files_list_folder_continue(result.cursor)
        return entries
    except ApiError as e:
        logger.error("Error listing remote CSVs: %s", e)
        return []


def _local_content_hash(filepath: str) -> str | None:
    try:
        import hashlib
        BLOCK_SIZE = 4 * 1024 * 1024
        block_hashes = []
        with open(filepath, "rb") as f:
            while True:
                block = f.read(BLOCK_SIZE)
                if not block:
                    break
                block_hashes.append(hashlib.sha256(block).digest())
        if not block_hashes:
            return hashlib.sha256(b"").hexdigest()
        return hashlib.sha256(b"".join(block_hashes)).hexdigest()
    except Exception:
        return None


def pull_from_dropbox() -> list[str]:
    _ensure_csv_dir()
    client = get_client()
    if client is None:
        logger.warning("Dropbox not configured; skipping pull")
        return []

    updated = []
    for meta in list_remote_csvs():
        name = meta["name"]
        local_path = os.path.join(CSV_DIR, name)
        remote_hash = meta.get("content_hash")

        if os.path.exists(local_path) and remote_hash:
            if _local_content_hash(local_path) == remote_hash:
                logger.debug("Skipping %s (unchanged)", name)
                continue

        try:
            _, response = client.files_download(_remote_path(name))
            with open(local_path, "wb") as f:
                f.write(response.content)
            logger.info("Downloaded %s from Dropbox", name)
            updated.append(name)
        except ApiError as e:
            logger.error("Failed to download %s: %s", name, e)

    _record_sync_time()
    return updated


def push_to_dropbox(filename: str) -> bool:
    client = get_client()
    if client is None:
        logger.warning("Dropbox not configured; skipping push")
        return False

    local_path = os.path.join(CSV_DIR, filename)
    if not os.path.exists(local_path):
        logger.error("Local file not found: %s", local_path)
        return False

    remote = _remote_path(filename)

    try:
        client.files_get_metadata(remote)
        timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        stem = filename.rsplit(".", 1)[0] if "." in filename else filename
        client.files_copy_v2(remote, _remote_path(f"{stem}.bak.{timestamp}.csv"))
        logger.info("Backed up %s in Dropbox", filename)
    except ApiError:
        pass

    try:
        with open(local_path, "rb") as f:
            client.files_upload(f.read(), remote, mode=dropbox.files.WriteMode("overwrite"))
        logger.info("Pushed %s to Dropbox", filename)
        return True
    except ApiError as e:
        logger.error("Failed to push %s: %s", filename, e)
        return False


def initial_sync():
    try:
        updated = pull_from_dropbox()
        if updated:
            logger.info("Initial sync: downloaded %d file(s): %s", len(updated), updated)
        else:
            logger.info("Initial sync: all files up to date")
    except Exception as e:
        logger.warning("Initial sync failed (app will continue): %s", e)


def _record_sync_time():
    try:
        from core.db import get_connection
        with get_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO app_meta (key, value, updated_at) "
                "VALUES (?, ?, CURRENT_TIMESTAMP)",
                ("last_dropbox_sync", datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")),
            )
            conn.commit()
    except Exception as e:
        logger.debug("Could not record sync time: %s", e)
