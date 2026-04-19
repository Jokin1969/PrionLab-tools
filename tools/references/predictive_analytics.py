"""Predictive Impact Modeling — pure Python, no sklearn/tensorflow/numpy.

Implements:
- PublicationSuccessPredictor   (heuristic scoring + logistic sigmoid)
- CitationForecastingEngine     (exponential smoothing + growth extrapolation)
- ResearchTrendAnalyzer         (year-over-year growth, phase classification)
- PredictiveAnalyticsService    (orchestrator)
"""
import json
import logging
import math
import os
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ── Dataclasses ────────────────────────────────────────────────────────────────

@dataclass
class PublicationSuccessPrediction:
    manuscript_id: str
    target_journal: str
    acceptance_probability: float
    confidence_low: float
    confidence_high: float
    predicted_review_days: int
    optimization_suggestions: List[str]
    alternative_journals: List[Dict]
    prediction_factors: Dict


@dataclass
class CitationForecast:
    reference_id: str
    forecast_months: int
    monthly_predictions: List[int]
    confidence_low: List[float]
    confidence_high: List[float]
    peak_month: int
    total_predicted: int
    impact_tier: str          # 'high' | 'medium' | 'low'
    field_percentile: float   # 0-100


@dataclass
class ResearchTrendPrediction:
    topic: str
    trend_phase: str          # 'emerging' | 'growing' | 'mature' | 'declining'
    growth_rate: float        # YoY proportion, e.g. 0.25 = +25%
    opportunity_score: float  # 0-1
    pub_count: int
    related_topics: List[str]
    recommendation: str
    years_data: Dict[int, int]


# ── Journal quality helpers ────────────────────────────────────────────────────

def _load_journal_quality() -> List[Dict]:
    try:
        from tools.manuscriptforge.models import load_journal_quality
        return load_journal_quality().to_dict("records")
    except Exception:
        return []


def _journal_if(journal_name: str, jq_cache: Optional[List[Dict]] = None) -> float:
    """Return impact factor for a journal name (fuzzy match)."""
    if jq_cache is None:
        jq_cache = _load_journal_quality()
    jl = journal_name.lower()
    for j in jq_cache:
        if jl in (j.get("name") or "").lower():
            try:
                return float(j.get("impact_factor") or 0)
            except (ValueError, TypeError):
                return 0.0
    return 0.0


def _journal_quartile(journal_name: str, jq_cache: Optional[List[Dict]] = None) -> int:
    """Return WoS quartile as int 1-4 (0 if unknown)."""
    if jq_cache is None:
        jq_cache = _load_journal_quality()
    jl = journal_name.lower()
    for j in jq_cache:
        if jl in (j.get("name") or "").lower():
            q = (j.get("quartile_wos") or "").strip()
            if q in ("Q1", "Q2", "Q3", "Q4"):
                return int(q[1])
    return 0


# ── Sigmoid helper ─────────────────────────────────────────────────────────────

def _sigmoid(x: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-x))
    except OverflowError:
        return 0.0 if x < 0 else 1.0


# ── Publication Success Predictor ─────────────────────────────────────────────

