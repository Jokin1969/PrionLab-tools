"""Article supplementary material — CRUD + Dropbox storage.

Each row in `article_supplementary` represents one file (PDF, Excel,
video, image, etc.) uploaded as supplementary material for a paper.
The file itself lives in Dropbox under
    /PrionLab tools/PrionVault/<year>/supp/<doi-slug>-supp-<short>.<ext>
and the row stores its kind, original filename, Dropbox path, byte
size and an optional user-editable caption.
"""
from __future__ import annotations

import logging
import re
import secrets
import uuid
from typing import List, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)

# Hard cap on a single supplementary file. Videos are the realistic
# upper bound; 200 MB covers all but the longest microscopy movies.
MAX_FILE_BYTES = 200 * 1024 * 1024

# Map an extension (lower-case, no dot) to a "kind" label that the UI
# uses for icon + preview logic. Anything not listed becomes "other".
_KIND_BY_EXT = {
    "pdf":  "pdf",
    "xlsx": "xlsx", "xls": "xlsx",
    "csv":  "csv",
    "tsv":  "csv",
    "txt":  "txt",
    "md":   "txt",
    "doc":  "doc", "docx": "doc",
    "ppt":  "ppt", "pptx": "ppt",
    "mp4":  "video", "mov": "video", "avi": "video",
    "webm": "video", "mkv": "video",
    "png":  "image", "jpg": "image", "jpeg": "image",
    "gif":  "image", "tif": "image", "tiff": "image",
    "svg":  "image", "webp": "image",
    "zip":  "archive", "tar": "archive", "gz": "archive",
    "rar":  "archive", "7z": "archive",
    "json": "data", "xml": "data",
}


def _ext_of(filename: str) -> str:
    m = re.search(r"\.([A-Za-z0-9]{1,6})$", filename or "")
    return m.group(1).lower() if m else ""


def _kind_for(filename: str) -> str:
    return _KIND_BY_EXT.get(_ext_of(filename), "other")


