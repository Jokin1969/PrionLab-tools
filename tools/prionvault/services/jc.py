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


def list_all() -> List[dict]:
    """Every JC presentation in the system, each carrying its parent
    article's usual fields — powers the management modal's full listing
    (client-side search/grouping/report) and the PDF report. The
    dataset is bounded by how many presentations actually exist (a
    lab's JC history, not the article library), so one unpaginated
    query is fine."""
    eng = _get_engine()
    with eng.connect() as conn:
        pres_rows = conn.execute(sql_text(
            """SELECT jp.id, jp.article_id, jp.presented_at, jp.presenter_name,
                      jp.presenter_id, jp.created_at, jp.created_by,
                      a.title, a.authors, a.journal, a.year, a.doi, a.pubmed_id,
                      (a.dropbox_path IS NOT NULL) AS has_pdf
                 FROM prionvault_jc_presentation jp
                 JOIN articles a ON a.id = jp.article_id
                ORDER BY jp.presented_at DESC, jp.created_at DESC"""
        )).mappings().all()
        if not pres_rows:
            return []
        pres_ids = [r["id"] for r in pres_rows]
        file_rows = conn.execute(sql_text(
            """SELECT id, presentation_id, filename, kind
               FROM prionvault_jc_file
               WHERE presentation_id = ANY(CAST(:pids AS uuid[]))
               ORDER BY uploaded_at ASC"""
        ), {"pids": [str(x) for x in pres_ids]}).mappings().all()

    files_by_pres: dict = {}
    for f in file_rows:
        files_by_pres.setdefault(str(f["presentation_id"]), []).append({
            "id": str(f["id"]), "filename": f["filename"], "kind": f["kind"],
        })
    return [{
        "id":             str(p["id"]),
        "article_id":     str(p["article_id"]),
        "presented_at":   p["presented_at"].isoformat() if p["presented_at"] else None,
        "presenter_name": p["presenter_name"],
        "article_title":  p["title"],
        "article_authors": p["authors"],
        "article_journal": p["journal"],
        "article_year":   p["year"],
        "article_doi":    p["doi"],
        "article_pmid":   p["pubmed_id"],
        "article_has_pdf": bool(p["has_pdf"]),
        "files":          files_by_pres.get(str(p["id"]), []),
    } for p in pres_rows]


