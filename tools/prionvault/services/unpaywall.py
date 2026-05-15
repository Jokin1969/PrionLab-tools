"""Unpaywall lookup + open-access PDF fetcher.

Given a DOI, ask Unpaywall whether the paper has an open-access version
and where to find a PDF. If yes, download it (with a size cap) so it can
be fed into the existing ingest queue and processed by the standard
pipeline (text extraction, metadata resolution against CrossRef, Dropbox
upload, dedup).

Unpaywall's free API requires an email parameter for politeness. The
endpoint reads it from the UNPAYWALL_EMAIL environment variable. No
extra API key.

Rate limit (well above what we'll ever hit): 100 000 requests/day.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

import requests

logger = logging.getLogger(__name__)

_API_BASE = "https://api.unpaywall.org/v2/"
_LOOKUP_TIMEOUT = 8.0
_DOWNLOAD_TIMEOUT = 30.0
# Hard ceiling on the PDF size; protects the worker from a malicious or
# misconfigured server serving gigabyte-sized "PDFs".
_MAX_PDF_BYTES = 60 * 1024 * 1024  # 60 MB

_USER_AGENT = (
    "PrionVault/1.0 (https://prionlab-tools.up.railway.app; "
    "open-access ingest)"
)


@dataclass
class UnpaywallResult:
    is_oa:       bool
    pdf_url:     Optional[str]    # direct PDF link, when available
    landing_url: Optional[str]    # landing page on the OA host
    host_type:   Optional[str]    # "publisher" | "repository"
    license:     Optional[str]
    version:     Optional[str]    # "publishedVersion" | "acceptedVersion" | …
    error:       Optional[str] = None


class NotConfigured(RuntimeError):
    """Raised when UNPAYWALL_EMAIL is not set."""


def _normalise_doi(doi: str) -> str:
    s = (doi or "").strip()
    if s.startswith("http"):
        s = s.split("doi.org/")[-1]
    return s.lower().rstrip(".,;:)")


def find_open_pdf(doi: str) -> UnpaywallResult:
    """Look up `doi` in Unpaywall. Returns is_oa + best PDF URL if any."""
    email = os.getenv("UNPAYWALL_EMAIL", "").strip()
    if not email:
        raise NotConfigured("UNPAYWALL_EMAIL is not set")
    doi = _normalise_doi(doi)
    if not doi:
        return UnpaywallResult(False, None, None, None, None, None,
                               error="empty DOI")

    try:
        r = requests.get(
            _API_BASE + doi,
            params={"email": email},
            timeout=_LOOKUP_TIMEOUT,
            headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
        )
    except Exception as exc:
        logger.warning("Unpaywall lookup failed for %s: %s", doi, exc)
        return UnpaywallResult(False, None, None, None, None, None,
                               error=f"network: {exc}")

    if r.status_code == 404:
        return UnpaywallResult(False, None, None, None, None, None,
                               error="not_in_unpaywall")
    if r.status_code != 200:
        return UnpaywallResult(False, None, None, None, None, None,
                               error=f"http_{r.status_code}")

    try:
        data = r.json() or {}
    except Exception:
        return UnpaywallResult(False, None, None, None, None, None,
                               error="invalid_json")

    is_oa = bool(data.get("is_oa"))
    best  = data.get("best_oa_location") or {}
    return UnpaywallResult(
        is_oa=is_oa,
        pdf_url=best.get("url_for_pdf"),
        landing_url=best.get("url"),
        host_type=best.get("host_type"),
        license=best.get("license"),
        version=best.get("version"),
    )


def download_pdf(url: str) -> bytes:
    """Download `url` and return its bytes, enforcing the size cap.

    Streams the response so a huge response can be aborted early. Raises
    on network errors, oversized payloads, and non-PDF content types.
    """
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/pdf,*/*"}
    with requests.get(url, headers=headers, timeout=_DOWNLOAD_TIMEOUT,
                       stream=True, allow_redirects=True) as r:
        r.raise_for_status()

        declared = r.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > _MAX_PDF_BYTES:
            raise ValueError(f"declared size {declared} bytes exceeds cap")

        ctype = (r.headers.get("content-type") or "").lower()
        # Some publishers serve PDFs as application/octet-stream; accept
        # that too, but reject obvious HTML landing pages.
        if "text/html" in ctype:
            raise ValueError(f"got HTML, not PDF (content-type: {ctype})")

        chunks: list[bytes] = []
        total = 0
        for chunk in r.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > _MAX_PDF_BYTES:
                raise ValueError("PDF exceeds size cap during download")
            chunks.append(chunk)

    body = b"".join(chunks)
    # Quick sanity check: PDFs start with %PDF-.
    if not body.startswith(b"%PDF"):
        raise ValueError("downloaded bytes are not a PDF (missing %PDF header)")
    return body