class PublicationSuccessPredictor:
    """Heuristic logistic scorer for journal acceptance probability.

    No training data required. Scores are derived from manuscript quality
    signals and journal prestige metrics available in our existing data.
    """

    # Weighted feature coefficients (logit space, tuned heuristically)
    _WEIGHTS = {
        "abstract_length":    0.0008,   # chars
        "reference_count":    0.012,
        "author_count":       0.08,
        "has_abstract":       0.6,
        "has_doi_refs":       0.4,
        "area_match":         0.9,
        "journal_if":        -0.06,     # higher IF → harder (negative)
        "journal_quartile":  -0.25,     # Q1=1, penalty increases
        "keyword_density":    0.3,
    }
    _BIAS = -0.5

    def __init__(self):
        self._jq = _load_journal_quality()

    def predict(self, manuscript_data: Dict, target_journal: str) -> PublicationSuccessPrediction:
        factors = self._compute_factors(manuscript_data, target_journal)
        logit = self._BIAS + sum(self._WEIGHTS.get(k, 0) * v for k, v in factors.items())
        prob = round(_sigmoid(logit), 3)

        # Confidence interval: ±0.08 shrunk at extremes
        margin = 0.08 * (1 - abs(prob - 0.5) * 1.6)
        ci_low  = round(max(0.0, prob - margin), 3)
        ci_high = round(min(1.0, prob + margin), 3)

        suggestions = self._suggestions(factors, prob)
        alt_journals = self._alternatives(manuscript_data, target_journal)
        review_days  = self._review_days(target_journal)

        return PublicationSuccessPrediction(
            manuscript_id=manuscript_data.get("manuscript_id", ""),
            target_journal=target_journal,
            acceptance_probability=prob,
            confidence_low=ci_low,
            confidence_high=ci_high,
            predicted_review_days=review_days,
            optimization_suggestions=suggestions,
            alternative_journals=alt_journals,
            prediction_factors={k: round(v, 4) for k, v in factors.items()},
        )

    def _compute_factors(self, ms: Dict, journal: str) -> Dict:
        abstract = ms.get("abstract", "") or ""
        refs      = ms.get("references", []) or []
        authors   = ms.get("authors", []) or []
        keywords  = ms.get("keywords", []) or []
        area      = (ms.get("research_area") or "").lower()

        doi_refs = sum(1 for r in refs if r.get("doi"))

        jif  = _journal_if(journal, self._jq)
        jq   = _journal_quartile(journal, self._jq)

        # Research-area match: does the journal name contain area keywords?
        area_words = set(re.split(r"\W+", area)) - {"", "of", "the", "and", "in"}
        jl = journal.lower()
        area_match = min(1.0, sum(1 for w in area_words if w and w in jl) * 0.4)

        return {
            "abstract_length":  len(abstract),
            "reference_count":  len(refs),
            "author_count":     len(authors),
            "has_abstract":     1.0 if len(abstract) > 100 else 0.0,
            "has_doi_refs":     min(1.0, doi_refs / max(1, len(refs))),
            "area_match":       area_match,
            "journal_if":       jif,
            "journal_quartile": jq,
            "keyword_density":  min(1.0, len(keywords) / 8),
        }

    def _suggestions(self, factors: Dict, prob: float) -> List[str]:
        out = []
        if factors["abstract_length"] < 150:
            out.append("Expand abstract to at least 200 characters to strengthen framing.")
        if factors["reference_count"] < 20:
            out.append("Add more references — journals typically expect 25+ citations.")
        if factors["has_doi_refs"] < 0.5:
            out.append("Include DOIs for cited references to improve traceability.")
        if factors["keyword_density"] < 0.5:
            out.append("Add 4–8 targeted keywords to improve discoverability.")
        if factors["area_match"] < 0.2:
            out.append("Consider a journal whose scope better matches your research area.")
        if prob < 0.35:
            out.append("Probability is low — revise manuscript or target a broader-scope journal.")
        return out or ["Manuscript looks well-prepared for this target journal."]

    def _alternatives(self, ms: Dict, exclude: str) -> List[Dict]:
        area = (ms.get("research_area") or "").lower()
        out = []
        for j in self._jq:
            name = j.get("name", "")
            if not name or name.lower() == exclude.lower():
                continue
            subj = (j.get("subject_areas") or "").lower()
            score = sum(1 for w in area.split() if w and len(w) > 3 and w in subj)
            if score > 0:
                try:
                    jif = float(j.get("impact_factor") or 0)
                except (ValueError, TypeError):
                    jif = 0.0
                out.append({"name": name, "impact_factor": jif,
                            "quartile_wos": j.get("quartile_wos", ""),
                            "match_score": score})
        out.sort(key=lambda x: (-x["match_score"], -x["impact_factor"]))
        return out[:5]

    @staticmethod
    def _review_days(journal: str) -> int:
        jl = journal.lower()
        if any(x in jl for x in ("nature", "science", "cell")):
            return 45
        if any(x in jl for x in ("plos", "frontiers", "mdpi")):
            return 60
        return 90


