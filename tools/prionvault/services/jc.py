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
import threading
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


_JC_OK_TAG_NAME = "Journal Club – Ok"


def tag_journal_club_ok(article_id, viewer_uid) -> None:
    """Ensure the shared 'Journal Club – Ok' tag exists and is attached
    to `article_id` for `viewer_uid`. Mirrors routes._tag_journal_club_ok
    (duplicated rather than imported, to avoid a services -> routes
    circular import); no-op if there's no viewer."""
    if not viewer_uid:
        return
    eng = _get_engine()
    with eng.begin() as conn:
        tag = conn.execute(sql_text(
            "SELECT id FROM article_tag WHERE lower(name) = lower(:n)"
        ), {"n": _JC_OK_TAG_NAME}).first()
        if tag:
            tag_id = tag[0]
        else:
            row = conn.execute(sql_text(
                """INSERT INTO article_tag (name, color, created_by)
                   VALUES (:n, :c, CAST(:uid AS uuid))
                   ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                   RETURNING id"""
            ), {"n": _JC_OK_TAG_NAME, "c": "#be185d", "uid": str(viewer_uid)}).first()
            tag_id = row[0]
        conn.execute(sql_text(
            """INSERT INTO article_tag_link (article_id, tag_id, added_by)
               VALUES (:aid, :tid, CAST(:uid AS uuid))
               ON CONFLICT (article_id, tag_id, added_by) DO NOTHING"""
        ), {"aid": str(article_id), "tid": tag_id, "uid": str(viewer_uid)})


_BULK_DATE_FOLDER_RE = re.compile(r"^(20\d{2})(\d{2})(\d{2})$")


def _find_or_create_presentation(*, article_id, presented_at: _date,
                                  presenter_name: str, created_by=None) -> tuple:
    """Idempotent presentation lookup for bulk import — reruns (a
    retried batch, a folder added to later) must not pile up duplicate
    presentation rows for the same article/presenter/date. Returns
    (presentation_id, was_newly_created)."""
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            """SELECT id FROM prionvault_jc_presentation
               WHERE article_id = :aid AND presented_at = :date
                 AND lower(presenter_name) = lower(:pname)
               LIMIT 1"""
        ), {"aid": str(article_id), "date": presented_at, "pname": presenter_name}).first()
    if row:
        return str(row[0]), False
    pres = create(article_id=article_id, presented_at=presented_at,
                  presenter_name=presenter_name, created_by=created_by)
    return pres["id"], True


def _attach_existing_dropbox_file(presentation_id, *, dropbox_path: str,
                                   filename: str, size_bytes: int) -> bool:
    """Point a prionvault_jc_file row at a file that's ALREADY sitting
    in Dropbox (the bulk-import case: the operator placed it there by
    hand, following the same naming convention _build_dropbox_path
    would produce). No download/upload involved — metadata only.
    Returns False if a row for this exact path+presentation already
    exists (rerun of a previous import)."""
    eng = _get_engine()
    with eng.connect() as conn:
        existing = conn.execute(sql_text(
            """SELECT id FROM prionvault_jc_file
               WHERE presentation_id = :pid AND dropbox_path = :dpath LIMIT 1"""
        ), {"pid": str(presentation_id), "dpath": dropbox_path}).first()
    if existing:
        return False
    with eng.begin() as conn:
        conn.execute(sql_text(
            """INSERT INTO prionvault_jc_file
               (id, presentation_id, filename, dropbox_path,
                size_bytes, kind, uploaded_at)
               VALUES (:id, :pid, :filename, :dpath, :size, :kind, NOW())"""
        ), {"id": str(uuid.uuid4()), "pid": str(presentation_id),
            "filename": filename, "dpath": dropbox_path,
            "size": size_bytes, "kind": _kind_for(filename)})
    return True


