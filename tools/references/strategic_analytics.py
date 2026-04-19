"""Strategic Research Analytics — pure Python, no sklearn/networkx/scipy.

Derives strategic intelligence from the reference corpus already stored in the
system (references.json, journal_quality.csv, researcher_profiles.json).

Five analytical engines:
  ResearchROIAnalyzer          — citation/journal-value proxy ROI
  CollaborationAnalyzer        — author co-occurrence effectiveness
  PortfolioOptimizer           — journal & topic diversity + risk
  StrategicPlanner             — roadmap from trends + portfolio gaps
  CompetitiveIntelligence      — research-area landscape from corpus
"""
import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_NOW = datetime.now(timezone.utc).isoformat


# ── Dataclasses ────────────────────────────────────────────────────────────────

@dataclass
class ResearchROIAnalysis:
    manuscript_id: str
    reference_count: int
    citation_impact_score: float      # weighted by journal IF
    collaboration_breadth: int        # distinct institutions/labs
    high_impact_ratio: float          # fraction in Q1/Q2 journals
    estimated_roi_index: float        # 0-1 composite
    roi_breakdown: Dict
    optimization_recommendations: List[str]


@dataclass
class CollaborationAnalysis:
    manuscript_id: str
    unique_author_groups: int
    top_collaborators: List[str]
    collaboration_diversity_score: float   # 0-1
    cross_institutional_ratio: float
    most_productive_pair: Tuple[str, str]
    effectiveness_score: float
    recommendations: List[str]


@dataclass
class PortfolioAnalysis:
    manuscript_id: str
    total_references: int
    journal_diversity_score: float
    topic_diversity_score: float
    impact_distribution: Dict          # {'Q1':n, 'Q2':n, ...}
    over_concentration_warning: bool
    risk_level: str                    # 'low' | 'medium' | 'high'
    portfolio_efficiency: float
    optimization_opportunities: List[str]


@dataclass
class StrategicPlan:
    manuscript_id: str
    planning_horizon_months: int
    current_strengths: List[str]
    emerging_opportunities: List[str]
    recommended_directions: List[Dict]
    publication_strategy: Dict
    resource_allocation: Dict
    milestones: List[Dict]
    risk_mitigations: List[str]


@dataclass
class CompetitiveAnalysis:
    research_area: str
    total_refs_in_area: int
    top_journals: List[Dict]
    dominant_topics: List[str]
    research_velocity: float           # refs per year trend
    competitive_position: str          # 'leading' | 'active' | 'emerging' | 'niche'
    white_space_opportunities: List[str]
    strategic_recommendations: List[str]


# ── Journal quality helper ─────────────────────────────────────────────────────

def _load_jq() -> List[Dict]:
    try:
        from tools.manuscriptforge.models import load_journal_quality
        return load_journal_quality().to_dict("records")
    except Exception:
        return []


def _jq_lookup(journal: str, jq: List[Dict]) -> Dict:
    jl = journal.lower()
    for j in jq:
        if jl in (j.get("name") or "").lower():
            try:
                return {
                    "if": float(j.get("impact_factor") or 0),
                    "q_wos": j.get("quartile_wos") or "",
                    "q_scopus": j.get("quartile_scopus") or "",
                }
            except (ValueError, TypeError):
                return {"if": 0.0, "q_wos": "", "q_scopus": ""}
    return {"if": 0.0, "q_wos": "", "q_scopus": ""}


def _q_rank(q: str) -> int:
    """Q1→4, Q2→3, Q3→2, Q4→1, unknown→0"""
    return {"Q1": 4, "Q2": 3, "Q3": 2, "Q4": 1}.get(q.strip(), 0)


# ── Math helpers ───────────────────────────────────────────────────────────────

def _shannon(counts: List[int]) -> float:
    """Shannon entropy → diversity index 0-1."""
    total = sum(counts)
    if total == 0:
        return 0.0
    entropy = -sum((c / total) * math.log2(c / total) for c in counts if c > 0)
    max_entropy = math.log2(len(counts)) if len(counts) > 1 else 1.0
    return entropy / max_entropy if max_entropy > 0 else 0.0


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


