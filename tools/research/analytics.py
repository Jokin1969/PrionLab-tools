import logging
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Dict, List

from tools.research.models import (
    PUBLICATIONS_CSV, CITATIONS_CSV, PUB_AUTHORS_CSV,
    RESEARCH_METRICS_CSV,
    _read, _write,
    _PUB_COLS, _CITE_COLS, _AUTH_COLS, _METRICS_COLS,
    get_all_publications,
)

logger = logging.getLogger(__name__)

USAGE_CSV = __import__("os").path.join(
    __import__("config").CSV_DIR, "usage_analytics.csv"
)
_USAGE_COLS = [
    "usage_id", "user_id", "action_type", "export_type",
    "publication_count", "citation_style", "timestamp", "success",
]


# ── ResearchAnalytics ─────────────────────────────────────────────────────────

class ResearchAnalytics:
    """Aggregate research metrics from CSV data."""

    def generate_overview_dashboard(self) -> Dict:
        pubs = _read(PUBLICATIONS_CSV, _PUB_COLS)
        if not pubs:
            return {"error": "No publications data available"}

        total_pubs = len(pubs)

        # Citation totals from times_cited column
        total_citations = 0
        for p in pubs:
            try:
                total_citations += int(p.get("times_cited", 0) or 0)
            except (ValueError, TypeError):
                pass

        h_index = self._calculate_h_index(pubs)

        by_year: Dict[str, int] = Counter(p.get("year", "Unknown") for p in pubs)
        by_journal: Dict[str, int] = Counter(p.get("journal", "Unknown") for p in pubs)
        by_type: Dict[str, int] = Counter(p.get("pub_type", "other") for p in pubs)

        growth = self._calculate_growth_trend(by_year)
        recent = sum(v for k, v in by_year.items() if k.isdigit() and int(k) >= 2024)

        return {
            "overview": {
                "total_publications": total_pubs,
                "total_citations": total_citations,
                "h_index": h_index,
                "average_impact_factor": 0.0,
            },
            "trends": {
                "publications_by_year": dict(sorted(by_year.items())),
                "recent_publications": recent,
                "growth_trend": growth,
            },
            "distribution": {
                "top_journals": dict(sorted(by_journal.items(), key=lambda x: x[1], reverse=True)[:10]),
                "research_areas": {},
                "publication_types": dict(by_type),
            },
            "collaboration": {
                "collaboration_rate": self._calculate_collaboration_rate(pubs),
                "lab_vs_external": self._analyze_authorship_patterns(pubs),
            },
            "generated_at": datetime.utcnow().isoformat(),
        }

    def _calculate_h_index(self, pubs: List[Dict]) -> int:
        counts = sorted(
            [int(p.get("times_cited", 0) or 0) for p in pubs],
            reverse=True,
        )
        h = 0
        for i, c in enumerate(counts, 1):
            if c >= i:
                h = i
            else:
                break
        return h

    def _calculate_growth_trend(self, by_year: Dict[str, int]) -> str:
        years = sorted(k for k in by_year if k.isdigit())
        if len(years) < 4:
            return "stable"
        recent = sum(by_year[y] for y in years[-3:]) / 3
        earlier = sum(by_year[y] for y in years[:-3]) / max(1, len(years) - 3)
        if recent > earlier * 1.2:
            return "increasing"
        if recent < earlier * 0.8:
            return "decreasing"
        return "stable"

    def _calculate_collaboration_rate(self, pubs: List[Dict]) -> float:
        if not pubs:
            return 0.0
        collaborative = sum(
            1 for p in pubs
            if len([a for a in p.get("author_string", "").split(",") if a.strip()]) > 1
        )
        return round((collaborative / len(pubs)) * 100, 1)

    def _analyze_authorship_patterns(self, pubs: List[Dict]) -> Dict:
        return {
            "lab_only_count": 0,
            "collaborative_count": len(pubs),
            "lab_only_percentage": 0.0,
            "collaborative_percentage": 100.0,
        }

    def generate_impact_analysis(self) -> Dict:
        pubs = _read(PUBLICATIONS_CSV, _PUB_COLS)
        if not pubs:
            return {"error": "No publications data available"}

        top_cited = sorted(
            [
                {
                    "title": p.get("title", ""),
                    "journal": p.get("journal", ""),
                    "year": p.get("year", ""),
                    "citations": int(p.get("times_cited", 0) or 0),
                }
                for p in pubs
            ],
            key=lambda x: x["citations"],
            reverse=True,
        )

        by_journal: Dict[str, list] = defaultdict(list)
        for p in pubs:
            j = p.get("journal", "")
            try:
                c = int(p.get("times_cited", 0) or 0)
                if c > 0:
                    by_journal[j].append(c)
            except (ValueError, TypeError):
                pass

        avg_journal_impact = {
            j: round(sum(vs) / len(vs), 2)
            for j, vs in by_journal.items() if vs
        }

        return {
            "top_cited_publications": top_cited[:10],
            "journal_impact_factors": avg_journal_impact,
            "total_citations": sum(int(p.get("times_cited", 0) or 0) for p in pubs),
            "highly_cited_count": sum(
                1 for p in pubs if int(p.get("times_cited", 0) or 0) >= 10
            ),
            "generated_at": datetime.utcnow().isoformat(),
        }

    def generate_collaboration_network(self) -> Dict:
        pubs = get_all_publications()
        if not pubs:
            return {"error": "No publications data available"}

        author_publications: Dict[str, list] = defaultdict(list)
        collaborations: Dict[tuple, int] = defaultdict(int)

        for p in pubs:
            authors = [
                a.get("last_name", "") + " " + a.get("initials", "")
                for a in p.get("authors", [])
                if a.get("last_name")
            ]
            pid = p.get("pub_id", "")
            for i, a1 in enumerate(authors):
                author_publications[a1].append(pid)
                for a2 in authors[i + 1:]:
                    pair = tuple(sorted([a1, a2]))
                    collaborations[pair] += 1

        top_collabs = sorted(
            collaborations.items(), key=lambda x: x[1], reverse=True
        )[:10]

        top_authors = sorted(
            author_publications.items(), key=lambda x: len(x[1]), reverse=True
        )[:10]

        return {
            "collaboration_network": {
                "top_collaborations": [
                    {"authors": list(pair), "count": cnt}
                    for pair, cnt in top_collabs
                ],
                "external_collaborations": [],
                "total_unique_collaborations": len(collaborations),
            },
            "author_analysis": {
                "most_productive_authors": [
                    {"author": a, "publication_count": len(pubs_list)}
                    for a, pubs_list in top_authors
                ],
                "total_unique_authors": len(author_publications),
                "lab_members_count": 0,
            },
            "network_metrics": {
                "collaboration_density": round(
                    len(collaborations) / max(1, len(author_publications)), 2
                ),
                "average_collaborators_per_author": round(
                    sum(len(v) for v in author_publications.values()) / max(1, len(author_publications)), 2
                ),
            },
            "generated_at": datetime.utcnow().isoformat(),
        }


