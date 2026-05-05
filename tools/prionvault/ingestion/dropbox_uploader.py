"""Upload a PDF to the canonical PrionVault location in Dropbox.

Layout decided with the user:
    /PrionLab tools/PrionVault/<year>/<doi-slug>.pdf
    /PrionLab tools/PrionVault/unknown/<md5>.pdf       (fallback when no DOI/year)

Both PrionVault and PrionRead read this same path. PrionRead just
references the row by article_id; the PDF lives once.

Wraps the existing core/dropbox_client.py thin SDK wrapper.
"""
from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class UploadResult:
    dropbox_path: str          # e.g. /PrionVault/2007/10.1126_science.1138181.pdf
    dropbox_link: Optional[str]  # shareable link (best-effort)
    size_bytes:   int
    error:        Optional[str] = None


def _doi_to_slug(doi: str) -> str:
    """Convert a DOI to a filesystem-safe slug.

    `10.1093/brain/awn122` -> `10.1093_brain_awn122`
    """
    s = doi.lower()
    # Replace path separators and any character not in the safe set.
    s = re.sub(r"[^a-z0-9._-]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("._-")
    return s[:200] or "unknown"


def build_path(*, doi: Optional[str], year: Optional[int],
               md5: Optional[str], filename_hint: Optional[str] = None) -> str:
    """Compute the canonical Dropbox path for a paper.

    DOI + year known    -> /PrionLab tools/PrionVault/<year>/<doi-slug>.pdf
    Year known, no DOI  -> /PrionLab tools/PrionVault/<year>/<md5>.pdf
    Nothing known       -> /PrionLab tools/PrionVault/unknown/<md5_or_filename>.pdf
    """
    if year:
        year_str = str(year)
    else:
        year_str = "unknown"

    if doi:
        name = _doi_to_slug(doi) + ".pdf"
    elif md5:
        name = md5 + ".pdf"
    elif filename_hint:
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename_hint).strip("._-")
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
    else:
        name = "unknown.pdf"

    return f"/PrionLab tools/PrionVault/{year_str}/{name}"


def upload_pdf(content: bytes, target_path: str,
               overwrite: bool = False) -> UploadResult:
    """Upload `content` to `target_path` in Dropbox.

    `overwrite=False` (default): if the path already exists Dropbox returns
    a conflict error and we surface it via `.error`. The caller (worker)
    should check existence in the DB first via the deduplicator.

    `overwrite=True`: replace the existing file. Used by the migration
    script when re-locating PrionRead's old PDFs.
    """
    try:
        from core.dropbox_client import get_client
        import dropbox
    except Exception as exc:
        return UploadResult(dropbox_path="", dropbox_link=None,
                            size_bytes=0, error=f"dropbox client unavailable: {exc}")

    client = get_client()
    if client is None:
        return UploadResult(dropbox_path="", dropbox_link=None,
                            size_bytes=0, error="dropbox not configured")

    try:
        mode = (dropbox.files.WriteMode.overwrite
                if overwrite else dropbox.files.WriteMode.add)
        meta = client.files_upload(content, target_path, mode=mode,
                                   autorename=False, mute=True)
        link = _try_create_shared_link(client, target_path)
        return UploadResult(
            dropbox_path=meta.path_display or target_path,
            dropbox_link=link,
            size_bytes=meta.size if hasattr(meta, "size") else len(content),
        )
    except dropbox.exceptions.ApiError as exc:
        # Common case: file already exists — still useful info to surface.
        return UploadResult(dropbox_path=target_path, dropbox_link=None,
                            size_bytes=len(content),
                            error=f"dropbox api error: {exc}")
    except Exception as exc:
        logger.warning("Dropbox upload failed for %s: %s", target_path, exc)
        return UploadResult(dropbox_path=target_path, dropbox_link=None,
                            size_bytes=len(content), error=str(exc)[:300])


def copy_path(src: str, dst: str, overwrite: bool = False) -> Optional[str]:
    """Server-side copy from `src` to `dst` (used by the migration).

    Returns the new path on success, or None on failure.
    """
    try:
        from core.dropbox_client import get_client
        import dropbox
    except Exception as exc:
        logger.warning("Dropbox client unavailable for copy: %s", exc)
        return None

    client = get_client()
    if client is None:
        return None

    try:
        if overwrite:
            try:
                client.files_delete_v2(dst)
            except Exception:
                pass
        result = client.files_copy_v2(src, dst, autorename=False)
        return getattr(result.metadata, "path_display", dst)
    except dropbox.exceptions.ApiError as exc:
        logger.warning("Dropbox copy %s -> %s failed: %s", src, dst, exc)
        return None


def move_path(src: str, dst: str, overwrite: bool = False) -> Optional[str]:
    """Server-side move (rename). Returns the new path or None."""
    try:
        from core.dropbox_client import get_client
        import dropbox
    except Exception as exc:
        logger.warning("Dropbox client unavailable for move: %s", exc)
        return None

    client = get_client()
    if client is None:
        return None
    try:
        if overwrite:
            try:
                client.files_delete_v2(dst)
            except Exception:
                pass
        result = client.files_move_v2(src, dst, autorename=False)
        return getattr(result.metadata, "path_display", dst)
    except dropbox.exceptions.ApiError as exc:
        logger.warning("Dropbox move %s -> %s failed: %s", src, dst, exc)
        return None


def _try_create_shared_link(client, path: str) -> Optional[str]:
    try:
        import dropbox
        # If a link already exists Dropbox raises and lets us retrieve it.
        try:
            link_meta = client.sharing_create_shared_link_with_settings(path)
            return link_meta.url
        except dropbox.exceptions.ApiError:
            existing = client.sharing_list_shared_links(path=path,
                                                       direct_only=True).links
            if existing:
                return existing[0].url
    except Exception as exc:
        logger.debug("could not produce shared link for %s: %s", path, exc)
    return None