# ── Research ROI Analyzer ─────────────────────────────────────────────────────

class ResearchROIAnalyzer:
    """Estimates research ROI proxy from reference quality metrics."""

    def analyze(self, manuscript_id: str, refs: List[Dict]) -> ResearchROIAnalysis:
        if not refs:
            return self._empty(manuscript_id)

        jq = _load_jq()
        if_values: List[float] = []
        q_ranks: List[int] = []
        q1q2_count = 0

        for ref in refs:
            journal = ref.get("journal") or ""
            info = _jq_lookup(journal, jq)
            if info["if"] > 0:
                if_values.append(info["if"])
            q = info["q_wos"] or info["q_scopus"]
            rank = _q_rank(q)
            q_ranks.append(rank)
            if q in ("Q1", "Q2"):
                q1q2_count += 1

        avg_if = sum(if_values) / len(if_values) if if_values else 0.0
        avg_q  = sum(q_ranks)  / len(q_ranks)   if q_ranks   else 0.0
        high_impact_ratio = q1q2_count / len(refs)

        # Author-based collaboration proxy
        authors_all: List[str] = []
        for ref in refs:
            authors_all.extend(ref.get("authors") or [])
        collaboration_breadth = len({a.split(",")[0].strip().lower() for a in authors_all if a})

        # Composite ROI index
        if_score  = min(1.0, avg_if / 15.0)
        q_score   = avg_q / 4.0
        hi_score  = high_impact_ratio
        collab_score = min(1.0, collaboration_breadth / 50.0)
        roi_index = round(0.35 * if_score + 0.30 * q_score + 0.20 * hi_score + 0.15 * collab_score, 3)

        breakdown = {
            "avg_impact_factor":   round(avg_if, 2),
            "avg_quartile_score":  round(avg_q, 2),
            "high_impact_ratio":   round(high_impact_ratio, 3),
            "collaboration_breadth": collaboration_breadth,
            "if_contribution":     round(0.35 * if_score, 3),
            "quartile_contribution": round(0.30 * q_score, 3),
            "high_impact_contribution": round(0.20 * hi_score, 3),
            "collaboration_contribution": round(0.15 * collab_score, 3),
        }

        recs = []
        if high_impact_ratio < 0.3:
            recs.append("Increase proportion of Q1/Q2 journal references to strengthen impact profile.")
        if avg_if < 3.0:
            recs.append("Incorporate more references from high-IF journals (>5) to raise citation potential.")
        if collaboration_breadth < 15:
            recs.append("Expand co-author diversity — citing multi-institutional work signals broader reach.")
        if not recs:
            recs.append("Strong reference portfolio. Maintain balance between impact and breadth.")

        return ResearchROIAnalysis(
            manuscript_id=manuscript_id,
            reference_count=len(refs),
            citation_impact_score=round(avg_if, 2),
            collaboration_breadth=collaboration_breadth,
            high_impact_ratio=round(high_impact_ratio, 3),
            estimated_roi_index=roi_index,
            roi_breakdown=breakdown,
            optimization_recommendations=recs,
        )

    @staticmethod
    def _empty(mid: str) -> ResearchROIAnalysis:
        return ResearchROIAnalysis(
            manuscript_id=mid, reference_count=0, citation_impact_score=0.0,
            collaboration_breadth=0, high_impact_ratio=0.0, estimated_roi_index=0.0,
            roi_breakdown={}, optimization_recommendations=["No references to analyse."],
        )


# ── Collaboration Analyzer ────────────────────────────────────────────────────

