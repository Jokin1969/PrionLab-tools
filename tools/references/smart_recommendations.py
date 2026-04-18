"""Smart reference recommendation engine — no external ML dependencies."""
import logging
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

_NEURO_KEY_AUTHORS = [
    "prusiner", "aguzzi", "collinge", "harris", "weissmann",
    "tanzi", "selkoe", "hardy", "trojanowski", "montine",
    "safar", "telling", "chesebro", "petersen", "knight",
    "wyss-coray", "holtzman", "ganl", "lee", "montine",
]

_NEURO_EMERGING_TOPICS = [
    "prion-like spreading", "cross-seeding", "phase separation",
    "rt-quic", "biomarker", "liquid-liquid", "tau propagation",
    "amyloid seeding", "neuroinflammation", "microglia activation",
    "csf biomarker", "nfl", "gfap", "pt181", "synaptic",
]

_NEURO_KEYWORDS = {
    "prion", "prp", "scrapie", "cjd", "bse", "misfolding",
    "neurodegeneration", "alzheimer", "parkinson", "huntington",
    "tau", "amyloid", "alpha-synuclein", "protein aggregation",
}


@dataclass
class Recommendation:
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
class ResearchGap:
    gap_type: str
    description: str
    severity: str
    suggested_actions: List[str]
    related_keywords: List[str]
    evidence_score: float


def _db():
    try:
        from database.config import db
        return db if db.is_configured() else None
    except Exception:
        return None


def _get_all_refs_system() -> List[Dict]:
    db = _db()
    if db:
        try:
            from database.models import ReferenceEntry
            with db.get_session() as s:
                rows = s.query(ReferenceEntry).limit(500).all()
                return [r.to_dict() for r in rows]
        except Exception as e:
            logger.warning("smart_rec all-refs DB: %s", e)
    try:
        from tools.references.service import _load_store
        return _load_store()
    except Exception:
        return []


def _get_manuscript_refs(manuscript_id: str) -> List[Dict]:
    try:
        from tools.references.service import get_references
        return get_references(manuscript_id, "", 0, 0, "")
    except Exception:
        return []


def _get_manuscript_info(manuscript_id: str, username: str) -> Optional[Dict]:
    try:
        from tools.manuscript_dashboard.service import get_manuscript
        return get_manuscript(manuscript_id, username)
    except Exception:
        return None


def _keyword_overlap(text1: str, text2: str) -> float:
    _stop = {"the", "and", "for", "with", "this", "that", "are", "was",
              "from", "has", "its", "not", "but", "can", "been", "have",
              "were", "they", "which", "also", "into", "more", "than"}

    def tok(t: str) -> set:
        return {w for w in re.findall(r"\b[a-z]{3,}\b", t.lower()) if w not in _stop}

    t1, t2 = tok(text1), tok(text2)
    if not t1 or not t2:
        return 0.0
    return len(t1 & t2) / len(t1 | t2)


