"""Advanced research gap detection — Phase 2, no numpy dependency."""
import logging
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# ── Expertise knowledge base ──────────────────────────────────────────────────

_PRION_SEMINAL = {
    "10.1073/pnas.95.23.13363": {"title": "Prusiner Nobel Lecture", "importance": "critical"},
    "10.1146/annurev.neuro.24.1.519": {"title": "Collinge Comprehensive Review", "importance": "critical"},
    "10.1038/35036315": {"title": "Aguzzi Propagation Mechanisms", "importance": "high"},
    "10.1126/science.1067122": {"title": "Weissmann Conversion Studies", "importance": "high"},
    "10.1038/nm0195-59": {"title": "Telling Strain Differences", "importance": "high"},
    "10.1038/nature02178": {"title": "Therapeutic Approaches", "importance": "medium"},
    "10.1016/j.cell.2016.05.009": {"title": "Structural Biology Advances", "importance": "medium"},
}

_PRION_RESEARCHERS = {
    "prusiner sb": {"importance": "critical", "recent_threshold": 2015},
    "aguzzi a": {"importance": "critical", "recent_threshold": 2018},
    "collinge j": {"importance": "critical", "recent_threshold": 2016},
    "harris da": {"importance": "high", "recent_threshold": 2017},
    "safar jg": {"importance": "high", "recent_threshold": 2019},
    "telling gc": {"importance": "high", "recent_threshold": 2018},
}

_PRION_METHODS = {
    "structural": ["x-ray", "nmr", "cryo-em", "crystallography", "structural biology"],
    "biochemical": ["purification", "misfolding assay", "conversion", "aggregation"],
    "cellular": ["cell culture", "cytotoxicity", "infection model", "transfection"],
    "animal": ["mouse model", "transgenic", "in vivo", "inoculation"],
    "clinical": ["patient", "clinical", "diagnostic", "biomarker", "cohort"],
    "computational": ["molecular dynamics", "modeling", "bioinformatics", "simulation"],
}

_EMERGING_TOPICS = {
    "rt-quic": 2010,
    "liquid-liquid phase separation": 2017,
    "prion-like spreading": 2012,
    "tau propagation": 2013,
    "therapeutic target": 2015,
}


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class AdvancedResearchGap:
    gap_id: str
    gap_type: str
    title: str
    description: str
    severity: str
    evidence_score: float
    impact_assessment: str
    suggested_actions: List[str]
    related_keywords: List[str]
    missing_count: int
    total_expected: int
    urgency_level: int
    estimated_effort: str


@dataclass
class GapAnalysisResult:
    gaps: List[AdvancedResearchGap]
    summary: Dict
    recommendations: List[str]
    priority_actions: List[str]


# ── Internal helpers ──────────────────────────────────────────────────────────

def _db():
    try:
        from database.config import db
        return db if db.is_configured() else None
    except Exception:
        return None


def _get_refs(manuscript_id: str) -> List[Dict]:
    try:
        from tools.references.service import get_references
        return get_references(manuscript_id, "", 0, 0, "")
    except Exception:
        return []


def _get_ms(manuscript_id: str, username: str) -> Optional[Dict]:
    try:
        from tools.manuscript_dashboard.service import get_manuscript
        return get_manuscript(manuscript_id, username)
    except Exception:
        return None


def _classify(ms: Optional[Dict]) -> str:
    if not ms:
        return "general"
    text = (
        f"{ms.get('title','')}{ms.get('research_area','')}"
        f"{ms.get('keywords','')}{ms.get('abstract','')}"
    ).lower()
    if any(k in text for k in ("prion", "prp", "scrapie", "cjd", "bse", "misfolding")):
        return "prion_diseases"
    if any(k in text for k in ("neurodegeneration", "alzheimer", "parkinson", "tau")):
        return "neurodegeneration"
    return "general"


def _author_overlap(key: str, author_list: List[str]) -> float:
    kw = set(key.lower().split())
    best = 0.0
    for a in author_list:
        aw = set(a.lower().split())
        if kw and aw:
            best = max(best, len(kw & aw) / len(kw | aw))
    return best


