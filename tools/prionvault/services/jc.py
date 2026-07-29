"""PrionVault — Journal Club presentations.

Tracks who presented which paper in the lab's internal journal club
sessions, with their slides / handouts attached. Files live under
    /PrionLab tools/Journal clubs/<responsable>/<yyyymmdd>/<filename>
in Dropbox, one folder per presenter and one subfolder per session date,
separate from the canonical paper PDFs.

A presentation row is purely metadata; the files hang off it in
prionvault_jc_file and are deleted in cascade when the presentation
goes away. Best-effort Dropbox cleanup runs after the DB delete —
losing a Dropbox file orphans nothing because the row was the only
thing pointing at it.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import date as _date, datetime as _datetime
from typing import List, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)

# Same 200 MB cap as supplementary material; JC slides are usually
# tiny but a very figure-heavy pptx can grow to tens of MB.
MAX_FILE_BYTES = 200 * 1024 * 1024

_KIND_BY_EXT = {
    "pptx": "pptx", "ppt": "pptx", "odp": "pptx", "key": "keynote",
    "pdf":  "pdf",
    "doc":  "word",  "docx": "word",  "odt": "word",
    "xls":  "excel", "xlsx": "excel", "ods": "excel", "csv": "excel",
    "png":  "image", "jpg":  "image", "jpeg": "image",
    "gif":  "image", "webp": "image", "heic": "image", "bmp": "image", "tiff": "image",
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


# Matches an 8-digit YYYYMMDD run anywhere in a filename, e.g.
# "20260415_prion_talk.pptx" or "slides-20260415-v2.pdf". Validated as
# a real calendar date before being trusted.
_FILENAME_DATE_RE = re.compile(r"(20\d{2})(\d{2})(\d{2})")


def infer_date_from_filenames(filenames: List[str]) -> _date:
    """Return the date encoded in the first filename that carries a
    valid YYYYMMDD run, else today. This is how a JC session's date is
    decided when the operator doesn't type one explicitly — the file
    naming convention already carries it."""
    for fn in filenames:
        for m in _FILENAME_DATE_RE.finditer(fn or ""):
            try:
                y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
                return _date(y, mo, d)
            except ValueError:
                continue
    return _datetime.utcnow().date()


def _safe_path_segment(s: str) -> str:
    """Sanitize a string for use as a Dropbox path segment. Keeps
    spaces/accents (Dropbox handles UTF-8 fine) — only strips
    characters that would break the path structure itself."""
    s = re.sub(r'[\/\\:*?"<>|]', "_", (s or "").strip())
    return s.strip(" .") or "x"


def _build_dropbox_path(*, presented_at: _date, presenter_name: str,
                        filename: str) -> str:
    folder = _safe_path_segment(presenter_name) or "Sin_asignar"
    yyyymmdd = presented_at.strftime("%Y%m%d")
    safe_filename = _safe_path_segment(filename)
    return f"/PrionLab tools/Journal clubs/{folder}/{yyyymmdd}/{safe_filename}"


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
        # Surfaced so the frontend can decide whether to render the
        # edit / delete buttons (creator-or-admin gate; matches the
        # server-side _ensure_can_modify rule).
        "created_by":      str(p["created_by"]) if p["created_by"] else None,
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
    remove the Dropbox files. Returns True if the row existed.

    A path shared with another presentation's file row (same document
    covering several articles — see add_file) is left alone in
    Dropbox; only paths that become fully orphaned are removed."""
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

    # By this point the presentation's own file rows are already gone
    # (deleted above / via CASCADE), so any remaining match is truly a
    # different presentation still using the path.
    _dropbox_delete_paths(_orphaned_paths(paths))
    return True


def _orphaned_paths(paths: List[str]) -> List[str]:
    """Filter `paths` down to the ones no prionvault_jc_file row still
    references — safe to actually delete from Dropbox. Call this AFTER
    the row(s) being removed are already gone from the table."""
    paths = [p for p in paths if p]
    if not paths:
        return []
    eng = _get_engine()
    with eng.connect() as conn:
        still_used = {r[0] for r in conn.execute(sql_text(
            "SELECT DISTINCT dropbox_path FROM prionvault_jc_file WHERE dropbox_path = ANY(:paths)"
        ), {"paths": paths}).all()}
    return [p for p in paths if p not in still_used]


# ── Files (multipart upload + temp link) ────────────────────────────────────