class CollaborationAnalyzer:
    """Measures collaboration breadth and effectiveness from author co-occurrence."""

    def analyze(self, manuscript_id: str, refs: List[Dict]) -> CollaborationAnalysis:
        if not refs:
            return self._empty(manuscript_id)

        # Build author → set of co-authors map
        coauth: Dict[str, set] = defaultdict(set)
        all_authors: List[str] = []
        for ref in refs:
            authors = [a.strip() for a in (ref.get("authors") or []) if a.strip()]
            if not authors:
                continue
            for a in authors:
                coauth[a].update(set(authors) - {a})
            all_authors.extend(authors)

        if not all_authors:
            return self._empty(manuscript_id)

        # Unique author groups (unique ref author-set signatures)
        unique_groups = len({
            frozenset(a.strip() for a in (ref.get("authors") or []) if a.strip())
            for ref in refs if (ref.get("authors") or [])
        })

        # Top collaborators by co-author count
        top = sorted(coauth.items(), key=lambda x: len(x[1]), reverse=True)[:5]
        top_collaborators = [f"{a} ({len(cs)} co-authors)" for a, cs in top]

        # Diversity: Shannon entropy over authors
        author_counts = Counter(all_authors)
        diversity = round(_shannon(list(author_counts.values())), 3)

        # Cross-institutional proxy: ratio of refs with >3 authors
        multi_auth = sum(1 for r in refs if len(r.get("authors") or []) > 3)
        cross_ratio = round(multi_auth / len(refs), 3)

        # Most productive pair
        pair_counts: Counter = Counter()
        for ref in refs:
            authors = [a.strip() for a in (ref.get("authors") or []) if a.strip()]
            for i in range(len(authors)):
                for j in range(i + 1, len(authors)):
                    pair = tuple(sorted([authors[i], authors[j]]))
                    pair_counts[pair] += 1
        best_pair = pair_counts.most_common(1)[0][0] if pair_counts else ("—", "—")

        # Effectiveness score
        eff = round(0.4 * diversity + 0.3 * cross_ratio + 0.3 * min(1.0, unique_groups / 20), 3)

        recs = []
        if diversity < 0.5:
            recs.append("Reference set is concentrated around few authors — broaden to more research groups.")
        if cross_ratio < 0.4:
            recs.append("Low multi-author papers — include more collaborative (>3 author) publications.")
        if unique_groups < 10:
            recs.append("Diversify references across more independent research groups.")
        if not recs:
            recs.append("Good collaboration diversity in reference set.")

        return CollaborationAnalysis(
            manuscript_id=manuscript_id,
            unique_author_groups=unique_groups,
            top_collaborators=top_collaborators,
            collaboration_diversity_score=diversity,
            cross_institutional_ratio=cross_ratio,
            most_productive_pair=best_pair,
            effectiveness_score=eff,
            recommendations=recs,
        )

    @staticmethod
    def _empty(mid: str) -> CollaborationAnalysis:
        return CollaborationAnalysis(
            manuscript_id=mid, unique_author_groups=0, top_collaborators=[],
            collaboration_diversity_score=0.0, cross_institutional_ratio=0.0,
            most_productive_pair=("—", "—"), effectiveness_score=0.0,
            recommendations=["No author data available."],
        )


# ── Portfolio Optimizer ────────────────────────────────────────────────────────

