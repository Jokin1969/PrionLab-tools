"""OpenAlex lookup — a second open-access source, alongside Unpaywall.

OpenAlex (https://openalex.org) aggregates metadata and open-access
location links harvested from CORE, BASE, PMC, institutional
repositories and publisher OA feeds. No API key needed — just a polite
`mailto` query param, so this reuses the same UNPAYWALL_EMAIL contact
address rather than requiring a second env var.

A paper Unpaywall doesn't know about (or has no OA location for)
sometimes DOES have one indexed here, since OpenAlex harvests a wider
set of repositories. Used as the second automatic leg of the on-demand
"🔓 Buscar PDF" flow in oa_pdf_fetcher.try_now() — Unpaywall first, then
this, before falling back to "ask the corresponding author".
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

import requests

logger = logging.getLogger(__name__)

_API_BASE = "https://api.openalex.org/works/doi:"
_TIMEOUT = 8.0
_USER_AGENT = (
    "PrionVault/1.0 (https://prionlab-tools.up.railway.app; "
    "open-access ingest)"
)


@dataclass
class OpenAlexResult:
    is_oa:       bool
    pdf_url:     Optional[str]
    landing_url: Optional[str]
    host_type:   Optional[str]   # "repository" | "publisher" | …
    error:       Optional[str] = None


def _normalise_doi(doi: str) -> str:
    s = (doi or "").strip()
    if s.startswith("http"):
        s = s.split("doi.org/")[-1]
    return s.lower().rstrip(".,;:)")


def find_open_pdf(doi: str) -> OpenAlexResult:
    """Look up `doi` in OpenAlex. Returns is_oa + best PDF URL if any."""
    doi = _normalise_doi(doi)
    if not doi:
        return OpenAlexResult(False, None, None, None, error="empty DOI")

    email = os.getenv("UNPAYWALL_EMAIL", "").strip() or os.getenv("OPENALEX_EMAIL", "").strip()
    params = {"mailto": email} if email else {}

    try:
        r = requests.get(
            _API_BASE + doi,
            params=params,
            timeout=_TIMEOUT,
            headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
        )
    except Exception as exc:
        logger.warning("OpenAlex lookup failed for %s: %s", doi, exc)
        return OpenAlexResult(False, None, None, None, error=f"network: {exc}")

    if r.status_code == 404:
        return OpenAlexResult(False, None, None, None, error="not_in_openalex")
    if r.status_code != 200:
        return OpenAlexResult(False, None, None, None, error=f"http_{r.status_code}")

    try:
        data = r.json() or {}
    except Exception:
        return OpenAlexResult(False, None, None, None, error="invalid_json")

    oa = data.get("open_access") or {}
    best = data.get("best_oa_location") or {}
    is_oa = bool(oa.get("is_oa"))
    pdf_url = best.get("pdf_url") or (oa.get("oa_url") if is_oa else None)

    return OpenAlexResult(
        is_oa=is_oa,
        pdf_url=pdf_url,
        landing_url=best.get("landing_page_url"),
        host_type=best.get("type"),
    )


def download_pdf(url: str) -> bytes:
    """Same download+validation contract as unpaywall.download_pdf —
    the PDF fetch itself is provider-agnostic, so just reuse it."""
    from . import unpaywall
    return unpaywall.download_pdf(url)