# ── ExportAnalytics ───────────────────────────────────────────────────────────

class ExportAnalytics:
    """Track and report on citation / bibliography export usage."""

    def track_citation_export(
        self, user_id: str, export_type: str, publication_count: int, style: str
    ):
        rows = _read(USAGE_CSV, _USAGE_COLS)
        rows.append({
            "usage_id": "use_" + uuid.uuid4().hex[:8],
            "user_id": user_id,
            "action_type": "citation_export",
            "export_type": export_type,
            "publication_count": str(publication_count),
            "citation_style": style,
            "timestamp": datetime.utcnow().isoformat(),
            "success": "true",
        })
        _write(USAGE_CSV, _USAGE_COLS, rows)

    def generate_usage_report(self, days: int = 30) -> Dict:
        rows = _read(USAGE_CSV, _USAGE_COLS)
        cutoff = datetime.utcnow() - timedelta(days=days)
        recent = [
            r for r in rows
            if _parse_ts(r.get("timestamp", "")) >= cutoff
        ]

        total = len(recent)
        export_types = Counter(r.get("export_type", "") for r in recent)
        styles = Counter(r.get("citation_style", "") for r in recent)
        daily: Dict[str, int] = defaultdict(int)
        for r in recent:
            day = r.get("timestamp", "")[:10]
            daily[day] += 1

        return {
            "usage_summary": {
                "total_exports": total,
                "period_days": days,
                "average_daily_exports": round(total / max(1, days), 2),
            },
            "export_breakdown": dict(export_types),
            "style_preferences": dict(styles),
            "daily_usage": dict(sorted(daily.items())),
            "top_export_days": sorted(
                daily.items(), key=lambda x: x[1], reverse=True
            )[:5],
            "generated_at": datetime.utcnow().isoformat(),
        }


def _parse_ts(ts: str) -> datetime:
    try:
        return datetime.fromisoformat(ts)
    except Exception:
        return datetime.min
