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
    """Compute Dropbox-compatible content hash for a local file."""
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
        combined = b"".join(block_hashes)
        return hashlib.sha256(combined).hexdigest()
    except Exception:
        return None

def pull_from_dropbox() -> list[str]:
    _ensure_csv_dir()
    client = get_client()
    if client is None:
        logger.warning("Dropbox not configured; skipping pull")
        return []

    updated = []
    remote_files = list_remote_csvs()

    for meta in remote_files:
        name = meta["name"]
        local_path = os.path.join(CSV_DIR, name)
        remote_hash = meta.get("content_hash")

        if os.path.exists(local_path) and remote_hash:
            local_hash = _local_content_hash(local_path)
            if local_hash == remote_hash:
                logger.debug("Skipping %s (unchanged)", name)
                continue

        try:
            remote = _remote_path(name)
            _, response = client.files_download(remote)
            with open(local_path, "wb") as f:
                f.write(response.content)
            logger.info("Downloaded %s from Dropbox", name)
            updated.append(name)
        except ApiError as e:
            logger.error("Failed to download %s: %s", name, e)

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

    # Backup existing remote file before overwriting
    try:
        client.files_get_metadata(remote)
        timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        stem = filename.rsplit(".", 1)[0] if "." in filename else filename
        backup_name = f"{stem}.bak.{timestamp}.csv"
        backup_remote = _remote_path(backup_name)
        client.files_copy_v2(remote, backup_remote)
        logger.info("Backed up %s to %s", filename, backup_name)
    except ApiError:
        pass  # File doesn't exist yet; no backup needed

    try:
        with open(local_path, "rb") as f:
            client.files_upload(f.read(), remote, mode=dropbox.files.WriteMode("overwrite"))
        logger.info("Pushed %s to Dropbox", filename)
        return True
    except ApiError as e:
        logger.error("Failed to push %s: %s", filename, e)
        return False


def initial_sync():
    """Called at app startup to pull all CSVs from Dropbox."""
    try:
        updated = pull_from_dropbox()
        if updated:
            logger.info("Initial sync: downloaded %d file(s): %s", len(updated), updated)
        else:
            logger.info("Initial sync: all files up to date")
    except Exception as e:
        logger.warning("Initial sync failed (app will continue): %s", e)
