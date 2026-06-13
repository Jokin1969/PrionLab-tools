"""PrionVault — Journal Club presentations.

Tracks who presented which paper in the lab's internal journal club
sessions, with their slides / handouts attached. Files live under
    /PrionLab tools/PrionVault/JC/<year>/<doi-slug>__<presenter>__<hex>.<ext>
in Dropbox, separate from the canonical paper PDFs.

A presentation row is purely metadata; the files hang off it in
prionvault_jc_file and are deleted in cascade when the presentation
goes away. Best-effort Dropbox cleanup runs after the DB delete —
losing a Dropbox file orphans nothing because the row was the only
thing pointing at it.
"""
from __future__ import annotations

import logging
import re
import secrets
import uuid
from datetime import date as _date
from typing import List, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)

# Same 200 MB cap as supplementary material; JC slides are usually
# tiny but a very figure-heavy pptx can grow to tens of MB.
MAX_FILE_BYTES = 200 * 1024 * 1024

_KIND_BY_EXT = {
    "pptx": "pptx", "ppt": "pptx",
    "pdf":  "pdf",
    "key":  "keynote",
    "odp":  "pptx",
}


def _ext_of(filename: str) -> str:
    m = re.search(r"\.([A-Za-z0-9]{1,6})$", filename or "")
    return m.group(1).lower() if m else ""


def _kind_for(filename: str) -> str:
    return _KIND_BY_EXT.get(_ext_of(filename), "other")


def _slug(s: str, n: int = 60) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s[:n] or "x"


def _build_dropbox_path(*, presented_at: _date, presenter_name: str,
                        doi: Optional[str], article_id: str,
                        filename: str) -> str:
    year = str(presented_at.year)
    base = _slug(doi) if doi else _slug(article_id.replace("-", ""))[:16]
    pres = _slug(presenter_name, 30)
    ext  = _ext_of(filename) or "bin"
    short = secrets.token_hex(3)
    name = f"{base}__{pres}__{short}.{ext}"
    return f"/PrionLab tools/PrionVault/JC/{year}/{name}"


# ── Presentations CRUD ──────────────────────────────────────────────────────

def list_for_article(article_id) -> List[dict]:
    """Return every JC presentation attached to one article, newest
    first, each one carrying its list of files."""
    eng = _get_engine()
    with eng.connect() as conn:
        pres_rows = conn.execute(sql_text(
            """SELECT id, article_id, presented_at, presenter_name,
                      presenter_id, created_at, created_by
               FROM prionvault_jc_presentation
               WHERE article_id = :aid
               ORDER BY presented_at DESC, created_at DESC"""
        ), {"aid": str(article_id)}).mappings().all()
        if not pres_rows:
            return []
        pres_ids = [r["id"] for r in pres_rows]
        file_rows = conn.execute(sql_text(
            """SELECT id, presentation_id, filename, dropbox_path,
                      size_bytes, kind, uploaded_at
               FROM prionvault_jc_file
               WHERE presentation_id = ANY(CAST(:pids AS uuid[]))
               ORDER BY uploaded_at ASC"""
        ), {"pids": [str(x) for x in pres_ids]}).mappings().all()

    files_by_pres: dict = {}
    for f in file_rows:
        files_by_pres.setdefault(str(f["presentation_id"]), []).append({
            "id":           str(f["id"]),
            "filename":     f["filename"],
            "dropbox_path": f["dropbox_path"],
            "size_bytes":   f["size_bytes"],
            "kind":         f["kind"],
            "uploaded_at":  f["uploaded_at"].isoformat() if f["uploaded_at"] else None,
        })
    return [{
        "id":              str(p["id"]),
        "article_id":      str(p["article_id"]),
        "presented_at":    p["presented_at"].isoformat() if p["presented_at"] else None,
        "presenter_name":  p["presenter_name"],
        "presenter_id":    str(p["presenter_id"]) if p["presenter_id"] else None,
        "created_at":      p["created_at"].isoformat() if p["created_at"] else None,
        "files":           files_by_pres.get(str(p["id"]), []),
    } for p in pres_rows]


def create(*, article_id, presented_at: _date,
           presenter_name: str, presenter_id=None,
           created_by=None) -> dict:
    presenter_name = (presenter_name or "").strip()
    if not presenter_name:
        raise ValueError("presenter_name required")
    if not isinstance(presented_at, _date):
        raise ValueError("presented_at must be a date")

    eng = _get_engine()
    pid = str(uuid.uuid4())
    with eng.begin() as conn:
        conn.execute(sql_text(
            """INSERT INTO prionvault_jc_presentation
               (id, article_id, presented_at, presenter_name,
                presenter_id, created_by, created_at, updated_at)
               VALUES (:id, :aid, :date, :pname, :pid, :cby, NOW(), NOW())"""
        ), {
            "id":    pid,
            "aid":   str(article_id),
            "date":  presented_at,
            "pname": presenter_name,
            "pid":   str(presenter_id) if presenter_id else None,
            "cby":   str(created_by)   if created_by   else None,
        })
    return {
        "id":             pid,
        "article_id":     str(article_id),
        "presented_at":   presented_at.isoformat(),
        "presenter_name": presenter_name,
        "presenter_id":   str(presenter_id) if presenter_id else None,
        "files":          [],
    }