# ── Gap detectors ─────────────────────────────────────────────────────────────

def _foundational_gaps(area: str, refs: List[Dict]) -> List[AdvancedResearchGap]:
    if area != "prion_diseases":
        return []
    current_dois = {(r.get("doi") or "").lower() for r in refs}
    missing_crit, missing_high, missing_med = [], [], []
    for doi, info in _PRION_SEMINAL.items():
        if doi.lower() not in current_dois:
            if info["importance"] == "critical":
                missing_crit.append(doi)
            elif info["importance"] == "high":
                missing_high.append(doi)
            else:
                missing_med.append(doi)

    gaps = []
    n_crit_total = sum(1 for v in _PRION_SEMINAL.values() if v["importance"] == "critical")
    if missing_crit:
        gaps.append(AdvancedResearchGap(
            gap_id="foundational_critical_prion",
            gap_type="foundational",
            title="Missing Critical Foundational Papers",
            description=f"Missing {len(missing_crit)} critical foundational papers in prion disease research",
            severity="critical",
            evidence_score=round(len(missing_crit) / max(n_crit_total, 1), 2),
            impact_assessment="Severely undermines theoretical foundation",
            suggested_actions=[
                "Add Prusiner Nobel Lecture and core prion papers",
                "Include historical development of prion concept",
                "Review Collinge comprehensive review",
            ],
            related_keywords=["foundational", "seminal", "prion", "prusiner"],
            missing_count=len(missing_crit),
            total_expected=n_crit_total,
            urgency_level=5,
            estimated_effort="medium",
        ))

    n_high_total = sum(1 for v in _PRION_SEMINAL.values() if v["importance"] == "high")
    if missing_high and len(missing_high) / max(n_high_total, 1) > 0.4:
        gaps.append(AdvancedResearchGap(
            gap_id="foundational_high_prion",
            gap_type="foundational",
            title="Missing Important Foundational Work",
            description=f"Missing {len(missing_high)} important prion papers",
            severity="high",
            evidence_score=round(len(missing_high) / max(n_high_total, 1), 2),
            impact_assessment="Gaps in key methodological foundations",
            suggested_actions=[
                "Include Aguzzi propagation mechanisms",
                "Add Weissmann conversion studies",
                "Review strain differences literature",
            ],
            related_keywords=["methodology", "propagation", "conversion"],
            missing_count=len(missing_high),
            total_expected=n_high_total,
            urgency_level=3,
            estimated_effort="medium",
        ))
    return gaps


def _temporal_gaps(refs: List[Dict]) -> List[AdvancedResearchGap]:
    current_year = datetime.now().year
    years = [r.get("year") or 0 for r in refs if r.get("year")]
    if not years:
        return []

    recent = [y for y in years if y >= current_year - 3]
    recent_ratio = len(recent) / len(years)
    avg_age = statistics.mean([current_year - y for y in years])

    gaps = []
    if recent_ratio < 0.10:
        gaps.append(AdvancedResearchGap(
            gap_id="temporal_recency_critical",
            gap_type="temporal",
            title="Severely Outdated Literature Base",
            description=f"Only {recent_ratio:.0%} of references from last 3 years",
            severity="critical",
            evidence_score=round(1.0 - recent_ratio, 2),
            impact_assessment="Research appears disconnected from current developments",
            suggested_actions=[
                "Add recent breakthrough papers",
                "Include latest methodological advances",
                "Update theoretical framework with current findings",
                "Review state-of-the-art publications",
            ],
            related_keywords=["recent", "current", "latest", "breakthrough"],
            missing_count=max(1, int((0.30 - recent_ratio) * len(years))),
            total_expected=len(years),
            urgency_level=5,
            estimated_effort="high",
        ))
    elif recent_ratio < 0.20:
        gaps.append(AdvancedResearchGap(
            gap_id="temporal_recency_high",
            gap_type="temporal",
            title="Limited Recent Literature Coverage",
            description=f"Only {recent_ratio:.0%} of references from last 3 years",
            severity="high",
            evidence_score=round(1.0 - recent_ratio, 2),
            impact_assessment="May miss important recent developments",
            suggested_actions=[
                "Add recent publications",
                "Include emerging research trends",
                "Update with latest findings",
            ],
            related_keywords=["recent", "emerging", "current"],
            missing_count=max(1, int((0.25 - recent_ratio) * len(years))),
            total_expected=len(years),
            urgency_level=3,
            estimated_effort="medium",
        ))
    if avg_age > 8 and not gaps:
        gaps.append(AdvancedResearchGap(
            gap_id="temporal_avg_age",
            gap_type="temporal",
            title="Literature Base Skews Old",
            description=f"Average reference age: {avg_age:.1f} years",
            severity="medium",
            evidence_score=round(min((avg_age - 5) / 10, 1.0), 2),
            impact_assessment="Overall literature base may be outdated",
            suggested_actions=[
                "Balance old and new references",
                "Add recent reviews and updates",
            ],
            related_keywords=["balance", "contemporary", "updated"],
            missing_count=5,
            total_expected=len(years),
            urgency_level=2,
            estimated_effort="medium",
        ))
    return gaps


