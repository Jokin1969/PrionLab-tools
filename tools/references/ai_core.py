"""Core AI recommendation engine — Phase 1 (collaborative, content, expertise)."""
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# ── Neurodegeneration knowledge base ─────────────────────────────────────────

_PRION_SEMINAL_DOIS = [
    "10.1073/pnas.95.23.13363",
    "10.1146/annurev.neuro.24.1.519",
    "10.1038/35036315",
    "10.1126/science.1067122",
    "10.1038/nm0195-59",
]

_PRION_KEY_AUTHORS = [
    "prusiner sb", "aguzzi a", "collinge j", "harris da",
    "weissmann c", "safar jg", "telling gc", "chesebro b",
]

_PRION_CORE_JOURNALS = {
    "prion", "plos pathogens", "acta neuropathologica",
    "brain pathology", "journal of virology", "pnas",
    "nature neuroscience", "journal of neuroscience",
}

_WEIGHTS = {
    "collaborative_filtering": 0.40,
    "content_similarity": 0.35,
    "field_expertise": 0.25,
}


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class CoreRecommendation:
    reference_id: str
    title: str
    authors: List[str]
    journal: str
    year: int
    doi: str
    relevance_score: float
    recommendation_type: str
    explanation: str
    confidence: float
    source_references: List[str] = field(default_factory=list)


@dataclass
class FoundationalGap:
    missing_papers: List[str]
    research_area: str
    severity: str
    description: str


# ── Internal helpers ──────────────────────────────────────────────────────────

def _db():
    try:
        from database.config import db
        return db if db.is_configured() else None
    except Exception:
        return None


def _all_refs() -> List[Dict]:
    db = _db()
    if db:
        try:
            from database.models import ReferenceEntry
            with db.get_session() as s:
                return [r.to_dict() for r in s.query(ReferenceEntry).limit(500).all()]
        except Exception as e:
            logger.warning("ai_core _all_refs DB: %s", e)
    try:
        from tools.references.service import _load_store
        return _load_store()
    except Exception:
        return []


def _ms_refs(manuscript_id: str) -> List[Dict]:
    try:
        from tools.references.service import get_references
        return get_references(manuscript_id, "", 0, 0, "")
    except Exception:
        return []


def _ms_info(manuscript_id: str, username: str) -> Optional[Dict]:
    try:
        from tools.manuscript_dashboard.service import get_manuscript
        return get_manuscript(manuscript_id, username)
    except Exception:
        return None