def _slug_from_doi(doi: Optional[str]) -> str:
    if not doi:
        return ""
    s = doi.lower()
    s = re.sub(r"[^a-z0-9._-]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("._-")
    return s[:120]


def _build_dropbox_path(*, year: Optional[int], doi: Optional[str],
                        article_id: str, filename: str) -> str:
    """Compose the canonical supplementary path. The short random
    suffix guarantees uniqueness without having to query Dropbox."""
    year_str = str(year) if year else "unknown"
    base = _slug_from_doi(doi) or article_id.replace("-", "")[:16]
    ext = _ext_of(filename) or "bin"
    short = secrets.token_hex(3)        # 6-char hex, ~16M values
    name = f"{base}-supp-{short}.{ext}"
    return f"/PrionLab tools/PrionVault/{year_str}/supp/{name}"


# ── Public CRUD ──────────────────────────────────────────────────────────────

def list_for_article(article_id) -> List[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT s.id, s.kind, s.filename, s.dropbox_path,
                      s.size_bytes, s.caption, s.created_at,
                      s.added_by,
                      u.username AS added_by_username
               FROM article_supplementary s
               LEFT JOIN users u ON u.id = s.added_by
               WHERE s.article_id = :aid
               ORDER BY s.created_at ASC"""
        ), {"aid": str(article_id)}).mappings().all()
    return [{
        "id":           str(r["id"]),
        "kind":         r["kind"],
        "filename":     r["filename"],
        "dropbox_path": r["dropbox_path"],
        "size_bytes":   r["size_bytes"],
        "caption":      r["caption"] or "",
        "created_at":   r["created_at"].isoformat() if r["created_at"] else None,
        "added_by":     str(r["added_by"]) if r["added_by"] else None,
        "added_by_username": r["added_by_username"],
    } for r in rows]


def get_one(supp_id) -> Optional[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            """SELECT id, article_id, kind, filename, dropbox_path,
                      size_bytes, caption, created_at, added_by
               FROM article_supplementary
               WHERE id = :sid"""
        ), {"sid": str(supp_id)}).mappings().first()
    if not row:
        return None
    return {**row, "id": str(row["id"]), "article_id": str(row["article_id"])}


def create(*, article_id, content: bytes, filename: str,
           caption: Optional[str] = None,
           added_by=None) -> dict:
    """Upload `content` to Dropbox, then insert the metadata row.
    Raises ValueError on validation errors and RuntimeError on Dropbox
    failures so the caller can map to HTTP status codes.
    """
    if not content:
        raise ValueError("empty file")
    if len(content) > MAX_FILE_BYTES:
        raise ValueError(f"file too large (max {MAX_FILE_BYTES // (1024*1024)} MB)")
    if not filename:
        raise ValueError("missing filename")

    eng = _get_engine()
    # Look up year + DOI so we can build a meaningful path.
    with eng.connect() as conn:
        meta = conn.execute(sql_text(
            "SELECT year, doi FROM articles WHERE id = :aid"
        ), {"aid": str(article_id)}).first()
    if not meta:
        raise ValueError("article not found")
    year, doi = meta[0], meta[1]

    target = _build_dropbox_path(year=year, doi=doi,
                                 article_id=str(article_id),
                                 filename=filename)

    # Upload to Dropbox.
    try:
        from core.dropbox_client import get_client
        import dropbox
    except Exception as exc:
        raise RuntimeError(f"dropbox SDK unavailable: {exc}")
    client = get_client()
    if client is None:
        raise RuntimeError("dropbox not configured")
    try:
        client.files_upload(
            content, target,
            mode=dropbox.files.WriteMode.add,
            autorename=True, mute=True,
        )
    except Exception as exc:
        raise RuntimeError(f"dropbox upload failed: {exc}")

    sid = uuid.uuid4()
    kind = _kind_for(filename)
    with eng.begin() as conn:
        conn.execute(sql_text(
            """INSERT INTO article_supplementary
               (id, article_id, kind, filename, dropbox_path,
                size_bytes, caption, added_by, created_at)
               VALUES (:id, :aid, :kind, :filename, :dpath,
                       :size, :caption, :added_by, NOW())"""
        ), {
            "id":       str(sid),
            "aid":      str(article_id),
            "kind":     kind,
            "filename": filename,
            "dpath":    target,
            "size":     len(content),
            "caption":  caption,
            "added_by": str(added_by) if added_by else None,
        })
    return {
        "id":           str(sid),
        "article_id":   str(article_id),
        "kind":         kind,
        "filename":     filename,
        "dropbox_path": target,
        "size_bytes":   len(content),
        "caption":      caption or "",
    }


def update_caption(supp_id, caption: Optional[str]) -> bool:
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text(
            "UPDATE article_supplementary SET caption = :c WHERE id = :sid"
        ), {"c": caption, "sid": str(supp_id)})
        return (res.rowcount or 0) > 0


def delete(supp_id) -> bool:
    """Remove the row and best-effort delete the Dropbox file. We
    return True even if the Dropbox delete fails — the metadata row
    going away is the user-visible source of truth."""
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            "SELECT dropbox_path FROM article_supplementary WHERE id = :sid"
        ), {"sid": str(supp_id)}).first()
    if not row:
        return False
    path = row[0]

    with eng.begin() as conn:
        conn.execute(sql_text(
            "DELETE FROM article_supplementary WHERE id = :sid"
        ), {"sid": str(supp_id)})

    try:
        from core.dropbox_client import get_client
        client = get_client()
        if client is not None:
            client.files_delete_v2(path)
    except Exception as exc:
        logger.warning("supplementary: dropbox delete failed for %s: %s",
                       path, exc)
    return True


def temporary_link(supp_id) -> Optional[str]:
    """Return a Dropbox temporary download URL (valid ~4 hours) for
    the file referenced by `supp_id`, or None on failure."""
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            "SELECT dropbox_path FROM article_supplementary WHERE id = :sid"
        ), {"sid": str(supp_id)}).first()
    if not row:
        return None
    try:
        from core.dropbox_client import get_client
        client = get_client()
        if client is None:
            return None
        res = client.files_get_temporary_link(row[0])
        return res.link
    except Exception as exc:
        logger.warning("supplementary: temp link failed for %s: %s",
                       row[0], exc)
        return None
