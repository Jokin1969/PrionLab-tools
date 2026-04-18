"""ORCID-first bulk lab publication importer."""
import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# Neurodegeneration research keywords for relevance scoring
_NEURO_KEYWORDS: Set[str] = {
    "prion", "prion protein", "prp", "prion disease",
    "neurodegeneration", "neurodegenerative",
    "alzheimer", "parkinson", "huntington",
    "alpha-synuclein", "tau protein", "amyloid",
    "protein misfolding", "protein aggregation",
    "creutzfeldt-jakob", "cjd", "bse", "scrapie",
    "fatal familial insomnia", "brain pathology",
    "neuropathology", "cerebrospinal fluid",
    "neuroinflammation", "microglia",
    "autophagy", "neuroprotection", "biomarkers",
}

_NEURO_JOURNALS: Set[str] = {
    "nature neuroscience", "neuron", "brain",
    "acta neuropathologica", "journal of neuroscience",
    "molecular neurodegeneration", "alzheimer", "prion",
    "neurodegeneration", "jama neurology", "annals of neurology",
}


@dataclass
class LabMember:
    """Lab member information for bulk import."""
    name: str
    orcid_id: str
    email: str = ""
    role: str = "researcher"
    active: bool = True


@dataclass
class ImportResult:
    """Result from a lab import operation."""
    success: bool
    publications_found: int
    publications_imported: int
    duplicates_found: int
    errors: List[str]
    lab_collaborations: int
    external_collaborations: int
    processed_members: List[str]


class ORCIDLabImporter:
    """Import all lab publications from team ORCID profiles."""

    def __init__(self):
        pass  # lazy-import API clients on use

    async def import_full_lab(
        self,
        principal_investigator: LabMember,
        lab_members: List[LabMember],
        years_back: int = 10,
        min_relevance_score: float = 0.3,
    ) -> ImportResult:
        from tools.external_apis.orcid_client import get_orcid_client

        all_members = [principal_investigator] + lab_members
        all_pubs: Dict[str, Dict] = {}
        processed: List[str] = []
        errors: List[str] = []

        client = get_orcid_client()
        async with client:
            for member in all_members:
                try:
                    logger.info("Processing %s (%s)", member.name, member.orcid_id)
                    member_pubs = await self._import_member(client, member, years_back, min_relevance_score)

                    for key, pub in member_pubs.items():
                        if key in all_pubs:
                            all_pubs[key]["authors"].add(member.name)
                            all_pubs[key]["lab_members"].add(member.name)
                        else:
                            pub["lab_members"] = {member.name}
                            all_pubs[key] = pub

                    processed.append(member.name)
                    await asyncio.sleep(1.0)

                except Exception as exc:
                    msg = f"Error processing {member.name}: {exc}"
                    logger.error(msg)
                    errors.append(msg)

        lab_collabs = external_collabs = imported = 0
        for key, pub in all_pubs.items():
            if len(pub["lab_members"]) > 1:
                lab_collabs += 1
            else:
                external_collabs += 1
            try:
                if _save_publication(pub):
                    imported += 1
            except Exception as exc:
                errors.append(f"Save error for '{pub.get('title', '?')}': {exc}")

        return ImportResult(
            success=len(errors) < max(1, len(all_pubs)) * 0.5,
            publications_found=len(all_pubs),
            publications_imported=imported,
            duplicates_found=len(all_pubs) - imported,
            errors=errors,
            lab_collaborations=lab_collabs,
            external_collaborations=external_collabs,
            processed_members=processed,
        )

    async def _import_member(
        self, client, member: LabMember, years_back: int, min_relevance: float
    ) -> Dict[str, Dict]:
        cutoff = datetime.now().year - years_back
        pubs: Dict[str, Dict] = {}

        resp = await client.get_person_works(member.orcid_id)
        if not resp.success:
            logger.warning("get_person_works failed for %s: %s", member.name, resp.error)
            return {}

        for work in resp.data or []:
            try:
                year = work.get("year")
                if year and year < cutoff:
                    continue

                # Try to get full details for this work
                detail: Dict = work.copy()
                put_code = work.get("put_code")
                if put_code:
                    dr = await client.get_work_details(member.orcid_id, put_code)
                    if dr.success and dr.data:
                        detail.update(dr.data)
                    await asyncio.sleep(0.2)

                score = _relevance_score(detail)
                if score < min_relevance:
                    continue

                key = _pub_key(detail)
                if key:
                    pubs[key] = {
                        "title": detail.get("title", ""),
                        "year": detail.get("year"),
                        "journal": detail.get("journal", ""),
                        "doi": detail.get("doi", ""),
                        "abstract": detail.get("abstract", ""),
                        "authors": {member.name},
                        "pub_type": _map_type(detail.get("type", "")),
                        "relevance_score": score,
                        "source": f"orcid:{member.orcid_id}",
                    }

            except Exception as exc:
                logger.debug("Skip work for %s: %s", member.name, exc)

        return pubs