def bulk_import(presenter_name: str, *, created_by=None,
                 on_progress=None) -> dict:
    """Digest a presenter's pre-existing Dropbox folder tree instead of
    uploading each presentation one by one through the modal — built
    for the "we already have 250 of these sitting in Dropbox" case.

    Expects exactly the layout the operator places by hand:
        /PrionLab tools/Journal clubs/<presenter_name>/<yyyymmdd>/
            Article <anything>.pdf   (the paper — used ONLY to identify
                                       the article, never stored as a JC file)
            <anything else>          (the JC document(s) — pptx, etc.,
                                       attached as-is, no re-upload)

    For each date folder: downloads the Article PDF, extracts its
    DOI/PMID (same extractor Import PDFs uses) and MD5, and matches it
    against existing articles the same way find-article does. A folder
    whose article can't be identified is reported back (with its path)
    instead of silently skipped, so the operator knows exactly which
    folder needs a manual look. Reruns are safe: existing presentations
    and file rows are detected and left alone rather than duplicated.

    `on_progress(done, total)` is called after each date folder, if given
    — lets a background job report live progress.
    """
    from core.dropbox_client import get_client
    from ..ingestion.deduplicator import find_duplicate, md5_of
    from ..ingestion.pdf_extractor import extract_pdf

    client = get_client()
    if client is None:
        raise RuntimeError("dropbox not configured")

    base = f"/PrionLab tools/Journal clubs/{presenter_name}"
    try:
        listing = client.files_list_folder(base)
    except Exception as exc:
        raise RuntimeError(f"no se pudo abrir la carpeta '{base}': {exc}")
    date_folders = [e for e in listing.entries
                    if e.__class__.__name__ == "FolderMetadata"
                    and _BULK_DATE_FOLDER_RE.match(e.name)]

    created = 0
    reused = 0
    files_attached = 0
    unmatched = []          # [{folder, reason}]
    errors = []             # [{folder, error}]
    tagged_article_ids = set()   # articles that got a JC file attached — for "Journal Club – Ok"
    total = len(date_folders)

    for i, folder in enumerate(sorted(date_folders, key=lambda e: e.name)):
        yyyymmdd = folder.name
        folder_label = f"{presenter_name}/{yyyymmdd}"
        try:
            presented_at = _date(int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]))
        except ValueError:
            unmatched.append({"folder": folder_label, "reason": "nombre de carpeta no es una fecha válida"})
            if on_progress:
                on_progress(i + 1, total)
            continue

        try:
            sub = client.files_list_folder(folder.path_lower)
            files = [e for e in sub.entries if e.__class__.__name__ == "FileMetadata"]
            article_file = next((f for f in files
                                  if f.name.lower().startswith("article")
                                  and f.name.lower().endswith(".pdf")), None)
            if not article_file:
                unmatched.append({"folder": folder_label, "reason": "no se encontró 'Article ....pdf' en la carpeta"})
                if on_progress:
                    on_progress(i + 1, total)
                continue

            _meta, resp = client.files_download(article_file.path_lower)
            content = resp.content
            doi = pmid = None
            try:
                extracted = extract_pdf(content)
                doi, pmid = extracted.doi, extracted.pmid
            except Exception:
                pass
            aid, _reason = find_duplicate(doi=doi, pmid=pmid, pdf_md5=md5_of(content))
            if not aid:
                unmatched.append({"folder": folder_label, "reason": "artículo no encontrado en PrionVault (ni por DOI/PMID ni por contenido)"})
                if on_progress:
                    on_progress(i + 1, total)
                continue

            pres_id, was_created = _find_or_create_presentation(
                article_id=aid, presented_at=presented_at,
                presenter_name=presenter_name, created_by=created_by)
            if was_created:
                created += 1
            else:
                reused += 1

            other_files = [f for f in files if f is not article_file]
            for f in other_files:
                if _attach_existing_dropbox_file(
                        pres_id, dropbox_path=f.path_display,
                        filename=f.name, size_bytes=f.size):
                    files_attached += 1
                    tagged_article_ids.add(str(aid))
        except Exception as exc:
            logger.exception("jc bulk_import: folder %s failed", folder_label)
            errors.append({"folder": folder_label, "error": str(exc)[:300]})
        if on_progress:
            on_progress(i + 1, total)

    return {
        "presenter_name": presenter_name,
        "date_folders_seen": total,
        "presentations_created": created,
        "presentations_reused": reused,
        "files_attached": files_attached,
        "unmatched": unmatched,
        "errors": errors,
        "tagged_article_ids": sorted(tagged_article_ids),
    }


# ── Background job wrapper for bulk_import ──────────────────────────────────
# Mirrors services/batch_index.py's design: a single guarded background
# thread + an in-memory status snapshot polled by the frontend. A run of
# ~250 folders (Dropbox listing + one PDF download each) comfortably
# exceeds a normal request timeout, so this can't run inline in the route.
_bulk_state = {
    "running":       False,
    "presenter_name": None,
    "started_at":    None,
    "finished_at":   None,
    "done":          0,
    "total":         0,
    "result":        None,
    "error":         None,
}
_bulk_lock = threading.Lock()
_bulk_thread: Optional[threading.Thread] = None


def get_bulk_import_status() -> dict:
    with _bulk_lock:
        return dict(_bulk_state)


def start_bulk_import(presenter_name: str, *, created_by=None) -> Optional[dict]:
    global _bulk_thread
    with _bulk_lock:
        if _bulk_state["running"]:
            return None
        _bulk_state.update({
            "running":        True,
            "presenter_name": presenter_name,
            "started_at":     _datetime.utcnow().isoformat(),
            "finished_at":    None,
            "done":           0,
            "total":          0,
            "result":         None,
            "error":          None,
        })

    def _progress(done, total):
        with _bulk_lock:
            _bulk_state["done"] = done
            _bulk_state["total"] = total

    def _run():
        try:
            result = bulk_import(presenter_name, created_by=created_by, on_progress=_progress)
            for aid in result.get("tagged_article_ids", []):
                try:
                    tag_journal_club_ok(aid, created_by)
                except Exception:
                    logger.exception("jc bulk_import: failed to tag %s", aid)
            with _bulk_lock:
                _bulk_state["result"] = result
        except Exception as exc:
            logger.exception("jc bulk_import failed for %s", presenter_name)
            with _bulk_lock:
                _bulk_state["error"] = str(exc)[:500]
        finally:
            with _bulk_lock:
                _bulk_state["running"] = False
                _bulk_state["finished_at"] = _datetime.utcnow().isoformat()

    _bulk_thread = threading.Thread(target=_run, name="prionvault-jc-bulk-import", daemon=True)
    _bulk_thread.start()
    return get_bulk_import_status()


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
