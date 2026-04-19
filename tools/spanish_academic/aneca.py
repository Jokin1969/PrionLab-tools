"""
ANECA export automation.
Derives Q1/Q2/Q3/Q4 from impact_factor when Scopus quartile metrics are absent.
Sexenios are estimated from 6-year publication windows.
"""
import csv
import io
import json
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Impact-factor thresholds used to approximate quartile when no SJR data exists.
# These are broad approximations for biomedical/life-science journals.
_IF_QUARTILE = [
    (10.0, "Q1"),
    (5.0,  "Q1"),
    (3.0,  "Q2"),
    (1.5,  "Q3"),
    (0.0,  "Q4"),
]

_QUARTILE_POINTS = {"Q1": 4.0, "Q2": 3.0, "Q3": 2.0, "Q4": 1.0}

_AREA_LABELS = {
    "neuroscience":   "Neurociencias",
    "biochemistry":   "Bioquímica y Biología Molecular",
    "medicine":       "Medicina Clínica",
    "biology":        "Biología",
    "prion":          "Neurociencias",
    "neurodegeneration": "Neurociencias",
}


@dataclass
class ANECAPub:
    title: str
    authors: str
    journal: str
    year: int
    volume: Optional[str]
    issue: Optional[str]
    pages: Optional[str]
    doi: Optional[str]
    pmid: Optional[str]
    impact_factor: Optional[float]
    quartile: Optional[str]
    research_area: str
    aneca_category: str
    merit_points: float
    citation_count: int


@dataclass
class ANECAProfile:
    username: str
    full_name: str
    orcid: Optional[str]
    affiliation: Optional[str]
    position: Optional[str]
    research_areas: List[str]
    publications: List[ANECAPub]
    total_publications: int
    q1_publications: int
    q2_publications: int
    total_merit_points: float
    avg_impact_factor: Optional[float]
    total_citations: int
    sexenios_eligible: int
    generated_at: str


def _quartile_from_if(impact_factor: Optional[float]) -> Optional[str]:
    if impact_factor is None:
        return None
    for threshold, q in _IF_QUARTILE:
        if impact_factor >= threshold:
            return q
    return "Q4"


def _category(quartile: Optional[str]) -> str:
    return {"Q1": "excelente", "Q2": "buena", "Q3": "aceptable", "Q4": "aceptable"}.get(
        quartile or "", "sin_datos"
    )


def _map_area(raw: str) -> str:
    for key, label in _AREA_LABELS.items():
        if key in (raw or "").lower():
            return label
    return raw or "Ciencias Biomédicas"


def _sexenios(pubs: List[ANECAPub], career_start_year: int) -> int:
    current_year = datetime.now().year
    total_years = current_year - career_start_year
    n_periods = total_years // 6
    eligible = 0
    for period in range(n_periods):
        start = career_start_year + period * 6
        end = start + 6
        period_pubs = [p for p in pubs if start <= p.year < end]
        merit = sum(p.merit_points for p in period_pubs)
        q1 = sum(1 for p in period_pubs if p.quartile == "Q1")
        if merit >= 15.0 or q1 >= 3:
            eligible += 1
    return eligible


def generate_aneca_profile(username: str) -> ANECAProfile:
    """Build an ANECAProfile from database data for *username*."""
    from database.config import db
    from database.models import User, Publication, PublicationMetric
    from sqlalchemy import func

    with db.get_session() as s:
        user = s.query(User).filter_by(username=username).first()
        if not user:
            raise ValueError(f"User '{username}' not found")

        pubs_db = (
            s.query(Publication)
            .filter(
                Publication.created_by_id == user.id,
                Publication.is_lab_publication.is_(True),
            )
            .order_by(Publication.year.desc())
            .all()
        )

        # Build metric lookup: {pub_id: {metric_type: value}}
        metric_map: Dict[str, Dict[str, float]] = {}
        if pubs_db:
            pub_ids = [p.id for p in pubs_db]
            metrics = (
                s.query(PublicationMetric)
                .filter(PublicationMetric.publication_id.in_(pub_ids))
                .all()
            )
            for m in metrics:
                metric_map.setdefault(str(m.publication_id), {})[m.metric_type] = m.value

        aneca_pubs: List[ANECAPub] = []
        for p in pubs_db:
            pm = metric_map.get(str(p.id), {})
            # Prefer explicit SJR quartile from metrics, fall back to IF-based estimation
            quartile = None
            if "quartile" in pm:
                # stored as 1-4 → Q1-Q4
                q_val = int(pm["quartile"])
                quartile = f"Q{q_val}" if 1 <= q_val <= 4 else None
            if not quartile:
                quartile = _quartile_from_if(p.impact_factor)

            merit = _QUARTILE_POINTS.get(quartile or "", 0.0)
            aneca_pubs.append(ANECAPub(
                title=p.title,
                authors=p.authors,
                journal=p.journal,
                year=p.year,
                volume=p.volume,
                issue=p.issue,
                pages=p.pages,
                doi=p.doi,
                pmid=p.pmid,
                impact_factor=p.impact_factor,
                quartile=quartile,
                research_area=_map_area(p.research_area or ""),
                aneca_category=_category(quartile),
                merit_points=merit,
                citation_count=p.citation_count or 0,
            ))

        research_areas_list = [
            a.strip() for a in (user.research_areas or "").split(",") if a.strip()
        ]
        career_start = user.created_at.year if user.created_at else (
            min(p.year for p in aneca_pubs) if aneca_pubs else datetime.now().year - 10
        )
        q1 = sum(1 for p in aneca_pubs if p.quartile == "Q1")
        q2 = sum(1 for p in aneca_pubs if p.quartile == "Q2")
        total_merit = sum(p.merit_points for p in aneca_pubs)
        ifs = [p.impact_factor for p in aneca_pubs if p.impact_factor is not None]
        avg_if = round(sum(ifs) / len(ifs), 3) if ifs else None
        total_cites = sum(p.citation_count for p in aneca_pubs)

        return ANECAProfile(
            username=username,
            full_name=user.full_name,
            orcid=user.orcid,
            affiliation=user.affiliation,
            position=user.position,
            research_areas=research_areas_list,
            publications=aneca_pubs,
            total_publications=len(aneca_pubs),
            q1_publications=q1,
            q2_publications=q2,
            total_merit_points=round(total_merit, 2),
            avg_impact_factor=avg_if,
            total_citations=total_cites,
            sexenios_eligible=_sexenios(aneca_pubs, career_start),
            generated_at=datetime.now(timezone.utc).isoformat(),
        )


def export_json(username: str) -> Dict:
    """Return ANECA profile as a plain dict (JSON-serialisable)."""
    profile = generate_aneca_profile(username)
    d = asdict(profile)
    return d


def export_csv(username: str) -> str:
    """Return ANECA publication list as CSV string."""
    profile = generate_aneca_profile(username)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "Title", "Authors", "Journal", "Year", "Volume", "Issue", "Pages",
        "DOI", "PMID", "Impact Factor", "Quartile", "Research Area",
        "ANECA Category", "Merit Points", "Citations",
    ])
    for p in profile.publications:
        writer.writerow([
            p.title, p.authors, p.journal, p.year,
            p.volume or "", p.issue or "", p.pages or "",
            p.doi or "", p.pmid or "",
            p.impact_factor if p.impact_factor is not None else "",
            p.quartile or "", p.research_area, p.aneca_category,
            p.merit_points, p.citation_count,
        ])
    return buf.getvalue()