# ── Citation Forecasting Engine ────────────────────────────────────────────────

class CitationForecastingEngine:
    """Exponential-smoothing citation forecast. No tensorflow needed."""

    _ALPHA = 0.3    # smoothing factor
    _BETA  = 0.15   # trend smoothing

    def forecast(
        self,
        reference_id: str,
        refs_in_corpus: List[Dict],
        forecast_months: int = 24,
    ) -> CitationForecast:
        # Build a proxy citation history from co-occurring refs in same manuscripts
        history = self._build_proxy_history(reference_id, refs_in_corpus)
        if not history:
            history = [0]

        preds, lo, hi = self._holt_extrapolate(history, forecast_months)
        peak_m = max(range(len(preds)), key=lambda i: preds[i]) + 1
        total  = sum(preds)
        tier   = "high" if total >= 50 else "medium" if total >= 15 else "low"
        pct    = self._field_percentile(total, refs_in_corpus)

        return CitationForecast(
            reference_id=reference_id,
            forecast_months=forecast_months,
            monthly_predictions=preds,
            confidence_low=lo,
            confidence_high=hi,
            peak_month=peak_m,
            total_predicted=int(total),
            impact_tier=tier,
            field_percentile=round(pct, 1),
        )

    def _build_proxy_history(self, ref_id: str, corpus: List[Dict]) -> List[int]:
        """Approximate citation signal: count corpus refs sharing the same journal/year."""
        target = next((r for r in corpus if r.get("reference_id") == ref_id), None)
        if not target:
            return []
        journal = (target.get("journal") or "").lower()
        year    = target.get("year") or 0
        if not journal or not year:
            return []

        # Count how many corpus refs cite the same journal per subsequent year
        year_counts: Dict[int, int] = Counter(
            r.get("year", 0)
            for r in corpus
            if (r.get("journal") or "").lower() == journal
            and r.get("year", 0) >= year
        )
        if not year_counts:
            return []
        min_y = min(year_counts)
        max_y = max(year_counts)
        return [year_counts.get(y, 0) for y in range(min_y, max_y + 1)]

    def _holt_extrapolate(
        self, history: List[int], n: int
    ) -> Tuple[List[int], List[float], List[float]]:
        """Double exponential (Holt) smoothing + n-step extrapolation."""
        if len(history) < 2:
            val = history[0] if history else 0
            preds = [max(0, int(val))] * n
            lo = [max(0.0, val * 0.6)] * n
            hi = [val * 1.4] * n
            return preds, lo, hi

        # Initialise
        level = float(history[0])
        trend = float(history[1] - history[0])
        for h in history[1:]:
            prev_level = level
            level = self._ALPHA * h + (1 - self._ALPHA) * (level + trend)
            trend = self._BETA * (level - prev_level) + (1 - self._BETA) * trend

        # Forecast
        preds, lo, hi = [], [], []
        std = max(1.0, _std(history))
        for i in range(1, n + 1):
            val = level + trend * i
            val = max(0.0, val)
            preds.append(int(round(val)))
            lo.append(round(max(0.0, val - 1.96 * std), 2))
            hi.append(round(val + 1.96 * std, 2))
        return preds, lo, hi

    @staticmethod
    def _field_percentile(total: int, corpus: List[Dict]) -> float:
        if not corpus:
            return 50.0
        # Proxy: compare against corpus size distribution
        n = len(corpus)
        # Simple heuristic: map total against log scale
        score = math.log1p(total) / math.log1p(max(1, n))
        return round(min(99.9, score * 100), 1)


# ── Research Trend Analyzer ────────────────────────────────────────────────────