class SmartRecommendationEngine:

    def generate_recommendations(
        self, manuscript_id: str, username: str = "", limit: int = 10
    ) -> List[Recommendation]:
        try:
            current_refs = _get_manuscript_refs(manuscript_id)
            manuscript = _get_manuscript_info(manuscript_id, username)
            all_refs = _get_all_refs_system()

            current_ids = {r.get("id") for r in current_refs}
            candidates = [r for r in all_refs if r.get("id") not in current_ids]
            if not candidates:
                return []

            recs: Dict[str, Recommendation] = {}

            def _merge(rec: Recommendation) -> None:
                rid = rec.reference_id
                if rid not in recs:
                    recs[rid] = rec
                else:
                    recs[rid].relevance_score += rec.relevance_score
                    recs[rid].source_references = list(
                        set(recs[rid].source_references + rec.source_references)
                    )[:5]

            for rec in self._collaborative_filtering(current_refs, all_refs, candidates):
                _merge(rec)

            ms_text = ""
            if manuscript:
                ms_text = (
                    f"{manuscript.get('title', '')} "
                    f"{manuscript.get('research_area', '')} "
                    f"{manuscript.get('keywords', '')}"
                )
            for rec in self._content_recommendations(ms_text, current_refs, candidates):
                _merge(rec)

            if manuscript:
                for rec in self._expertise_recommendations(
                    manuscript.get("research_area", ""), current_refs, candidates
                ):
                    _merge(rec)

            for rec in self._temporal_recommendations(
                manuscript, current_refs, candidates
            ):
                _merge(rec)

            sorted_recs = sorted(recs.values(), key=lambda r: r.relevance_score, reverse=True)
            return sorted_recs[:limit]
        except Exception as e:
            logger.error("generate_recommendations: %s", e)
            return []

    def _collaborative_filtering(
        self,
        current_refs: List[Dict],
        all_refs: List[Dict],
        candidates: List[Dict],
    ) -> List[Recommendation]:
        ms_refs: Dict[str, set] = defaultdict(set)
        for ref in all_refs:
            ms_id = ref.get("manuscript_id") or ""
            if ms_id:
                ms_refs[ms_id].add(ref.get("id"))

        current_ids = {r.get("id") for r in current_refs}
        scores: Counter = Counter()
        sources: Dict[str, set] = defaultdict(set)

        for ref_ids in ms_refs.values():
            overlap = ref_ids & current_ids
            if not overlap:
                continue
            for cid in ref_ids - current_ids:
                scores[cid] += len(overlap)
                sources[cid].update(overlap)

        if not scores:
            return []

        cand_map = {r.get("id"): r for r in candidates}
        max_s = max(scores.values())
        recs = []
        for cid, score in scores.most_common(15):
            ref = cand_map.get(cid)
            if not ref:
                continue
            norm = score / max_s
            recs.append(Recommendation(
                reference_id=cid,
                title=ref.get("title", ""),
                authors=ref.get("authors") or [],
                journal=ref.get("journal", ""),
                year=ref.get("year") or 0,
                doi=ref.get("doi", ""),
                relevance_score=norm * 0.35,
                recommendation_type="collaborative",
                explanation=f"Co-cited with {len(sources[cid])} of your references",
                confidence=min(norm, 1.0),
                source_references=list(sources[cid])[:3],
            ))
        return recs

    def _content_recommendations(
        self,
        manuscript_text: str,
        current_refs: List[Dict],
        candidates: List[Dict],
    ) -> List[Recommendation]:
        query_parts = [manuscript_text]
        for ref in current_refs:
            query_parts.append(f"{ref.get('title','')} {ref.get('abstract','')}")
        query = " ".join(query_parts)

        recs = []
        for ref in candidates:
            ref_text = (
                f"{ref.get('title','')} {ref.get('abstract','')} "
                f"{' '.join(ref.get('keywords') or [])}"
            )
            score = _keyword_overlap(query, ref_text)
            if score > 0.05:
                boost = self._neuro_boost(ref)
                recs.append(Recommendation(
                    reference_id=ref.get("id", ""),
                    title=ref.get("title", ""),
                    authors=ref.get("authors") or [],
                    journal=ref.get("journal", ""),
                    year=ref.get("year") or 0,
                    doi=ref.get("doi", ""),
                    relevance_score=(score + boost) * 0.30,
                    recommendation_type="content",
                    explanation=f"Content similarity {score:.2f}",
                    confidence=min(score * 3, 1.0),
                ))
        recs.sort(key=lambda r: r.relevance_score, reverse=True)
        return recs[:15]

    def _expertise_recommendations(
        self,
        research_area: str,
        current_refs: List[Dict],
        candidates: List[Dict],
    ) -> List[Recommendation]:
        ra = (research_area or "").lower()
        if not any(kw in ra for kw in ("prion", "neuro", "alzheimer", "parkinson")):
            return []
        current_author_text = " ".join(
            " ".join(r.get("authors") or []) for r in current_refs
        ).lower()
        recs = []
        for key_author in _NEURO_KEY_AUTHORS:
            if key_author in current_author_text:
                continue
            for ref in candidates:
                if key_author in " ".join(ref.get("authors") or []).lower():
                    recs.append(Recommendation(
                        reference_id=ref.get("id", ""),
                        title=ref.get("title", ""),
                        authors=ref.get("authors") or [],
                        journal=ref.get("journal", ""),
                        year=ref.get("year") or 0,
                        doi=ref.get("doi", ""),
                        relevance_score=0.20,
                        recommendation_type="expertise",
                        explanation=f"Key researcher in neurodegeneration: {key_author.title()}",
                        confidence=0.75,
                    ))
        return recs[:10]

    def _temporal_recommendations(
        self,
        manuscript: Optional[Dict],
        current_refs: List[Dict],
        candidates: List[Dict],
    ) -> List[Recommendation]:
        current_year = datetime.now().year
        recent_cutoff = current_year - 2
        ra = (manuscript or {}).get("research_area", "") if manuscript else ""
        recs = []
        for ref in candidates:
            y = ref.get("year") or 0
            if y < recent_cutoff:
                continue
            if ra and ref.get("research_area", "") != ra:
                continue
            score = min((y - recent_cutoff + 1) / 3.0, 1.0)
            recs.append(Recommendation(
                reference_id=ref.get("id", ""),
                title=ref.get("title", ""),
                authors=ref.get("authors") or [],
                journal=ref.get("journal", ""),
                year=y,
                doi=ref.get("doi", ""),
                relevance_score=score * 0.15,
                recommendation_type="temporal",
                explanation=f"Recent publication in your research area ({y})",
                confidence=min(score, 0.8),
            ))
        recs.sort(key=lambda r: r.relevance_score, reverse=True)
        return recs[:10]

    def _neuro_boost(self, ref: Dict) -> float:
        text = f"{ref.get('title','')} {ref.get('abstract','')}".lower()
        boost = sum(0.03 for t in _NEURO_EMERGING_TOPICS if t in text)
        return min(boost, 0.12)

    def detect_research_gaps(
        self, manuscript_id: str, username: str = ""
    ) -> List[ResearchGap]:
        gaps: List[ResearchGap] = []
        try:
            current_refs = _get_manuscript_refs(manuscript_id)
            manuscript = _get_manuscript_info(manuscript_id, username)
            research_area = (manuscript or {}).get("research_area", "")

            if not current_refs:
                return [ResearchGap(
                    gap_type="missing_citations",
                    description="No references imported yet",
                    severity="critical",
                    suggested_actions=["Import BibTeX file", "Add references manually"],
                    related_keywords=["bibliography", "citations"],
                    evidence_score=1.0,
                )]

            # Recency gap
            current_year = datetime.now().year
            years = [r.get("year") or 0 for r in current_refs if r.get("year")]
            if years:
                recent_ratio = sum(1 for y in years if y >= current_year - 2) / len(years)
                if recent_ratio < 0.2:
                    gaps.append(ResearchGap(
                        gap_type="missing_citations",
                        description=f"Only {recent_ratio:.0%} of references from last 2 years",
                        severity="medium",
                        suggested_actions=[
                            "Add recent publications",
                            "Include latest methodological advances",
                        ],
                        related_keywords=["recent", "current", "2024", "2025"],
                        evidence_score=round(1.0 - recent_ratio, 2),
                    ))

            # Missing key neurodegeneration authors
            ra = (research_area or "").lower()
            if any(kw in ra for kw in ("prion", "neuro", "alzheimer", "parkinson")):
                author_text = " ".join(
                    " ".join(r.get("authors") or []) for r in current_refs
                ).lower()
                missing = [a for a in _NEURO_KEY_AUTHORS if a not in author_text]
                if len(missing) >= 3:
                    gaps.append(ResearchGap(
                        gap_type="missing_citations",
                        description=f"Missing {len(missing)} key researchers in neurodegeneration",
                        severity="high",
                        suggested_actions=[
                            "Review seminal papers by key authors",
                            "Include foundational references",
                        ],
                        related_keywords=["neurodegeneration", "prion", "foundational"],
                        evidence_score=round(len(missing) / len(_NEURO_KEY_AUTHORS), 2),
                    ))

            # Methodological diversity
            method_terms = {
                "experimental": ["assay", "experiment", "protocol", "vivo", "vitro"],
                "computational": ["model", "simulation", "algorithm", "bioinformatics"],
                "clinical": ["patient", "clinical", "cohort", "epidemiolog"],
                "review": ["review", "meta-analysis", "systematic"],
            }
            found = set()
            for ref in current_refs:
                text = f"{ref.get('title','')} {ref.get('abstract','')}".lower()
                for mtype, terms in method_terms.items():
                    if any(t in text for t in terms):
                        found.add(mtype)
            if len(found) <= 1 and len(current_refs) > 5:
                gaps.append(ResearchGap(
                    gap_type="methodology_gap",
                    description=f"Limited methodology diversity: only {list(found) or ['unknown']}",
                    severity="medium",
                    suggested_actions=[
                        "Include both experimental and computational references",
                        "Add systematic reviews for context",
                    ],
                    related_keywords=["methodology", "approach", "technique"],
                    evidence_score=0.5,
                ))

            # Low reference count
            if len(current_refs) < 10:
                sev = "high" if len(current_refs) < 5 else "low"
                gaps.append(ResearchGap(
                    gap_type="missing_citations",
                    description=f"Low reference count: {len(current_refs)} (recommended ≥ 20)",
                    severity=sev,
                    suggested_actions=["Import BibTeX from reference manager"],
                    related_keywords=["bibliography", "citations"],
                    evidence_score=round(1.0 - len(current_refs) / 20.0, 2),
                ))
        except Exception as e:
            logger.error("detect_research_gaps: %s", e)
        return gaps


_engine: Optional[SmartRecommendationEngine] = None


def get_smart_recommendation_engine() -> SmartRecommendationEngine:
    global _engine
    if _engine is None:
        _engine = SmartRecommendationEngine()
    return _engine