def update(presentation_id, *, presented_at: Optional[_date] = None,
           presenter_name: Optional[str] = None,
           presenter_id=None) -> bool:
    sets = []
    params: dict = {"id": str(presentation_id)}
    if presented_at is not None:
        sets.append("presented_at = :date")
        params["date"] = presented_at
    if presenter_name is not None:
        v = presenter_name.strip()
        if not v:
            raise ValueError("presenter_name cannot be empty")
        sets.append("presenter_name = :pname")
        params["pname"] = v
    if presenter_id is not None:
        sets.append("presenter_id = :pid")
        params["pid"] = str(presenter_id) if presenter_id else None
    if not sets:
        return False
    sets.append("updated_at = NOW()")
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text(
            f"UPDATE prionvault_jc_presentation SET {', '.join(sets)} "
            f"WHERE id = :id"
        ), params)
        return (res.rowcount or 0) > 0


def delete(presentation_id) -> bool:
    """Delete the presentation row (cascades to files) and best-effort
    remove the Dropbox files. Returns True if the row existed."""
    eng = _get_engine()
    with eng.connect() as conn:
        paths = [r[0] for r in conn.execute(sql_text(
            "SELECT dropbox_path FROM prionvault_jc_file "
            "WHERE presentation_id = :pid"
        ), {"pid": str(presentation_id)}).all() if r[0]]

    with eng.begin() as conn:
        res = conn.execute(sql_text(
            "DELETE FROM prionvault_jc_presentation WHERE id = :pid"
        ), {"pid": str(presentation_id)})
        if (res.rowcount or 0) == 0:
            return False

    _dropbox_delete_paths(paths)
    return True


# ── Files (multipart upload + temp link) ────────────────────────────────────

def add_file(presentation_id, *, content: bytes, filename: str) -> dict:
    """Upload one file and attach it to a presentation."""
    if not content:
        raise ValueError("empty file")
    if len(content) > MAX_FILE_BYTES:
        raise ValueError(f"file too large (max {MAX_FILE_BYTES // (1024*1024)} MB)")
    if not filename:
        raise ValueError("missing filename")

    eng = _get_engine()
    with eng.connect() as conn:
        meta = conn.execute(sql_text(
            """SELECT p.presented_at, p.presenter_name, p.article_id, a.doi
               FROM prionvault_jc_presentation p
               JOIN articles a ON a.id = p.article_id
               WHERE p.id = :pid"""
        ), {"pid": str(presentation_id)}).first()
    if not meta:
        raise LookupError("presentation not found")
    presented_at, presenter_name, article_id, doi = meta

    target = _build_dropbox_path(presented_at=presented_at,
                                 presenter_name=presenter_name,
                                 doi=doi, article_id=str(article_id),
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

    fid = str(uuid.uuid4())
    kind = _kind_for(filename)
    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(sql_text(
            """INSERT INTO prionvault_jc_file
               (id, presentation_id, filename, dropbox_path,
                size_bytes, kind, uploaded_at)
               VALUES (:id, :pid, :filename, :dpath, :size, :kind, NOW())"""
        ), {
            "id":       fid,
            "pid":      str(presentation_id),
            "filename": filename,
            "dpath":    target,
            "size":     len(content),
            "kind":     kind,
        })
    return {
        "id":           fid,
        "filename":     filename,
        "dropbox_path": target,
        "size_bytes":   len(content),
        "kind":         kind,
    }


def delete_file(file_id) -> bool:
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            "SELECT dropbox_path FROM prionvault_jc_file WHERE id = :fid"
        ), {"fid": str(file_id)}).first()
    if not row:
        return False
    with eng.begin() as conn:
        conn.execute(sql_text(
            "DELETE FROM prionvault_jc_file WHERE id = :fid"
        ), {"fid": str(file_id)})
    _dropbox_delete_paths([row[0]] if row[0] else [])
    return True


def temporary_link(file_id) -> Optional[str]:
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            "SELECT dropbox_path FROM prionvault_jc_file WHERE id = :fid"
        ), {"fid": str(file_id)}).first()
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
        logger.warning("jc: temp link failed for %s: %s", row[0], exc)
        return None


def _dropbox_delete_paths(paths: List[str]) -> None:
    if not paths:
        return
    try:
        from core.dropbox_client import get_client
        client = get_client()
        if client is None:
            return
        for p in paths:
            try:
                client.files_delete_v2(p)
            except Exception as exc:
                logger.warning("jc: Dropbox delete failed for %s: %s",
                               p, exc)
    except Exception as exc:
        logger.warning("jc: Dropbox client unavailable: %s", exc)
