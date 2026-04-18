"""AI-powered publication discovery for lab members via PubMed + CrossRef."""
import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Castilla lab–specific search configuration
_AUTHOR_VARIANTS = [
    "Castilla J", "Castilla JM", "Castilla Joaquin", "Joaquin Castilla", "J Castilla",
]
_INSTITUTION_TERMS = [
    "Universidad del País Vasco", "University of the Basque Country",
    "UPV/EHU", "CIC bioGUNE", "Achucarro Basque Center for Neuroscience",
    "Basque Center for Neuroscience",
]
_PRION_TERMS = [
    "prion protein", "PrP", "prion disease", "scrapie", "CJD",
    "Creutzfeldt-Jakob", "BSE", "fatal familial insomnia",
    "PrPSc", "prion strain", "prion propagation", "protein misfolding",
]
_NEURO_TERMS = [
    "neurodegeneration", "Alzheimer", "Parkinson", "alpha-synuclein",
    "tau protein", "amyloid beta", "protein aggregation", "neuropathology",
]


@dataclass
class DiscoveryQuery:
    """Configuration for one author-centric discovery pass."""
    author_name: str
    institution: str = ""
    research_keywords: List[str] = field(default_factory=list)
    years_back: int = 5
    max_results: int = 50
    confidence_threshold: float = 0.7


@dataclass
class DiscoveredPublication:
    """A publication found during AI discovery."""
    title: str
    authors: List[str]
    journal: str
    year: Any
    doi: str = ""
    pmid: str = ""
    abstract: str = ""
    confidence_score: float = 0.0
    discovery_method: str = ""
    matching_keywords: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return {
            "title": self.title,
            "authors": self.authors,
            "journal": self.journal,
            "year": self.year,
            "doi": self.doi,
            "pmid": self.pmid,
            "abstract": self.abstract,
            "confidence_score": self.confidence_score,
            "discovery_method": self.discovery_method,
            "matching_keywords": self.matching_keywords,
        }


class AIPublicationDiscovery:
    """AI-powered discovery using PubMed + CrossRef multi-strategy search."""

    async def discover_lab_publications(
        self,
        queries: List[DiscoveryQuery],
        cross_validate: bool = True,
    ) -> List[DiscoveredPublication]:
        from tools.external_apis.pubmed_client import get_pubmed_client
        from tools.external_apis.crossref_client import get_crossref_client

        results: List[DiscoveredPublication] = []
        pm_client = get_pubmed_client()
        cr_client = get_crossref_client()

        async with pm_client, cr_client:
            results += await self._by_author(pm_client, queries)
            results += await self._by_keywords(pm_client, queries)
            results += await self._by_crossref(cr_client, queries)

        unique = self._deduplicate(results)
        if cross_validate:
            unique = self._filter_existing(unique)
        unique.sort(key=lambda d: d.confidence_score, reverse=True)
        logger.info("AI Discovery: %d unique publications found", len(unique))
        return unique

    # ── Search strategies ─────────────────────────────────────────────────────

    async def _by_author(self, client, queries: List[DiscoveryQuery]) -> List[DiscoveredPublication]:
        pubs: List[DiscoveredPublication] = []
        for q in queries:
            variants = _author_variants(q.author_name)
            for variant in variants:
                try:
                    qstr = f'"{variant}"[Author]'
                    if q.research_keywords:
                        kws = " OR ".join(f'"{k}"' for k in q.research_keywords[:4])
                        qstr += f" AND ({kws})"
                    qstr += f' AND ("{datetime.now().year - q.years_back}"[Date - Publication] : "3000"[Date - Publication])'
                    resp = await client.search_literature(qstr, max_results=min(q.max_results, 50))
                    if resp.success:
                        for art in (resp.data or {}).get("articles", []):
                            d = _article_to_discovery(art, f"author:{variant}")
                            if d:
                                pubs.append(d)
                    await asyncio.sleep(0.5)
                except Exception as exc:
                    logger.debug("_by_author %s: %s", variant, exc)
        return pubs

    async def _by_keywords(self, client, queries: List[DiscoveryQuery]) -> List[DiscoveredPublication]:
        pubs: List[DiscoveredPublication] = []
        try:
            prion_q = " OR ".join(f'"{t}"' for t in _PRION_TERMS[:5])
            inst_q = " OR ".join(f'"{i}"[Affiliation]' for i in _INSTITUTION_TERMS[:3])
            qstr = f"({prion_q}) AND ({inst_q})"
            resp = await client.search_literature(
                qstr, max_results=80, year_from=datetime.now().year - 10
            )
            if resp.success:
                for art in (resp.data or {}).get("articles", []):
                    author_score = _author_match(art, queries)
                    if author_score >= 0.25:
                        d = _article_to_discovery(art, "keyword_institution")
                        if d:
                            d.confidence_score = min(d.confidence_score * (1 + author_score), 1.0)
                            pubs.append(d)
        except Exception as exc:
            logger.debug("_by_keywords: %s", exc)
        return pubs

    async def _by_crossref(self, client, queries: List[DiscoveryQuery]) -> List[DiscoveredPublication]:
        pubs: List[DiscoveredPublication] = []
        for q in queries:
            try:
                resp = await client.search_works(
                    query="prion neurodegeneration",
                    author=q.author_name,
                    limit=20,
                )
                if resp.success:
                    for work in (resp.data or {}).get("works", []):
                        d = _crossref_to_discovery(work, f"crossref:{q.author_name}")
                        if d:
                            pubs.append(d)
                await asyncio.sleep(1.0)
            except Exception as exc:
                logger.debug("_by_crossref %s: %s", q.author_name, exc)
        return pubs

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _deduplicate(self, pubs: List[DiscoveredPublication]) -> List[DiscoveredPublication]:
        seen: Dict[str, DiscoveredPublication] = {}
        for p in pubs:
            key = f"doi:{p.doi}" if p.doi else f"pmid:{p.pmid}" if p.pmid else _title_year_key(p.title, p.year)
            if key and (key not in seen or p.confidence_score > seen[key].confidence_score):
                seen[key] = p
        return list(seen.values())

    def _filter_existing(self, pubs: List[DiscoveredPublication]) -> List[DiscoveredPublication]:
        """Boost novelty; reduce score for pubs already in our database/CSV."""
        existing_dois: set = set()
        try:
            from tools.research.models import get_all_publications
            for p in get_all_publications():
                d = (p.get("doi") or "").strip()
                if d:
                    existing_dois.add(d.lower())
        except Exception:
            pass
        result = []
        for p in pubs:
            if p.doi and p.doi.lower() in existing_dois:
                p.confidence_score *= 0.4  # already known
            result.append(p)
        return result


