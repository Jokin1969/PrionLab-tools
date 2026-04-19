"""P22 Analytics integration — performance-weighted recommendation boosting."""
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

_HIGH_IMPACT_JOURNALS = {
    "nature", "science", "cell", "nature medicine", "nature neuroscience",
    "pnas", "lancet", "new england journal of medicine", "nejm",
    "acta neuropathologica", "brain", "neuron", "journal of neuroscience",
    "molecular neurodegeneration", "annals of neurology",
}

_STRONG_JOURNALS = {
    "plos biology", "plos pathogens", "plos one", "elife",
    "journal of biological chemistry", "biochemistry",
    "neurobiology of disease", "neurobiology of aging",
    "prion", "brain pathology",
}


def _get_analytics_context(username: str) -> Dict:
    """Pull lightweight signals from the analytics service."""
    try:
        from tools.analytics.service import get_publication_intelligence
        intel = get_publication_intelligence(username)
        return {
            "success_rate": intel.get("success_rate", 0),
            "top_journals": [j["journal"].lower() for j in intel.get("top_journals", [])[:5]],
            "area_distribution": intel.get("area_distribution", {}),
        }
    except Exception as e:
        logger.debug("analytics_integration context: %s", e)
        return {}


def _journal_boost(journal: str, context: Dict) -> float:
    j = journal.lower()
    if j in _HIGH_IMPACT_JOURNALS:
        return 0.12
    if j in _STRONG_JOURNALS:
        return 0.06
    # Boost journals that appear in the user's own success patterns
    if j in context.get("top_journals", []):
        return 0.05
    return 0.0


def _recency_boost(year: int) -> float:
    if not year:
        return 0.0
    current = datetime.now().year
    age = current - year
    if age <= 1:
        return 0.10
    if age <= 3:
        return 0.06
    if age <= 5:
        return 0.02
    return 0.0


def _collaboration_boost(authors: List[str]) -> float:
    if len(authors) >= 6:
        return 0.05
    if len(authors) >= 3:
        return 0.02
    return 0.0


class AnalyticsIntegrationService:

    def enhance_recommendations(
        self, recommendations: List[Dict], username: str = ""
    ) -> List[Dict]:
        """Apply analytics-based boosts to recommendation dicts."""
        if not recommendations:
            return recommendations
        context = _get_analytics_context(username)
        enhanced = []
        for rec in recommendations:
            rec = dict(rec)
            boost = 0.0
            boost_notes = []

            jb = _journal_boost(rec.get("journal", ""), context)
            if jb:
                boost += jb
                boost_notes.append("high-impact journal")

            rb = _recency_boost(rec.get("year", 0))
            if rb:
                boost += rb
                boost_notes.append("recent publication")

            cb = _collaboration_boost(rec.get("authors") or [])
            if cb:
                boost += cb
                boost_notes.append("collaborative work")

            if boost:
                rec["relevance_score"] = min(rec.get("relevance_score", 0) + boost, 1.0)
                note = " [+" + ", ".join(boost_notes) + "]"
                rec["explanation"] = rec.get("explanation", "") + note

            enhanced.append(rec)

        enhanced.sort(key=lambda r: r.get("relevance_score", 0), reverse=True)
        return enhanced

    def get_temporal_trends(self, manuscript_id: str) -> Dict:
        """Surface emerging topics relevant to this manuscript."""
        try:
            from tools.references.service import get_references
            refs = get_references(manuscript_id, "", 0, 0, "")
        except Exception:
            return {"success": True, "trends": [], "emerging_topics": []}

        current_year = datetime.now().year
        _TOPICS = {
            "rt-quic": 2010, "liquid-liquid phase separation": 2017,
            "prion-like spreading": 2012, "tau propagation": 2013,
            "therapeutic target": 2015, "biomarker": 2018,
            "cryo-em": 2015, "single-cell": 2016,
        }

        topic_counts: Dict[str, int] = {}
        topic_recent: Dict[str, int] = {}
        for ref in refs:
            text = f"{ref.get('title','')} {ref.get('abstract','')}".lower()
            y = ref.get("year") or 0
            for topic in _TOPICS:
                if topic in text:
                    topic_counts[topic] = topic_counts.get(topic, 0) + 1
                    if y >= current_year - 3:
                        topic_recent[topic] = topic_recent.get(topic, 0) + 1

        # Emerging = topic with rising trend (more recent mentions than older)
        emerging = []
        for topic, start_year in _TOPICS.items():
            total = topic_counts.get(topic, 0)
            recent_share = topic_recent.get(topic, 0) / max(total, 1)
            if total > 0 and recent_share > 0.4:
                emerging.append({
                    "topic": topic,
                    "total_mentions": total,
                    "recent_mentions": topic_recent.get(topic, 0),
                    "trend_start": start_year,
                    "momentum": round(recent_share, 2),
                })

        emerging.sort(key=lambda t: t["momentum"], reverse=True)

        return {
            "success": True,
            "emerging_topics": emerging[:10],
            "total_refs_analysed": len(refs),
        }


_analytics_svc: Optional[AnalyticsIntegrationService] = None


def get_analytics_integration_service() -> AnalyticsIntegrationService:
    global _analytics_svc
    if _analytics_svc is None:
        _analytics_svc = AnalyticsIntegrationService()
    return _analytics_svc