class ResearchTrendAnalyzer:
    """Classifies research topic lifecycle from year-over-year publication counts."""

    _CURRENT_YEAR = datetime.now().year

    def analyze_trends(
        self, refs: List[Dict], top_n: int = 15
    ) -> List[ResearchTrendPrediction]:
        topic_years = self._build_topic_years(refs)
        predictions = []
        for topic, years_data in topic_years.items():
            if sum(years_data.values()) < 3:
                continue
            pred = self._classify_topic(topic, years_data, refs)
            if pred:
                predictions.append(pred)
        predictions.sort(key=lambda p: p.opportunity_score, reverse=True)
        return predictions[:top_n]

    def _build_topic_years(self, refs: List[Dict]) -> Dict[str, Dict[int, int]]:
        topic_years: Dict[str, Dict[int, int]] = defaultdict(lambda: defaultdict(int))
        for ref in refs:
            year = ref.get("year") or 0
            if not year:
                continue
            # Use research_area + any keyword tokens as topics
            area = (ref.get("research_area") or "").strip()
            if area:
                topic_years[area][int(year)] += 1
            for kw in (ref.get("keywords") or []):
                kw = kw.strip().lower()
                if len(kw) > 3:
                    topic_years[kw][int(year)] += 1
        return {t: dict(yd) for t, yd in topic_years.items()}

    def _classify_topic(
        self, topic: str, years_data: Dict[int, int], all_refs: List[Dict]
    ) -> Optional[ResearchTrendPrediction]:
        sorted_years = sorted(years_data)
        counts = [years_data[y] for y in sorted_years]
        if len(counts) < 2:
            return None

        recent_growth = _yoy_growth(counts, window=2)
        long_growth   = _yoy_growth(counts, window=min(5, len(counts)))

        phase = self._phase(recent_growth, long_growth, counts)
        opp   = self._opportunity(phase, recent_growth, sum(counts))
        rec   = self._recommendation(phase, opp)
        related = self._related(topic, all_refs, years_data)

        return ResearchTrendPrediction(
            topic=topic,
            trend_phase=phase,
            growth_rate=round(recent_growth, 3),
            opportunity_score=round(opp, 3),
            pub_count=sum(counts),
            related_topics=related[:5],
            recommendation=rec,
            years_data={y: years_data[y] for y in sorted_years},
        )

    @staticmethod
    def _phase(recent: float, long: float, counts: List[int]) -> str:
        total = sum(counts)
        if total <= 5 and recent > 0:
            return "emerging"
        if recent >= 0.15:
            return "growing" if long >= 0 else "emerging"
        if recent >= -0.05:
            return "mature"
        return "declining"

    @staticmethod
    def _opportunity(phase: str, growth: float, total: int) -> float:
        base = {"emerging": 0.85, "growing": 0.70, "mature": 0.40, "declining": 0.15}[phase]
        boost = min(0.15, growth * 0.3)
        size_penalty = min(0.1, math.log1p(total) * 0.01)
        return max(0.0, min(1.0, base + boost - size_penalty))

    @staticmethod
    def _recommendation(phase: str, opp: float) -> str:
        if phase == "emerging":
            return "High opportunity: enter now to establish early presence in this growing area."
        if phase == "growing" and opp > 0.65:
            return "Strong growth: publish soon to ride peak citation potential."
        if phase == "growing":
            return "Steady growth: good time to contribute; competition increasing."
        if phase == "mature":
            return "Mature field: differentiate with novel angles or cross-disciplinary approaches."
        return "Declining interest: pivot toward adjacent emerging areas or offer review synthesis."

    @staticmethod
    def _related(topic: str, refs: List[Dict], exclude: Dict) -> List[str]:
        words = set(re.split(r"\W+", topic.lower())) - {"", "of", "the", "and"}
        scores: Counter = Counter()
        for ref in refs:
            area = (ref.get("research_area") or "").lower()
            for kw in (ref.get("keywords") or []):
                kw = kw.strip().lower()
                if kw and kw != topic and any(w in kw for w in words if len(w) > 3):
                    scores[kw] += 1
            if area and area != topic and any(w in area for w in words if len(w) > 3):
                scores[area] += 1
        return [t for t, _ in scores.most_common(6)]