def _methodology_gaps(area: str, refs: List[Dict]) -> List[AdvancedResearchGap]:
    if area not in ("prion_diseases",):
        return []
    detected: set = set()
    for ref in refs:
        text = f"{ref.get('title','')} {ref.get('abstract','')}".lower()
        for mtype, kws in _PRION_METHODS.items():
            if any(k in text for k in kws):
                detected.add(mtype)

    total = len(_PRION_METHODS)
    gaps = []
    if len(detected) < 2:
        missing = set(_PRION_METHODS.keys()) - detected
        gaps.append(AdvancedResearchGap(
            gap_id="methodology_diversity",
            gap_type="methodological",
            title="Severely Limited Methodological Diversity",
            description=f"Only {len(detected)}/{total} methodology types represented",
            severity="critical" if len(detected) <= 1 else "high",
            evidence_score=round(1.0 - len(detected) / total, 2),
            impact_assessment="Research approach too narrow, misses key perspectives",
            suggested_actions=[
                f"Add {', '.join(list(missing)[:3])} methodological papers",
                "Include diverse research approaches",
                "Balance experimental and computational work",
            ],
            related_keywords=["methodology", "approach", "technique"] + list(missing)[:3],
            missing_count=len(missing),
            total_expected=total,
            urgency_level=4,
            estimated_effort="high",
        ))
    for priority_method in ("structural", "clinical", "biochemical"):
        if priority_method not in detected and len(detected) >= 2:
            gaps.append(AdvancedResearchGap(
                gap_id=f"methodology_{priority_method}",
                gap_type="methodological",
                title=f"Missing {priority_method.title()} Methodology",
                description=f"No {priority_method} approaches represented",
                severity="medium",
                evidence_score=0.60,
                impact_assessment=f"Lack of {priority_method} perspective limits scope",
                suggested_actions=[f"Add {priority_method} research papers"],
                related_keywords=[priority_method] + _PRION_METHODS[priority_method][:2],
                missing_count=1,
                total_expected=1,
                urgency_level=2,
                estimated_effort="medium",
            ))
    return gaps