def _relevance_score(work: Dict) -> float:
    text = " ".join([
        work.get("title", ""),
        work.get("abstract", ""),
        work.get("journal", ""),
    ]).lower()
    if not text.strip():
        return 0.0
    matches = sum(1 for kw in _NEURO_KEYWORDS if kw in text)
    score = (matches / len(_NEURO_KEYWORDS)) * 0.7
    for j in _NEURO_JOURNALS:
        if j in work.get("journal", "").lower():
            score += 0.3
            break
    for kw in {"prion", "neurodegeneration", "alzheimer", "parkinson"}:
        if kw in work.get("title", "").lower():
            score += 0.15
    return min(score, 1.0)


def _pub_key(work: Dict) -> Optional[str]:
    doi = (work.get("doi") or "").strip()
    if doi:
        return f"doi:{doi}"
    title = (work.get("title") or "").strip()
    year = work.get("year")
    if title and year:
        slug = " ".join(re.sub(r"[^\w\s]", "", title.lower()).split()[:5])
        return f"title:{year}:{slug}"
    return None


def _map_type(orcid_type: str) -> str:
    mapping = {
        "JOURNAL_ARTICLE": "article",
        "BOOK_CHAPTER": "book_chapter",
        "BOOK": "book",
        "CONFERENCE_PAPER": "conference",
        "REVIEW": "review",
        "PREPRINT": "preprint",
    }
    return mapping.get(orcid_type.upper(), "article")


def _save_publication(pub: Dict) -> bool:
    """Save publication — tries DB model, falls back to CSV."""
    title = (pub.get("title") or "").strip()
    if not title:
        return False

    # DB path
    try:
        from database.config import db
        if db.is_configured():
            from database.models import Publication
            with db.get_session() as s:
                # Duplicate check by DOI
                doi = pub.get("doi", "")
                if doi:
                    exists = s.query(Publication).filter_by(doi=doi).first()
                    if exists:
                        return False  # Skip duplicate
                p = Publication(
                    title=title,
                    authors="; ".join(pub.get("authors", set())),
                    journal=pub.get("journal", ""),
                    year=pub.get("year"),
                    doi=doi,
                    abstract=pub.get("abstract", ""),
                    pub_type=pub.get("pub_type", "article"),
                )
                if hasattr(p, "update_search_vector"):
                    p.update_search_vector()
                s.add(p)
            logger.debug("DB-saved: %s", title[:60])
            return True
    except Exception as exc:
        logger.debug("DB save failed, trying CSV: %s", exc)

    # CSV fallback
    return _csv_save(pub)


def _csv_save(pub: Dict) -> bool:
    import csv, os
    try:
        import config
        csv_dir = config.DATA_DIR
    except Exception:
        csv_dir = "data"
    os.makedirs(csv_dir, exist_ok=True)
    csv_path = os.path.join(csv_dir, "lab_imports.csv")
    fieldnames = ["title", "authors", "journal", "year", "doi", "abstract", "pub_type", "source"]
    exists = os.path.exists(csv_path)
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore",
                                quoting=csv.QUOTE_ALL)
        if not exists:
            writer.writeheader()
        writer.writerow({
            "title": pub.get("title", ""),
            "authors": "; ".join(pub.get("authors", set())),
            "journal": pub.get("journal", ""),
            "year": pub.get("year", ""),
            "doi": pub.get("doi", ""),
            "abstract": pub.get("abstract", "")[:500],
            "pub_type": pub.get("pub_type", "article"),
            "source": pub.get("source", "orcid"),
        })
    return True


# Module-level singleton
_lab_importer: Optional["ORCIDLabImporter"] = None


def get_lab_importer() -> ORCIDLabImporter:
    global _lab_importer
    if _lab_importer is None:
        _lab_importer = ORCIDLabImporter()
    return _lab_importer