def add_file(presentation_id, *, content: bytes, filename: str) -> dict:
    """Upload one file and attach it to a presentation.

    Same presenter + same session date + same filename all hashing to
    the same Dropbox path (see _build_dropbox_path) is exactly what
    happens when one JC document covers several articles — a legitimate
    case, not a collision. When that path is already tracked by an
    earlier presentation, we skip re-uploading identical bytes to
    Dropbox and just add a new prionvault_jc_file row pointing at the
    same file, so every article keeps its own association."""
    if not content:
        raise ValueError("empty file")
    if len(content) > MAX_FILE_BYTES:
        raise ValueError(f"file too large (max {MAX_FILE_BYTES // (1024*1024)} MB)")
    if not filename:
        raise ValueError("missing filename")

    eng = _get_engine()
    with eng.connect() as conn:
        meta = conn.execute(sql_text(
            """SELECT presented_at, presenter_name
               FROM prionvault_jc_presentation WHERE id = :pid"""
        ), {"pid": str(presentation_id)}).first()
    if not meta:
        raise LookupError("presentation not found")
    presented_at, presenter_name = meta

    target = _build_dropbox_path(presented_at=presented_at,
                                 presenter_name=presenter_name,
                                 filename=filename)

    with eng.connect() as conn:
        existing = conn.execute(sql_text(
            """SELECT id, presentation_id, size_bytes, kind
                 FROM prionvault_jc_file WHERE dropbox_path = :dpath LIMIT 1"""
        ), {"dpath": target}).first()

    if existing:
        if str(existing.presentation_id) == str(presentation_id):
            # Already attached to this exact presentation — idempotent,
            # not an error (e.g. a retried request).
            return {"id": str(existing.id), "filename": filename,
                    "dropbox_path": target, "size_bytes": existing.size_bytes,
                    "kind": existing.kind}
        fid = str(uuid.uuid4())
        with eng.begin() as conn:
            conn.execute(sql_text(
                """INSERT INTO prionvault_jc_file
                   (id, presentation_id, filename, dropbox_path,
                    size_bytes, kind, uploaded_at)
                   VALUES (:id, :pid, :filename, :dpath, :size, :kind, NOW())"""
            ), {"id": fid, "pid": str(presentation_id), "filename": filename,
                "dpath": target, "size": existing.size_bytes, "kind": existing.kind})
        return {"id": fid, "filename": filename, "dropbox_path": target,
                "size_bytes": existing.size_bytes, "kind": existing.kind}

    # No existing row for this path — upload for real.
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
    """Delete one file's DB row. Only removes it from Dropbox once no
    OTHER row (a different article's presentation sharing the same
    document — see add_file) still points at that path."""
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
    _dropbox_delete_paths(_orphaned_paths([row[0]] if row[0] else []))
    return True


def get_file_info(file_id) -> Optional[dict]:
    """Filename/kind without touching Dropbox — for deciding how to
    render the /view wrapper page before fetching any bytes."""
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            "SELECT filename, kind FROM prionvault_jc_file WHERE id = :fid"
        ), {"fid": str(file_id)}).first()
    if not row:
        return None
    return {"filename": row[0], "kind": row[1]}


def get_or_convert_pdf(file_id) -> Optional[bytes]:
    """PDF bytes for a Word/Excel/PowerPoint JC file, converting via
    LibreOffice on first view and caching the result at
    "<dropbox_path>.pdf" so later opens skip the (few-second)
    conversion. Returns None if the file can't be fetched or
    converted."""
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            "SELECT dropbox_path, filename FROM prionvault_jc_file WHERE id = :fid"
        ), {"fid": str(file_id)}).first()
    if not row:
        return None
    dropbox_path, filename = row
    cache_path = dropbox_path + ".pdf"

    try:
        from core.dropbox_client import get_client
        client = get_client()
    except Exception:
        client = None

    if client is not None:
        try:
            _meta, resp = client.files_download(cache_path)
            return resp.content
        except Exception:
            pass   # not cached yet (or cache missing) — fall through to convert

    result = get_file_bytes(file_id)
    if not result:
        return None
    _, _, content = result
    pdf_bytes = convert_office_to_pdf(content, filename)
    if pdf_bytes and client is not None:
        try:
            import dropbox
            client.files_upload(pdf_bytes, cache_path,
                               mode=dropbox.files.WriteMode.overwrite, mute=True)
        except Exception as exc:
            logger.warning("get_or_convert_pdf: could not cache %s: %s", cache_path, exc)
    return pdf_bytes


def get_file_bytes(file_id) -> Optional[tuple]:
    """Download a JC file's bytes from Dropbox. Returns
    (filename, kind, content) or None on any failure."""
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            "SELECT dropbox_path, filename, kind FROM prionvault_jc_file WHERE id = :fid"
        ), {"fid": str(file_id)}).first()
    if not row:
        return None
    dropbox_path, filename, kind = row
    try:
        from core.dropbox_client import get_client
        client = get_client()
        if client is None:
            return None
        _meta, response = client.files_download(dropbox_path)
        return filename, kind, response.content
    except Exception as exc:
        logger.warning("jc: download failed for %s: %s", dropbox_path, exc)
        return None


def convert_office_to_pdf(content: bytes, filename: str) -> Optional[bytes]:
    """Render a Word/Excel/PowerPoint file to PDF via headless
    LibreOffice, so it can go through the same PDF.js viewer already
    used for real PDFs — external viewers (Office Online, Google Docs
    Viewer) turned out unreliable for arbitrary hosted files. Returns
    None on any failure (missing binary, corrupt file, timeout); the
    caller falls back to a download link.
    """
    import os
    import subprocess
    import tempfile

    ext = _ext_of(filename) or "bin"
    with tempfile.TemporaryDirectory(prefix="jc-oaconv-") as tmpdir:
        src = os.path.join(tmpdir, f"input.{ext}")
        with open(src, "wb") as f:
            f.write(content)
        profile_dir = os.path.join(tmpdir, "profile")
        try:
            subprocess.run(
                ["soffice", "--headless", "--norestore", "--nolockcheck",
                 f"-env:UserInstallation=file://{profile_dir}",
                 "--convert-to", "pdf", "--outdir", tmpdir, src],
                check=True, timeout=90, capture_output=True,
            )
        except FileNotFoundError:
            logger.warning("convert_office_to_pdf: soffice binary not found")
            return None
        except subprocess.TimeoutExpired:
            logger.warning("convert_office_to_pdf: timed out converting %s", filename)
            return None
        except subprocess.CalledProcessError as exc:
            logger.warning("convert_office_to_pdf: soffice failed for %s: %s",
                           filename, (exc.stderr or b"")[:500])
            return None
        out_path = os.path.join(tmpdir, "input.pdf")
        if not os.path.exists(out_path):
            logger.warning("convert_office_to_pdf: no output for %s", filename)
            return None
        with open(out_path, "rb") as f:
            return f.read()


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