class PortfolioOptimizer:
    """Analyses journal & topic diversity, impact distribution, and risk."""

    def analyze(self, manuscript_id: str, refs: List[Dict]) -> PortfolioAnalysis:
        if not refs:
            return self._empty(manuscript_id)

        jq = _load_jq()

        # Journal diversity
        journals = [r.get("journal") or "Unknown" for r in refs]
        j_counts = Counter(journals)
        j_diversity = round(_shannon(list(j_counts.values())), 3)
        max_j_share = max(j_counts.values()) / len(refs)
        over_conc = max_j_share > 0.35

        # Topic/area diversity
        topics = [r.get("research_area") or r.get("entry_type") or "other" for r in refs]
        t_counts = Counter(topics)
        t_diversity = round(_shannon(list(t_counts.values())), 3)

        # Impact distribution
        dist: Dict[str, int] = {"Q1": 0, "Q2": 0, "Q3": 0, "Q4": 0, "Unknown": 0}
        if_vals: List[float] = []
        for ref in refs:
            info = _jq_lookup(ref.get("journal") or "", jq)
            q = info["q_wos"] or info["q_scopus"]
            if q in dist:
                dist[q] += 1
            else:
                dist["Unknown"] += 1
            if info["if"] > 0:
                if_vals.append(info["if"])

        # Portfolio efficiency: high IF share weighted by diversity
        avg_if = sum(if_vals) / len(if_vals) if if_vals else 0.0
        hi_q_ratio = (dist["Q1"] + dist["Q2"]) / len(refs)
        efficiency = round(0.4 * j_diversity + 0.3 * t_diversity + 0.3 * hi_q_ratio, 3)

        # Risk
        if over_conc or j_diversity < 0.4:
            risk = "high"
        elif j_diversity < 0.6 or t_diversity < 0.4:
            risk = "medium"
        else:
            risk = "low"

        opps = []
        if dist["Q1"] / len(refs) < 0.2:
            opps.append("Increase Q1 journal references to strengthen impact profile.")
        if j_diversity < 0.5:
            opps.append(f"Diversify journals — top journal covers {max_j_share:.0%} of refs.")
        if t_diversity < 0.4:
            opps.append("Expand topic coverage to strengthen interdisciplinary positioning.")
        if avg_if < 3.0:
            opps.append("Reference average IF is low — target higher-impact publications.")
        if not opps:
            opps.append("Portfolio is well-balanced. Maintain current diversity strategy.")

        return PortfolioAnalysis(
            manuscript_id=manuscript_id,
            total_references=len(refs),
            journal_diversity_score=j_diversity,
            topic_diversity_score=t_diversity,
            impact_distribution=dist,
            over_concentration_warning=over_conc,
            risk_level=risk,
            portfolio_efficiency=efficiency,
            optimization_opportunities=opps,
        )

    @staticmethod
    def _empty(mid: str) -> PortfolioAnalysis:
        return PortfolioAnalysis(
            manuscript_id=mid, total_references=0, journal_diversity_score=0.0,
            topic_diversity_score=0.0, impact_distribution={},
            over_concentration_warning=False, risk_level="unknown",
            portfolio_efficiency=0.0, optimization_opportunities=["No references."],
        )


# ── Strategic Planner ─────────────────────────────────────────────────────────

class StrategicPlanner:
    """Generates a forward-looking research roadmap from corpus analysis."""

    def plan(
        self,
        manuscript_id: str,
        refs: List[Dict],
        horizon_months: int = 24,
    ) -> StrategicPlan:
        from .predictive_analytics import ResearchTrendAnalyzer, _timing_advice
        from datetime import datetime

        trend_analyzer = ResearchTrendAnalyzer()
        trends = trend_analyzer.analyze_trends(refs, top_n=10)
        timing = _timing_advice(datetime.now())

        # Current strengths: top research areas by volume
        area_counts = Counter(r.get("research_area") or "unclassified" for r in refs)
        strengths = [f"{a} ({n} refs)" for a, n in area_counts.most_common(4) if a != "unclassified"]

        # Emerging opportunities: growing/emerging topics
        opportunities = [
            t.topic for t in trends if t.trend_phase in ("emerging", "growing")
        ][:5]

        # Recommended directions
        directions = []
        for t in trends[:6]:
            directions.append({
                "topic": t.topic,
                "phase": t.trend_phase,
                "opportunity_score": t.opportunity_score,
                "action": t.recommendation,
                "growth_rate": t.growth_rate,
            })

        # Publication strategy
        jq = _load_jq()
        all_journals = Counter(r.get("journal") or "" for r in refs if r.get("journal"))
        target_journals = [j for j, _ in all_journals.most_common(5) if j]
        pub_strategy = {
            "optimal_submission_window": timing["window_label"],
            "timing_advice": timing["advice"],
            "is_optimal_now": timing["is_optimal"],
            "recommended_journals": target_journals,
            "target_quartile": "Q1/Q2",
        }

        # Resource allocation (percentage of effort)
        resource_alloc = {
            "research_writing": 35,
            "literature_review": 20,
            "collaboration_networking": 20,
            "grant_applications": 15,
            "conference_dissemination": 10,
        }

        # Milestones
        milestones = []
        for i, month in enumerate([3, 6, 12, 18, horizon_months]):
            if month > horizon_months:
                break
            milestones.append({
                "month": month,
                "target": [
                    "Complete systematic literature gap analysis",
                    "Submit first manuscript to target journal",
                    "Establish key collaboration partnerships",
                    "Present results at major conference",
                    f"Achieve {horizon_months}-month strategic objectives",
                ][i],
            })

        # Risk mitigations
        risk_mits = [
            "Maintain backup journal list for each submission.",
            "Build collaboration network before projects require it.",
            "Track emerging competitor publications monthly.",
            "Diversify funding sources across grant agencies.",
        ]

        return StrategicPlan(
            manuscript_id=manuscript_id,
            planning_horizon_months=horizon_months,
            current_strengths=strengths,
            emerging_opportunities=opportunities,
            recommended_directions=directions,
            publication_strategy=pub_strategy,
            resource_allocation=resource_alloc,
            milestones=milestones,
            risk_mitigations=risk_mits,
        )