def _kw_overlap(a: str, b: str) -> float:
    _stop = {"the", "and", "for", "with", "this", "that", "are", "was",
              "from", "has", "its", "not", "but", "can", "been", "have",
              "were", "they", "which", "also", "into", "more", "than"}

    def tok(t: str) -> set:
        return {w for w in re.findall(r"\b[a-z]{3,}\b", t.lower()) if w not in _stop}

    ta, tb = tok(a), tok(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _classify_area(ms: Optional[Dict]) -> str:
    if not ms:
        return "general"
    text = (
        f"{ms.get('title', '')} {ms.get('research_area', '')} "
        f"{ms.get('keywords', '')} {ms.get('abstract', '')}"
    ).lower()
    if any(k in text for k in ("prion", "prp", "scrapie", "cjd", "bse", "misfolding")):
        return "prion_diseases"
    if any(k in text for k in ("neurodegeneration", "alzheimer", "parkinson", "tau", "amyloid")):
        return "neurodegeneration"
    return "general"


# ── Engine ────────────────────────────────────────────────────────────────────

class CoreAIRecommendationEngine:
    MIN_COOCCURRENCE = 2
    MIN_SIMILARITY = 0.06
    MIN_SCORE = 0.03

    def generate_core_recommendations(
        self, manuscript_id: str, username: str = "", limit: int = 10
    ) -> Dict:
        try:
            ms = _ms_info(manuscript_id, username)
            current = _ms_refs(manuscript_id)
            all_refs = _all_refs()

            current_ids = {r.get("id") for r in current}
            candidates = [r for r in all_refs if r.get("id") not in current_ids]

            recs: Dict[str, CoreRecommendation] = {}

            def _merge(rec: CoreRecommendation) -> None:
                rid = rec.reference_id
                if rid not in recs:
                    recs[rid] = rec
                else:
                    recs[rid].relevance_score = min(
                        recs[rid].relevance_score + rec.relevance_score, 1.0
                    )
                    recs[rid].source_references = list(
                        set(recs[rid].source_references + rec.source_references)
                    )[:5]

            for rec in self._collaborative_filtering(current, all_refs, candidates):
                _merge(rec)

            ms_text = ""
            if ms:
                ms_text = (
                    f"{ms.get('title', '')} {ms.get('research_area', '')} "
                    f"{ms.get('keywords', '')} {ms.get('abstract', '')}"
                )
            for rec in self._content_similarity(ms_text, current, candidates):
                _merge(rec)

            for rec in self._field_expertise(ms, current, candidates):
                _merge(rec)

            gaps = self._detect_foundational_gaps(ms, current)

            sorted_recs = sorted(
                recs.values(), key=lambda r: r.relevance_score, reverse=True
            )
            return {
                "recommendations": [
                    {
                        "reference_id": r.reference_id,
                        "title": r.title,
                        "authors": r.authors,
                        "journal": r.journal,
                        "year": r.year,
                        "doi": r.doi,
                        "relevance_score": round(r.relevance_score, 4),
                        "recommendation_type": r.recommendation_type,
                        "explanation": r.explanation,
                        "confidence": round(r.confidence, 3),
                        "source_references": r.source_references,
                    }
                    for r in sorted_recs[:limit]
                ],
                "foundational_gaps": [asdict(g) for g in gaps],
                "metadata": {
                    "manuscript_id": manuscript_id,
                    "current_references": len(current),
                    "algorithms_used": ["collaborative", "content", "expertise"],
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                },
            }
        except Exception as e:
            logger.error("generate_core_recommendations: %s", e)
            return {"recommendations": [], "error": str(e)}

    # ── Algorithm implementations ─────────────────────────────────────────────

    def _collaborative_filtering(
        self,
        current: List[Dict],
        all_refs: List[Dict],
        candidates: List[Dict],
    ) -> List[CoreRecommendation]:
        ms_refs: Dict[str, set] = defaultdict(set)
        for ref in all_refs:
            ms_id = ref.get("manuscript_id") or ""
            if ms_id:
                ms_refs[ms_id].add(ref.get("id"))

        status_weight: Dict[str, float] = {}
        db = _db()
        if db:
            try:
                from database.models import Manuscript
                _sw = {"published": 2.0, "accepted": 1.5, "submitted": 1.2}
                with db.get_session() as s:
                    for row in s.query(Manuscript.id, Manuscript.status).all():
                        status_weight[str(row[0])] = _sw.get(row[1], 1.0)
            except Exception:
                pass

        current_ids = {r.get("id") for r in current}
        scores: Counter = Counter()
        sources: Dict[str, list] = defaultdict(list)

        for ms_id, ref_ids in ms_refs.items():
            overlap = ref_ids & current_ids
            if not overlap:
                continue
            w = status_weight.get(ms_id, 1.0)
            for cid in ref_ids - current_ids:
                scores[cid] += len(overlap) * w
                for oid in list(overlap)[:2]:
                    if oid not in sources[cid]:
                        sources[cid].append(oid)

        if not scores:
            return []

        cand_map = {r.get("id"): r for r in candidates}
        max_s = max(scores.values())
        recs = []
        for cid, score in scores.most_common(15):
            if score < self.MIN_COOCCURRENCE:
                continue
            ref = cand_map.get(cid)
            if not ref:
                continue
            norm = score / max_s
            final = norm * _WEIGHTS["collaborative_filtering"]
            if final < self.MIN_SCORE:
                continue
            recs.append(CoreRecommendation(
                reference_id=cid,
                title=ref.get("title", ""),
                authors=ref.get("authors") or [],
                journal=ref.get("journal", ""),
                year=ref.get("year") or 0,
                doi=ref.get("doi", ""),
                relevance_score=final,
                recommendation_type="collaborative",
                explanation=f"Co-cited with {len(sources[cid])} of your references",
                confidence=min(norm, 1.0),
                source_references=sources[cid],
            ))
        return recs

    def _content_similarity(
        self,
        ms_text: str,
        current: List[Dict],
        candidates: List[Dict],
    ) -> List[CoreRecommendation]:
        query = ms_text + " " + " ".join(
            f"{r.get('title','')} {r.get('abstract','')}" for r in current
        )
        recs = []
        for ref in candidates[:150]:
            ref_text = (
                f"{ref.get('title','')} {ref.get('abstract','')} "
                f"{' '.join(ref.get('keywords') or [])}"
            )
            score = _kw_overlap(query, ref_text)
            if score < self.MIN_SIMILARITY:
                continue
            j = (ref.get("journal") or "").lower()
            jboost = 0.08 if any(jn in j for jn in _PRION_CORE_JOURNALS) else 0.0
            final = (score + jboost) * _WEIGHTS["content_similarity"]
            if final < self.MIN_SCORE:
                continue
            suffix = " + field boost" if jboost else ""
            recs.append(CoreRecommendation(
                reference_id=ref.get("id", ""),
                title=ref.get("title", ""),
                authors=ref.get("authors") or [],
                journal=ref.get("journal", ""),
                year=ref.get("year") or 0,
                doi=ref.get("doi", ""),
                relevance_score=final,
                recommendation_type="content",
                explanation=f"Content similarity {score:.2f}{suffix}",
                confidence=min(score + jboost, 1.0),
            ))
        recs.sort(key=lambda r: r.relevance_score, reverse=True)
        return recs[:12]

    def _field_expertise(
        self,
        ms: Optional[Dict],
        current: List[Dict],
        candidates: List[Dict],
    ) -> List[CoreRecommendation]:
        area = _classify_area(ms)
        if area not in ("prion_diseases", "neurodegeneration"):
            return []

        current_dois = {(r.get("doi") or "").lower() for r in current}
        current_author_text = " ".join(
            " ".join(r.get("authors") or []) for r in current
        ).lower()
        cand_doi_map = {
            (r.get("doi") or "").lower(): r for r in candidates if r.get("doi")
        }
        recs = []

        if area == "prion_diseases":
            for doi in _PRION_SEMINAL_DOIS:
                if doi.lower() in current_dois:
                    continue
                ref = cand_doi_map.get(doi.lower())
                if ref:
                    recs.append(CoreRecommendation(
                        reference_id=ref.get("id", ""),
                        title=ref.get("title", ""),
                        authors=ref.get("authors") or [],
                        journal=ref.get("journal", ""),
                        year=ref.get("year") or 0,
                        doi=doi,
                        relevance_score=0.80 * _WEIGHTS["field_expertise"],
                        recommendation_type="expertise",
                        explanation="Foundational paper in prion disease research",
                        confidence=0.90,
                    ))

            for key_author in _PRION_KEY_AUTHORS:
                if key_author in current_author_text:
                    continue
                for ref in candidates:
                    if key_author in " ".join(ref.get("authors") or []).lower():
                        recs.append(CoreRecommendation(
                            reference_id=ref.get("id", ""),
                            title=ref.get("title", ""),
                            authors=ref.get("authors") or [],
                            journal=ref.get("journal", ""),
                            year=ref.get("year") or 0,
                            doi=ref.get("doi", ""),
                            relevance_score=0.60 * _WEIGHTS["field_expertise"],
                            recommendation_type="expertise",
                            explanation=f"Key prion researcher: {key_author.title()}",
                            confidence=0.70,
                        ))
        return recs[:8]

    def _detect_foundational_gaps(
        self, ms: Optional[Dict], current: List[Dict]
    ) -> List[FoundationalGap]:
        area = _classify_area(ms)
        if area != "prion_diseases":
            return []
        current_dois = {(r.get("doi") or "").lower() for r in current}
        missing = [d for d in _PRION_SEMINAL_DOIS if d.lower() not in current_dois]
        if len(missing) < 2:
            return []
        return [FoundationalGap(
            missing_papers=missing,
            research_area=area,
            severity="high" if len(missing) > 3 else "medium",
            description=f"Missing {len(missing)} foundational prion disease citations",
        )]


# ── Singleton ─────────────────────────────────────────────────────────────────

_core_engine: Optional[CoreAIRecommendationEngine] = None


def get_core_ai_recommendation_engine() -> CoreAIRecommendationEngine:
    global _core_engine
    if _core_engine is None:
        _core_engine = CoreAIRecommendationEngine()
    return _core_engine
