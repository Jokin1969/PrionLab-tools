"""ORCID public API integration — no authentication needed for public profiles."""
import logging
from typing import Dict, List

import requests

logger = logging.getLogger(__name__)

ORCID_BASE = "https://pub.orcid.org/v3.0"
_HEADERS = {"Accept": "application/json"}

_ORCID_TYPE_MAP = {
    "journal-article": "article",
    "review-article": "review",
    "preprint": "preprint",
    "book-chapter": "book_chapter",
    "conference-paper": "conference",
    "conference-abstract": "conference",
}


def _map_type(orcid_type: str) -> str:
    return _ORCID_TYPE_MAP.get(orcid_type, "other")


def _extract_ext_id(ext_ids: list, id_type: str) -> str:
    for eid in (ext_ids or []):
        if eid.get("external-id-type") == id_type:
            return (eid.get("external-id-value") or "").strip()
    return ""


def _str_value(obj) -> str:
    if isinstance(obj, dict):
        return (obj.get("value") or "").strip()
    return str(obj).strip() if obj else ""


def fetch_orcid_works(orcid: str, timeout: int = 15) -> Dict:
    """Fetch all works from a public ORCID profile.

    Returns {"success": bool, "works": [...], "count": int, "error": str|None}
    Each work: put_code, title, year, journal, doi, pmid, pub_type, orcid_work_id
    """
    orcid = orcid.strip()
    url = f"{ORCID_BASE}/{orcid}/works"
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=timeout)
        if resp.status_code == 404:
            return {"success": False, "error": "ORCID profile not found", "works": [], "count": 0}
        resp.raise_for_status()
        data = resp.json()
    except requests.Timeout:
        return {"success": False, "error": "ORCID API timeout", "works": [], "count": 0}
    except requests.RequestException as e:
        return {"success": False, "error": f"ORCID API error: {e}", "works": [], "count": 0}
    except Exception as e:
        return {"success": False, "error": str(e), "works": [], "count": 0}

    works: List[Dict] = []
    for group in (data.get("group") or []):
        summaries = group.get("work-summary") or []
        if not summaries:
            continue
        s = summaries[0]

        put_code = str(s.get("put-code", ""))
        title = _str_value((s.get("title") or {}).get("title"))

        pub_date = s.get("publication-date") or {}
        year = _str_value(pub_date.get("year"))

        journal = _str_value(s.get("journal-title"))

        ext_ids = (s.get("external-ids") or {}).get("external-id") or []
        doi = _extract_ext_id(ext_ids, "doi")
        pmid = _extract_ext_id(ext_ids, "pmid")

        works.append({
            "put_code": put_code,
            "title": title,
            "year": year,
            "journal": journal,
            "doi": doi,
            "pmid": pmid,
            "pub_type": _map_type(s.get("type", "")),
            "orcid_work_id": f"{orcid}:{put_code}",
        })

    return {"success": True, "works": works, "count": len(works), "error": None}