def verify_dropbox_files() -> dict:
    """Check every prionvault_jc_file row against live Dropbox state.

    A row only stores dropbox_path (built from presenter/date/filename
    at upload time — see _build_dropbox_path); there's no Dropbox file
    id to follow. So a rename or move done directly in Dropbox after
    linking breaks the stored path silently — files_get_metadata on
    that exact path then 404s. That's the "orphan" this catches:
    presentations that look complete in PrionVault but whose file no
    longer exists where the DB thinks it does.
    """
    from core.dropbox_client import get_client
    import dropbox

    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT jf.id, jf.filename, jf.dropbox_path,
                      jp.presented_at, jp.presenter_name, a.title AS article_title
                 FROM prionvault_jc_file jf
                 JOIN prionvault_jc_presentation jp ON jp.id = jf.presentation_id
                 JOIN articles a ON a.id = jp.article_id
                ORDER BY jp.presented_at DESC"""
        )).mappings().all()

    client = get_client()
    if client is None:
        raise RuntimeError("Dropbox no está configurado en este servidor.")

    missing = []
    for r in rows:
        try:
            client.files_get_metadata(r["dropbox_path"])
        except dropbox.exceptions.ApiError:
            missing.append({
                "file_id":        str(r["id"]),
                "filename":       r["filename"],
                "dropbox_path":   r["dropbox_path"],
                "presented_at":   r["presented_at"].isoformat() if r["presented_at"] else None,
                "presenter_name": r["presenter_name"],
                "article_title":  r["article_title"],
            })

    return {"checked": len(rows), "missing": missing}


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


def _article_title(article_id) -> Optional[str]:
    """Best-effort title lookup for the bulk-import report — a folder
    the operator can recognize is a lot more useful than a bare UUID."""
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(sql_text(
                "SELECT title FROM articles WHERE id = :aid"
            ), {"aid": str(article_id)}).first()
        return row[0] if row else None
    except Exception:
        return None


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
    matched = []            # [{folder, article_id, article_title, ...}] — the "went well" report
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
            doi = pmid = title_hint = None
            try:
                extracted = extract_pdf(content)
                doi, pmid, title_hint = extracted.doi, extracted.pmid, extracted.title_hint
            except Exception:
                pass
            aid, _reason = find_duplicate(doi=doi, pmid=pmid, pdf_md5=md5_of(content))
            if not aid and not doi and not pmid and title_hint:
                # Same rescue Import PDFs gets from resolve_metadata: some
                # publishers (PLOS in particular — its DOI rides the running
                # header/footer, which pdfplumber can mangle just enough to
                # defeat every DOI regex) never yield a usable DOI/PMID from
                # the PDF text at all. A CrossRef title search recovers the
                # DOI in that case, which then hits the same lookup below.
                try:
                    from ..ingestion.metadata_resolver import resolve_metadata
                    resolved = resolve_metadata(title_hint=title_hint)
                    if resolved and resolved.doi:
                        aid, _reason = find_duplicate(doi=resolved.doi)
                except Exception:
                    logger.debug("bulk_import: title-hint DOI resolution failed for %s",
                                 folder_label, exc_info=True)
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
            n_attached = 0
            for f in other_files:
                if _attach_existing_dropbox_file(
                        pres_id, dropbox_path=f.path_display,
                        filename=f.name, size_bytes=f.size):
                    files_attached += 1
                    n_attached += 1
                    tagged_article_ids.add(str(aid))

            matched.append({
                "folder": folder_label,
                "article_id": str(aid),
                "article_title": _article_title(aid),
                "matched_by": _reason,
                "presentation_status": "creada" if was_created else "ya existía",
                "files_attached": n_attached,
            })
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
        "matched": matched,
        "unmatched": unmatched,
        "errors": errors,
        "tagged_article_ids": sorted(tagged_article_ids),
    }


def _html_escape(s) -> str:
    if s is None:
        return ""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
                  .replace(">", "&gt;").replace('"', "&quot;"))


def render_report_pdf(*, group_by: str = "year_presenter",
                       scope: Optional[str] = None,
                       scope_value: Optional[str] = None) -> bytes:
    """Build the full Journal Club report as a PDF via ReportLab.

    Deliberately NOT WeasyPrint: it needs Pango/Cairo/GLib/HarfBuzz as
    native shared libraries, which repeatedly failed to resolve at
    runtime on Railway's nixpacks image (OSError: cannot load library
    'libgobject-2.0-0') even after adding the corresponding nixPkgs —
    nixpacks doesn't reliably put every declared package's lib output
    on the dynamic linker's search path. ReportLab is pure Python
    (no native deps at all), so it sidesteps the problem entirely.

    group_by: "year_presenter" (año → responsable) or "presenter_year"
              (responsable → año) — controls the two-level grouping.
    scope / scope_value: None for the complete report, or
              scope="year" with scope_value="2023", or
              scope="presenter" with scope_value="Carlos Díaz" to
              restrict it to one year / one presenter.
    """
    from io import BytesIO
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer,
                                     Table, TableStyle)

    items = list_all()
    if scope == "year" and scope_value:
        items = [x for x in items if str(x.get("article_year") or "") == str(scope_value)]
    elif scope == "presenter" and scope_value:
        items = [x for x in items if (x.get("presenter_name") or "").strip().lower()
                 == scope_value.strip().lower()]

    def _year_of(x):
        return x.get("article_year") or "Sin año"

    def _presenter_of(x):
        return x.get("presenter_name") or "Sin responsable"

    outer_key, inner_key = ((_year_of, _presenter_of) if group_by == "year_presenter"
                             else (_presenter_of, _year_of))

    groups: dict = {}
    for x in items:
        groups.setdefault(outer_key(x), {}).setdefault(inner_key(x), []).append(x)

    def _sort_outer(k):
        # Years sort numerically descending; presenter names alphabetically.
        try:
            return (0, -int(k))
        except (TypeError, ValueError):
            return (1, str(k))

    def _xml_escape(s) -> str:
        # ReportLab Paragraphs use a small XML-like markup, not raw HTML —
        # angle brackets/ampersands must be escaped the same way, but we
        # also feed it deliberate <link> tags below, so escape only the
        # dynamic bits, never the markup we build ourselves.
        return _html_escape(s)

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("jc_h1", parent=styles["Title"], fontSize=18,
                         textColor=colors.HexColor("#831843"), spaceAfter=2)
    subtitle = ParagraphStyle("jc_subtitle", parent=styles["Normal"], fontSize=10,
                               textColor=colors.HexColor("#6b7280"), spaceAfter=16)
    h2 = ParagraphStyle("jc_h2", parent=styles["Heading2"], fontSize=14,
                         textColor=colors.HexColor("#be185d"), spaceBefore=16, spaceAfter=4)
    h3 = ParagraphStyle("jc_h3", parent=styles["Heading3"], fontSize=11.5,
                         textColor=colors.HexColor("#831843"), spaceBefore=8, spaceAfter=3)
    cell = ParagraphStyle("jc_cell", parent=styles["Normal"], fontSize=9, leading=11)
    empty = ParagraphStyle("jc_empty", parent=styles["Normal"], fontSize=11,
                            textColor=colors.HexColor("#9ca3af"))

    scope_label = ""
    if scope == "year" and scope_value:
        scope_label = f" — Año {scope_value}"
    elif scope == "presenter" and scope_value:
        scope_label = f" — {scope_value}"

    story = [
        Paragraph("Informe de Journal Club", h1),
        Paragraph(
            f"PrionVault{_xml_escape(scope_label)} · {len(items)} presentación(es) · "
            f"Agrupado por {'año &#8594; responsable' if group_by == 'year_presenter' else 'responsable &#8594; año'}",
            subtitle,
        ),
    ]

    if not items:
        story.append(Paragraph("No hay presentaciones que mostrar.", empty))

    header_row = [Paragraph(t, cell) for t in
                  ("<b>Fecha</b>", "<b>Artículo</b>", "<b>Autores</b>",
                   "<b>Revista</b>", "<b>Año</b>", "<b>DOI / PMID</b>")]
    col_widths = [2.1*cm, 7.5*cm, 5.5*cm, 4*cm, 1.3*cm, 4.2*cm]

    for outer in sorted(groups.keys(), key=_sort_outer):
        story.append(Paragraph(_xml_escape(outer), h2))
        inner_groups = groups[outer]
        for inner in sorted(inner_groups.keys(), key=_sort_outer):
            story.append(Paragraph(_xml_escape(inner), h3))
            rows = sorted(inner_groups[inner], key=lambda x: x.get("presented_at") or "")
            table_data = [header_row]
            for x in rows:
                if x.get("article_doi"):
                    doi = _xml_escape(x["article_doi"])
                    ident = f'<link href="https://doi.org/{doi}" color="#1d4ed8">DOI: {doi}</link>'
                elif x.get("article_pmid"):
                    pmid = _xml_escape(x["article_pmid"])
                    ident = f'<link href="https://pubmed.ncbi.nlm.nih.gov/{pmid}/" color="#1d4ed8">PMID: {pmid}</link>'
                else:
                    ident = "—"
                table_data.append([
                    Paragraph(_xml_escape(x.get("presented_at") or "—"), cell),
                    Paragraph(_xml_escape(x.get("article_title") or "(sin título)"), cell),
                    Paragraph(_xml_escape(x.get("article_authors") or "—"), cell),
                    Paragraph(_xml_escape(x.get("article_journal") or "—"), cell),
                    Paragraph(_xml_escape(x.get("article_year") or "—"), cell),
                    Paragraph(ident, cell),
                ])
            table = Table(table_data, colWidths=col_widths, repeatRows=1)
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#fdf2f8")),
                ("LINEBELOW", (0, 0), (-1, 0), 1, colors.HexColor("#d1d5db")),
                ("LINEBELOW", (0, 1), (-1, -1), 0.5, colors.HexColor("#f3f4f6")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fdf2f8")]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]))
            story.append(table)
            story.append(Spacer(1, 8))

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4),
                             topMargin=1.5*cm, bottomMargin=1.5*cm,
                             leftMargin=1.5*cm, rightMargin=1.5*cm,
                             title="Informe Journal Club")
    doc.build(story)
    return buf.getvalue()


# ── Background job wrapper for bulk_import ──────────────────────────────────
# Status is persisted to the shared `admin_background_job` table (see
# migrations/069_admin_background_jobs.sql) rather than kept in an
# in-process dict: gunicorn runs multiple worker processes (--workers 2),
# and a status-poll request can land on a different worker than the one
# that started the background thread — which would never see an
# in-memory-only registry, silently showing no report at all. A single
# fixed job id is enough since only one JC bulk import is meant to run
# at a time; `stage` doubles as the "done/total" progress counter and
# `filename` as the presenter name, reusing the generic columns rather
# than adding JC-specific ones.
_BULK_JOB_ID = "jc_bulk_import"
_bulk_thread: Optional[threading.Thread] = None


def _bulk_job_row() -> Optional[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            """SELECT status, stage, filename, result, error, started_at, finished_at
                 FROM admin_background_job WHERE id = :id"""
        ), {"id": _BULK_JOB_ID}).mappings().first()
    return dict(row) if row else None


def get_bulk_import_status() -> dict:
    row = _bulk_job_row()
    if not row:
        return {"running": False, "presenter_name": None, "started_at": None,
                "finished_at": None, "done": 0, "total": 0, "result": None, "error": None}
    done, total = 0, 0
    if row.get("stage") and "/" in row["stage"]:
        try:
            done, total = (int(x) for x in row["stage"].split("/", 1))
        except ValueError:
            pass
    return {
        "running":        row["status"] == "running",
        "presenter_name": row.get("filename"),
        "started_at":     row["started_at"].isoformat() if row.get("started_at") else None,
        "finished_at":    row["finished_at"].isoformat() if row.get("finished_at") else None,
        "done":           done,
        "total":          total,
        "result":         row.get("result"),
        "error":          row.get("error"),
    }


def start_bulk_import(presenter_name: str, *, created_by=None) -> Optional[dict]:
    global _bulk_thread
    eng = _get_engine()
    with eng.begin() as conn:
        existing = conn.execute(sql_text(
            "SELECT status FROM admin_background_job WHERE id = :id"
        ), {"id": _BULK_JOB_ID}).first()
        if existing and existing[0] == "running":
            return None
        conn.execute(sql_text(
            """INSERT INTO admin_background_job
                   (id, kind, status, stage, filename, result, error, started_at, finished_at)
               VALUES (:id, 'jc_bulk_import', 'running', '0/0', :pname, NULL, NULL, NOW(), NULL)
               ON CONFLICT (id) DO UPDATE SET
                   status = 'running', stage = '0/0', filename = :pname,
                   result = NULL, error = NULL, started_at = NOW(), finished_at = NULL"""
        ), {"id": _BULK_JOB_ID, "pname": presenter_name})

    def _progress(done, total):
        try:
            with eng.begin() as conn:
                conn.execute(sql_text(
                    "UPDATE admin_background_job SET stage = :stage WHERE id = :id"
                ), {"id": _BULK_JOB_ID, "stage": f"{done}/{total}"})
        except Exception:
            logger.exception("jc bulk_import: progress update failed")

    def _run():
        import json as _json
        try:
            result = bulk_import(presenter_name, created_by=created_by, on_progress=_progress)
            for aid in result.get("tagged_article_ids", []):
                try:
                    tag_journal_club_ok(aid, created_by)
                except Exception:
                    logger.exception("jc bulk_import: failed to tag %s", aid)
            with eng.begin() as conn:
                conn.execute(sql_text(
                    """UPDATE admin_background_job
                       SET status = 'done', result = :result, finished_at = NOW()
                       WHERE id = :id"""
                ), {"id": _BULK_JOB_ID, "result": _json.dumps(result)})
        except Exception as exc:
            logger.exception("jc bulk_import failed for %s", presenter_name)
            with eng.begin() as conn:
                conn.execute(sql_text(
                    """UPDATE admin_background_job
                       SET status = 'error', error = :error, finished_at = NOW()
                       WHERE id = :id"""
                ), {"id": _BULK_JOB_ID, "error": str(exc)[:500]})

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