def _expert_gaps(area: str, refs: List[Dict]) -> List[AdvancedResearchGap]:
    if area != "prion_diseases":
        return []
    missing_crit, missing_high = [], []
    for researcher, info in _PRION_RESEARCHERS.items():
        found = any(
            _author_overlap(researcher, r.get("authors") or []) > 0.7
            for r in refs
        )
        if not found:
            if info["importance"] == "critical":
                missing_crit.append(researcher)
            else:
                missing_high.append(researcher)

    gaps = []
    n_crit = sum(1 for v in _PRION_RESEARCHERS.values() if v["importance"] == "critical")
    if missing_crit:
        gaps.append(AdvancedResearchGap(
            gap_id="expert_critical",
            gap_type="expert",
            title="Missing Critical Field Experts",
            description=f"Missing work from {len(missing_crit)} critical researchers",
            severity="critical",
            evidence_score=round(len(missing_crit) / max(n_crit, 1), 2),
            impact_assessment="Lacks authoritative perspectives from field leaders",
            suggested_actions=[
                "Include work from Prusiner, Aguzzi, Collinge",
                "Add perspectives from opinion leaders",
            ],
            related_keywords=["expert", "authority", "field leader"] + missing_crit,
            missing_count=len(missing_crit),
            total_expected=n_crit,
            urgency_level=4,
            estimated_effort="medium",
        ))
    n_high = sum(1 for v in _PRION_RESEARCHERS.values() if v["importance"] == "high")
    if len(missing_high) > 2:
        gaps.append(AdvancedResearchGap(
            gap_id="expert_coverage",
            gap_type="expert",
            title="Limited Expert Representation",
            description=f"Missing work from {len(missing_high)} important researchers",
            severity="medium",
            evidence_score=round(len(missing_high) / max(n_high, 1), 2),
            impact_assessment="May miss important expert perspectives",
            suggested_actions=["Include diverse expert viewpoints"],
            related_keywords=["expert", "authority"] + missing_high[:3],
            missing_count=len(missing_high),
            total_expected=n_high,
            urgency_level=2,
            estimated_effort="medium",
        ))
    return gaps


def _interdisciplinary_gaps(ms: Optional[Dict], refs: List[Dict]) -> List[AdvancedResearchGap]:
    areas = {r.get("research_area") for r in refs if r.get("research_area")}
    if len(areas) > 1 or len(refs) <= 10:
        return []
    text = (f"{(ms or {}).get('title','')} {(ms or {}).get('research_area','')}").lower()
    suggested = []
    if any(k in text for k in ("therapeutic", "drug", "treatment")):
        suggested.append("pharmacology")
    if any(k in text for k in ("diagnostic", "biomarker", "clinical")):
        suggested.append("clinical medicine")
    if any(k in text for k in ("structure", "molecular")):
        suggested.append("structural biology")
    if not suggested:
        return []
    return [AdvancedResearchGap(
        gap_id="interdisciplinary_opportunity",
        gap_type="interdisciplinary",
        title="Limited Interdisciplinary Perspective",
        description=f"Could benefit from {', '.join(suggested)} perspectives",
        severity="low",
        evidence_score=0.35,
        impact_assessment="Broader disciplinary context would strengthen research",
        suggested_actions=[f"Consider {', '.join(suggested)} literature"],
        related_keywords=["interdisciplinary", "translational"] + suggested,
        missing_count=len(suggested),
        total_expected=len(suggested) + 1,
        urgency_level=1,
        estimated_effort="low",
    )]


# ── Service ───────────────────────────────────────────────────────────────────