# ── Orchestrator ───────────────────────────────────────────────────────────────

class PredictiveAnalyticsService:
    def __init__(self):
        self._success  = PublicationSuccessPredictor()
        self._citation = CitationForecastingEngine()
        self._trend    = ResearchTrendAnalyzer()

    def predict_success(self, manuscript_data: Dict, target_journal: str) -> Dict:
        pred = self._success.predict(manuscript_data, target_journal)
        return asdict(pred)

    def forecast_citations(self, reference_id: str, refs: List[Dict], months: int = 24) -> Dict:
        fc = self._citation.forecast(reference_id, refs, months)
        return asdict(fc)

    def analyze_trends(self, refs: List[Dict], top_n: int = 15) -> List[Dict]:
        return [asdict(t) for t in self._trend.analyze_trends(refs, top_n)]

    def manuscript_intelligence(self, manuscript_id: str, refs: List[Dict]) -> Dict:
        """Single-call comprehensive prediction for a manuscript."""
        trends     = self._trend.analyze_trends(refs, top_n=8)
        top_areas  = list({r.get("research_area", "") for r in refs if r.get("research_area")})[:3]
        now        = datetime.now()
        timing_tip = _timing_advice(now)

        return {
            "success": True,
            "manuscript_id": manuscript_id,
            "reference_count": len(refs),
            "top_research_areas": top_areas,
            "trend_analysis": [asdict(t) for t in trends],
            "timing_intelligence": timing_tip,
            "generated_at": now.isoformat(),
        }


# ── Math helpers ───────────────────────────────────────────────────────────────

def _std(values: List) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mu = sum(values) / n
    return math.sqrt(sum((x - mu) ** 2 for x in values) / (n - 1))


def _yoy_growth(counts: List[int], window: int = 3) -> float:
    """Average year-over-year growth rate over last `window` years."""
    if len(counts) < 2:
        return 0.0
    tail = counts[-window:]
    rates = []
    for i in range(1, len(tail)):
        prev = tail[i - 1]
        curr = tail[i]
        if prev > 0:
            rates.append((curr - prev) / prev)
        elif curr > 0:
            rates.append(1.0)
    return sum(rates) / len(rates) if rates else 0.0


def _timing_advice(dt: datetime) -> Dict:
    month = dt.month
    quarter = (month - 1) // 3 + 1
    # Submission timing heuristics for academic publishing
    windows = {
        1: ("January–February", "Good: editors active after holiday break."),
        2: ("January–February", "Good: editors active after holiday break."),
        3: ("March", "Excellent: high activity before spring conferences."),
        4: ("April", "Good: strong submission period."),
        5: ("May", "Moderate: pre-conference rush; reviewers busy."),
        6: ("June", "Moderate: summer slowdown beginning."),
        7: ("July–August", "Slower: reviewer availability drops."),
        8: ("July–August", "Slower: reviewer availability drops."),
        9: ("September", "Excellent: post-summer resurgence."),
        10: ("October", "Very good: high editorial activity."),
        11: ("November", "Good: before holiday slowdown."),
        12: ("December", "Slower: holiday period; consider January."),
    }
    label, note = windows.get(month, ("", ""))
    return {
        "current_month": month,
        "quarter": quarter,
        "window_label": label,
        "advice": note,
        "optimal_months": [3, 4, 9, 10],
        "is_optimal": month in [3, 4, 9, 10],
    }


# ── Singleton ──────────────────────────────────────────────────────────────────

_service: Optional[PredictiveAnalyticsService] = None


def get_predictive_service() -> PredictiveAnalyticsService:
    global _service
    if _service is None:
        _service = PredictiveAnalyticsService()
    return _service