# ── Competitive Intelligence ───────────────────────────────────────────────────

class CompetitiveIntelligence:
    """Maps the competitive research landscape from the reference corpus."""

    def analyze(
        self, research_area: str, refs: List[Dict]
    ) -> CompetitiveAnalysis:
        area_refs = [
            r for r in refs
            if research_area.lower() in (r.get("research_area") or "").lower()
            or research_area.lower() in (r.get("title") or "").lower()
        ]
        if not area_refs:
            area_refs = refs  # fall back to full corpus

        total = len(area_refs)
        jq = _load_jq()

        # Top journals in area
        journal_counts = Counter(r.get("journal") or "Unknown" for r in area_refs)
        top_journals_raw = journal_counts.most_common(8)
        top_journals = []
        for jname, cnt in top_journals_raw:
            info = _jq_lookup(jname, jq)
            top_journals.append({
                "journal": jname,
                "ref_count": cnt,
                "impact_factor": info["if"],
                "quartile": info["q_wos"] or info["q_scopus"] or "—",
                "share": round(cnt / total, 3),
            })

        # Dominant topics (keywords/areas)
        topic_bag: List[str] = []
        for r in area_refs:
            kws = r.get("keywords") or []
            topic_bag.extend(kw.strip().lower() for kw in kws if len(kw.strip()) > 3)
            area = (r.get("research_area") or "").strip().lower()
            if area:
                topic_bag.append(area)
        dominant_topics = [t for t, _ in Counter(topic_bag).most_common(8)]

        # Research velocity (YoY trend)
        year_counts = Counter(int(r["year"]) for r in area_refs if str(r.get("year") or "").isdigit())
        years = sorted(year_counts)
        if len(years) >= 2:
            recent = sum(year_counts.get(y, 0) for y in years[-2:])
            older  = sum(year_counts.get(y, 0) for y in years[-4:-2]) or 1
            velocity = round((recent - older) / older, 3)
        else:
            velocity = 0.0

        # Competitive position based on volume and recency
        recent_count = sum(year_counts.get(y, 0) for y in years[-2:]) if years else 0
        if recent_count >= 20 and velocity > 0.1:
            position = "leading"
        elif recent_count >= 10:
            position = "active"
        elif recent_count >= 3:
            position = "emerging"
        else:
            position = "niche"

        # White-space: topics with <2 refs in last 2 years
        recent_kws = Counter(
            kw.strip().lower()
            for r in area_refs
            if str(r.get("year") or "0").isdigit() and int(r.get("year", 0)) >= datetime.now().year - 2
            for kw in (r.get("keywords") or [])
            if len(kw.strip()) > 3
        )
        all_kws = Counter(topic_bag)
        white_space = [kw for kw, cnt in all_kws.items() if recent_kws.get(kw, 0) <= 1 and cnt >= 2][:5]

        recs = []
        if velocity < 0:
            recs.append("Field is slowing — pivot toward adjacent emerging sub-areas.")
        if velocity > 0.3:
            recs.append("High-velocity field — accelerate publication to ride the growth wave.")
        if position in ("emerging", "niche"):
            recs.append("Low corpus density — opportunity to establish early presence.")
        if top_journals and top_journals[0]["share"] > 0.4:
            recs.append(f"Dominant journal: {top_journals[0]['journal']} — ensure submissions target it.")
        if white_space:
            recs.append(f"White-space topics worth exploring: {', '.join(white_space[:3])}.")
        if not recs:
            recs.append("Competitive landscape is well-covered. Differentiate through methodology or cross-domain synthesis.")

        return CompetitiveAnalysis(
            research_area=research_area,
            total_refs_in_area=total,
            top_journals=top_journals,
            dominant_topics=dominant_topics,
            research_velocity=velocity,
            competitive_position=position,
            white_space_opportunities=white_space,
            strategic_recommendations=recs,
        )