class AdvancedGapDetectionService:
    MIN_REFS = 5

    def analyze_research_gaps(
        self, manuscript_id: str, username: str = ""
    ) -> GapAnalysisResult:
        try:
            ms = _get_ms(manuscript_id, username)
            refs = _get_refs(manuscript_id)

            if len(refs) < self.MIN_REFS:
                return self._minimal_result(len(refs))

            area = _classify(ms)
            gaps: List[AdvancedResearchGap] = []
            gaps.extend(_foundational_gaps(area, refs))
            gaps.extend(_temporal_gaps(refs))
            gaps.extend(_methodology_gaps(area, refs))
            gaps.extend(_expert_gaps(area, refs))
            gaps.extend(_interdisciplinary_gaps(ms, refs))

            # Sort by severity then urgency
            _sev = {"critical": 0, "high": 1, "medium": 2, "low": 3}
            gaps.sort(key=lambda g: (_sev.get(g.severity, 4), -g.urgency_level))

            summary = self._summarize(gaps, refs)
            recommendations = self._global_recs(gaps)
            priority_actions = self._priority_actions(gaps)

            logger.info("Advanced gap analysis: %d gaps for manuscript %s", len(gaps), manuscript_id)
            return GapAnalysisResult(
                gaps=gaps, summary=summary,
                recommendations=recommendations, priority_actions=priority_actions,
            )
        except Exception as e:
            logger.error("analyze_research_gaps: %s", e)
            return GapAnalysisResult(gaps=[], summary={"error": str(e)}, recommendations=[], priority_actions=[])

    def _summarize(self, gaps: List[AdvancedResearchGap], refs: List[Dict]) -> Dict:
        if not gaps:
            return {"total_gaps": 0, "overall_assessment": "strong", "reference_count": len(refs)}
        sev_counts = Counter(g.severity for g in gaps)
        type_counts = Counter(g.gap_type for g in gaps)
        urgency_vals = [g.urgency_level for g in gaps]
        overall = (
            "needs_improvement" if sev_counts.get("critical", 0) > 0
            else "adequate" if sev_counts.get("high", 0) > 1
            else "strong"
        )
        return {
            "total_gaps": len(gaps),
            "gap_types": dict(type_counts),
            "severity_breakdown": dict(sev_counts),
            "average_urgency": round(statistics.mean(urgency_vals), 1) if urgency_vals else 0,
            "overall_assessment": overall,
            "reference_count": len(refs),
            "critical_issues": sev_counts.get("critical", 0),
            "high_priority_issues": sev_counts.get("high", 0),
        }

    def _global_recs(self, gaps: List[AdvancedResearchGap]) -> List[str]:
        recs = []
        types = {g.gap_type for g in gaps}
        if "foundational" in types:
            recs.append("Review and include foundational literature to strengthen theoretical basis")
        if "temporal" in types:
            recs.append("Update literature base with recent publications")
        if "methodological" in types:
            recs.append("Diversify methodological approaches for comprehensive perspective")
        if "expert" in types:
            recs.append("Include work from recognized field experts")
        if "interdisciplinary" in types:
            recs.append("Consider cross-disciplinary perspectives")
        if any(g.urgency_level >= 4 for g in gaps):
            recs.append("Address high-urgency gaps immediately to improve manuscript quality")
        return recs

    def _priority_actions(self, gaps: List[AdvancedResearchGap]) -> List[str]:
        actions = []
        for g in [x for x in gaps if x.severity == "critical"][:2]:
            actions.extend(g.suggested_actions[:2])
        for g in [x for x in gaps if x.urgency_level >= 4 and x.severity != "critical"][:2]:
            actions.append(g.suggested_actions[0])
        return actions[:5]

    def _minimal_result(self, count: int) -> GapAnalysisResult:
        gap = AdvancedResearchGap(
            gap_id="insufficient_references",
            gap_type="foundational",
            title="Insufficient Reference Base",
            description=f"Only {count} references — need at least {self.MIN_REFS} for analysis",
            severity="high",
            evidence_score=round(1.0 - count / self.MIN_REFS, 2),
            impact_assessment="Reference base too small for meaningful gap analysis",
            suggested_actions=["Import BibTeX file", "Add foundational references"],
            related_keywords=["foundational", "expand", "coverage"],
            missing_count=self.MIN_REFS - count,
            total_expected=self.MIN_REFS,
            urgency_level=4,
            estimated_effort="high",
        )
        return GapAnalysisResult(
            gaps=[gap],
            summary={"total_gaps": 1, "overall_assessment": "needs_improvement", "reference_count": count},
            recommendations=["Expand reference base before detailed analysis"],
            priority_actions=["Add foundational references to reach minimum threshold"],
        )


_adv_service: Optional[AdvancedGapDetectionService] = None


def get_advanced_gap_detection_service() -> AdvancedGapDetectionService:
    global _adv_service
    if _adv_service is None:
        _adv_service = AdvancedGapDetectionService()
    return _adv_service