# ── Module-level helpers ──────────────────────────────────────────────────────

def _author_variants(name: str) -> List[str]:
    variants = [name]
    if "castilla" in name.lower():
        variants.extend(_AUTHOR_VARIANTS)
    parts = name.split()
    if len(parts) >= 2:
        last = parts[-1]
        first = parts[0]
        variants += [f"{last} {first[0]}", f"{first[0]} {last}", f"{first} {last}"]
    return list(dict.fromkeys(variants))  # dedup, preserve order


def _author_match(article: Dict, queries: List[DiscoveryQuery]) -> float:
    author_text = " ".join(
        a.get("full_name", "") for a in article.get("authors", [])
    ).lower()
    score = 0.0
    for q in queries:
        for v in _author_variants(q.author_name):
            if v.lower() in author_text:
                score += 1.0
                break
    return min(score / max(len(queries), 1), 1.0)


def _article_to_discovery(art: Dict, method: str) -> Optional[DiscoveredPublication]:
    title = (art.get("title") or "").strip()
    if not title:
        return None
    text = f"{title} {art.get('abstract', '')}".lower()
    all_kws = _PRION_TERMS + _NEURO_TERMS
    matching = [kw for kw in all_kws if kw.lower() in text]
    conf = min(len(matching) / max(len(all_kws), 1) * 0.5 + 0.3, 1.0)
    return DiscoveredPublication(
        title=title,
        authors=[a.get("full_name", "") for a in art.get("authors", [])],
        journal=art.get("journal", ""),
        year=art.get("year", ""),
        doi=art.get("doi", ""),
        pmid=art.get("pmid", ""),
        abstract=art.get("abstract", ""),
        confidence_score=conf,
        discovery_method=method,
        matching_keywords=matching[:5],
    )


def _crossref_to_discovery(work: Dict, method: str) -> Optional[DiscoveredPublication]:
    title = (work.get("title") or "").strip()
    if not title:
        return None
    return DiscoveredPublication(
        title=title,
        authors=[a.get("full_name", "") for a in work.get("authors", [])],
        journal=work.get("journal", ""),
        year=work.get("year", ""),
        doi=work.get("doi", ""),
        confidence_score=0.55,
        discovery_method=method,
    )


def _title_year_key(title: str, year: Any) -> str:
    slug = " ".join(re.sub(r"[^\w\s]", "", title.lower()).split()[:5])
    return f"title:{year}:{slug}"


# Module singleton
_ai_discovery: Optional[AIPublicationDiscovery] = None


def get_ai_discovery() -> AIPublicationDiscovery:
    global _ai_discovery
    if _ai_discovery is None:
        _ai_discovery = AIPublicationDiscovery()
    return _ai_discovery