# ── Orchestrator ───────────────────────────────────────────────────────────────

class StrategicAnalyticsService:
    def __init__(self):
        self._roi    = ResearchROIAnalyzer()
        self._collab = CollaborationAnalyzer()
        self._port   = PortfolioOptimizer()
        self._plan   = StrategicPlanner()
        self._comp   = CompetitiveIntelligence()

    def roi_analysis(self, manuscript_id: str, refs: List[Dict]) -> Dict:
        return asdict(self._roi.analyze(manuscript_id, refs))

    def collaboration_analysis(self, manuscript_id: str, refs: List[Dict]) -> Dict:
        return asdict(self._collab.analyze(manuscript_id, refs))

    def portfolio_analysis(self, manuscript_id: str, refs: List[Dict]) -> Dict:
        return asdict(self._port.analyze(manuscript_id, refs))

    def strategic_plan(self, manuscript_id: str, refs: List[Dict], horizon: int = 24) -> Dict:
        return asdict(self._plan.plan(manuscript_id, refs, horizon))

    def competitive_analysis(self, research_area: str, refs: List[Dict]) -> Dict:
        return asdict(self._comp.analyze(research_area, refs))

    def dashboard(self, manuscript_id: str, refs: List[Dict]) -> Dict:
        """Lightweight summary combining all five engines."""
        roi   = self._roi.analyze(manuscript_id, refs)
        port  = self._port.analyze(manuscript_id, refs)
        collab = self._collab.analyze(manuscript_id, refs)

        # Top area for competitive snapshot
        area_counts = Counter(r.get("research_area") or "" for r in refs if r.get("research_area"))
        top_area = area_counts.most_common(1)[0][0] if area_counts else "general"
        comp = self._comp.analyze(top_area, refs)

        return {
            "success": True,
            "manuscript_id": manuscript_id,
            "generated_at": _NOW(),
            "key_metrics": {
                "roi_index":            roi.estimated_roi_index,
                "portfolio_efficiency": port.portfolio_efficiency,
                "collaboration_score":  collab.effectiveness_score,
                "reference_count":      len(refs),
                "risk_level":           port.risk_level,
                "competitive_position": comp.competitive_position,
            },
            "roi_breakdown":              roi.roi_breakdown,
            "portfolio_distribution":     port.impact_distribution,
            "optimization_opportunities": port.optimization_opportunities[:3],
            "roi_recommendations":        roi.optimization_recommendations[:3],
            "collaboration_top":          collab.top_collaborators[:3],
            "competitive_area":           top_area,
            "research_velocity":          comp.research_velocity,
            "white_space":                comp.white_space_opportunities[:3],
        }


# ── Singleton ──────────────────────────────────────────────────────────────────

_service: Optional[StrategicAnalyticsService] = None


def get_strategic_analytics_service() -> StrategicAnalyticsService:
    global _service
    if _service is None:
        _service = StrategicAnalyticsService()
    return _service
