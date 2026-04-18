"""Analytics service — aggregates manuscript and reference data."""
import logging
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Dict, List, Any

logger = logging.getLogger(__name__)


def _db():
    try:
        from database.config import db
        return db if db.is_configured() else None
    except Exception:
        return None


def _get_manuscripts(username: str) -> List[Dict]:
    try:
        from tools.manuscript_dashboard.service import get_manuscripts
        return get_manuscripts(username) or []
    except Exception as e:
        logger.warning("Analytics: could not load manuscripts: %s", e)
        return []


def _get_refs_by_area(username: str) -> Dict[str, int]:
    db = _db()
    if db:
        try:
            from database.models import ReferenceEntry
            from collections import Counter as _C
            with db.get_session() as s:
                rows = s.query(ReferenceEntry.research_area).filter(
                    ReferenceEntry.created_by == username
                ).all()
                return dict(_C(r[0] or "general" for r in rows))
        except Exception as e:
            logger.warning("Analytics: DB refs query failed: %s", e)
    try:
        from tools.references.service import get_references
        refs = get_references("", "", 0, 0, "")
        return dict(Counter(r.get("research_area", "general") for r in refs))
    except Exception:
        return {}


def get_overview(username: str) -> Dict:
    manuscripts = _get_manuscripts(username)
    total = len(manuscripts)
    by_status = Counter(m.get("status", "unknown") for m in manuscripts)
    published = by_status.get("published", 0)
    accepted = by_status.get("accepted", 0)
    submitted = by_status.get("submitted", 0)
    pool = published + accepted + submitted
    success_rate = round(published / pool * 100, 1) if pool > 0 else 0.0

    progresses = [m.get("progress_percentage") or 0 for m in manuscripts]
    avg_progress = round(statistics.mean(progresses), 1) if progresses else 0.0

    now = datetime.now(timezone.utc)
    overdue = 0
    for m in manuscripts:
        dl = m.get("target_deadline")
        if dl and m.get("status") not in ("published", "accepted"):
            try:
                d = datetime.fromisoformat(dl.replace("Z", "+00:00"))
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                if d < now:
                    overdue += 1
            except Exception:
                pass

    return {
        "success": True,
        "total_manuscripts": total,
        "published": published,
        "in_progress": total - published,
        "success_rate": success_rate,
        "avg_progress": avg_progress,
        "overdue_count": overdue,
        "by_status": dict(by_status),
    }


def get_pipeline_analytics(username: str) -> Dict:
    manuscripts = _get_manuscripts(username)
    status_counts = Counter(m.get("status", "unknown") for m in manuscripts)
    priority_counts = Counter(m.get("priority", "medium") or "medium" for m in manuscripts)

    buckets = {"0-25": 0, "26-50": 0, "51-75": 0, "76-100": 0}
    for m in manuscripts:
        p = m.get("progress_percentage") or 0
        if p <= 25:
            buckets["0-25"] += 1
        elif p <= 50:
            buckets["26-50"] += 1
        elif p <= 75:
            buckets["51-75"] += 1
        else:
            buckets["76-100"] += 1

    progress_by_status: Dict[str, List[float]] = defaultdict(list)
    for m in manuscripts:
        progress_by_status[m.get("status", "unknown")].append(
            m.get("progress_percentage") or 0
        )
    avg_by_status = {
        s: round(statistics.mean(vals), 1)
        for s, vals in progress_by_status.items() if vals
    }

    return {
        "success": True,
        "status_counts": dict(status_counts),
        "priority_counts": dict(priority_counts),
        "progress_distribution": buckets,
        "avg_progress_by_status": avg_by_status,
        "total": len(manuscripts),
    }


def get_publication_intelligence(username: str) -> Dict:
    manuscripts = _get_manuscripts(username)

    journal_counts = Counter(
        m.get("target_journal") or "Unknown"
        for m in manuscripts if m.get("target_journal")
    )
    top_journals = [
        {"journal": j, "count": c} for j, c in journal_counts.most_common(10)
    ]

    type_counts = Counter(
        m.get("manuscript_type") or "research_article" for m in manuscripts
    )
    area_counts = Counter(
        m.get("research_area") or "general" for m in manuscripts
    )

    published = [m for m in manuscripts if m.get("status") == "published"]
    sub_pool = [
        m for m in manuscripts
        if m.get("status") in ("submitted", "accepted", "published")
    ]
    success_rate = round(len(published) / len(sub_pool) * 100, 1) if sub_pool else 0.0

    times_to_sub: List[int] = []
    now = datetime.now(timezone.utc)
    for m in manuscripts:
        created = m.get("created_at")
        sub_date = m.get("submission_date")
        if created and sub_date:
            try:
                c = datetime.fromisoformat(created.replace("Z", "+00:00"))
                s = datetime.fromisoformat(sub_date.replace("Z", "+00:00"))
                if c.tzinfo is None:
                    c = c.replace(tzinfo=timezone.utc)
                if s.tzinfo is None:
                    s = s.replace(tzinfo=timezone.utc)
                days = (s - c).days
                if 0 < days < 3650:
                    times_to_sub.append(days)
            except Exception:
                pass

    avg_days = round(statistics.mean(times_to_sub), 0) if times_to_sub else None

    return {
        "success": True,
        "top_journals": top_journals,
        "type_distribution": dict(type_counts),
        "area_distribution": dict(area_counts),
        "success_rate": success_rate,
        "avg_days_to_submission": avg_days,
        "published_count": len(published),
        "submitted_count": len([m for m in manuscripts if m.get("status") == "submitted"]),
        "accepted_count": len([m for m in manuscripts if m.get("status") == "accepted"]),
    }


def get_research_performance(username: str) -> Dict:
    manuscripts = _get_manuscripts(username)

    collab_counts = Counter(
        m.get("collaboration_type") or "internal" for m in manuscripts
    )

    author_freq: Counter = Counter()
    for m in manuscripts:
        authors = m.get("authors") or []
        if isinstance(authors, list):
            for a in authors:
                if a and isinstance(a, str):
                    author_freq[a.strip()] += 1
    top_authors = [
        {"author": a, "count": c} for a, c in author_freq.most_common(10)
    ]

    area_by_year: Dict[int, Counter] = defaultdict(Counter)
    for m in manuscripts:
        created = m.get("created_at")
        area = m.get("research_area") or "general"
        if created:
            try:
                yr = datetime.fromisoformat(created.replace("Z", "+00:00")).year
                area_by_year[yr][area] += 1
            except Exception:
                pass

    refs_by_area = _get_refs_by_area(username)

    word_counts = [m.get("word_count") or 0 for m in manuscripts if m.get("word_count")]
    avg_word_count = round(statistics.mean(word_counts), 0) if word_counts else 0

    return {
        "success": True,
        "collaboration_types": dict(collab_counts),
        "top_authors": top_authors,
        "area_by_year": {str(y): dict(c) for y, c in sorted(area_by_year.items())},
        "refs_by_area": refs_by_area,
        "avg_word_count": avg_word_count,
        "total_manuscripts": len(manuscripts),
    }


def get_predictive_analytics(username: str) -> Dict:
    manuscripts = _get_manuscripts(username)
    now = datetime.now(timezone.utc)

    deadline_risk: List[Dict] = []
    for m in manuscripts:
        dl = m.get("target_deadline")
        status = m.get("status", "")
        progress = m.get("progress_percentage") or 0
        if dl and status not in ("published", "accepted"):
            try:
                d = datetime.fromisoformat(dl.replace("Z", "+00:00"))
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                days_left = (d - now).days
                if days_left < 0:
                    risk = "overdue"
                elif days_left < 30 and progress < 80:
                    risk = "high"
                elif days_left < 60 and progress < 60:
                    risk = "medium"
                else:
                    risk = "low"
                deadline_risk.append({
                    "id": m.get("id", ""),
                    "title": (m.get("title") or "")[:60],
                    "days_left": days_left,
                    "progress": progress,
                    "risk": risk,
                    "status": status,
                })
            except Exception:
                pass

    _risk_order = {"overdue": 0, "high": 1, "medium": 2, "low": 3}
    deadline_risk.sort(key=lambda x: (_risk_order.get(x["risk"], 4), x["days_left"]))

    velocity_data: List[float] = []
    for m in manuscripts:
        created = m.get("created_at")
        progress = m.get("progress_percentage") or 0
        if created and progress > 5:
            try:
                c = datetime.fromisoformat(created.replace("Z", "+00:00"))
                if c.tzinfo is None:
                    c = c.replace(tzinfo=timezone.utc)
                days = (now - c).days
                if days > 0:
                    velocity_data.append(days / progress)
            except Exception:
                pass

    avg_velocity = round(statistics.mean(velocity_data), 2) if velocity_data else None
    risk_summary = dict(Counter(r["risk"] for r in deadline_risk))

    return {
        "success": True,
        "deadline_risk": deadline_risk[:20],
        "risk_summary": risk_summary,
        "avg_days_per_percent": avg_velocity,
        "total_at_risk": sum(
            v for k, v in risk_summary.items() if k in ("overdue", "high")
        ),
    }


def get_trends(username: str) -> Dict:
    manuscripts = _get_manuscripts(username)

    monthly: Dict[str, int] = defaultdict(int)
    for m in manuscripts:
        created = m.get("created_at")
        if created:
            try:
                dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                monthly[f"{dt.year}-{dt.month:02d}"] += 1
            except Exception:
                pass
    monthly_sorted = sorted(monthly.items())[-24:]

    kw_freq: Counter = Counter()
    for m in manuscripts:
        kws = m.get("keywords") or ""
        if isinstance(kws, str):
            for kw in kws.split(","):
                kw = kw.strip().lower()
                if len(kw) > 2:
                    kw_freq[kw] += 1
    top_keywords = [
        {"keyword": k, "count": c} for k, c in kw_freq.most_common(20)
    ]

    status_by_month: Dict[str, Counter] = defaultdict(Counter)
    for m in manuscripts:
        created = m.get("created_at")
        status = m.get("status", "unknown")
        if created:
            try:
                dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                status_by_month[f"{dt.year}-{dt.month:02d}"][status] += 1
            except Exception:
                pass
    status_trend = {
        k: dict(v) for k, v in sorted(status_by_month.items())[-12:]
    }

    return {
        "success": True,
        "monthly_activity": [{"month": k, "count": v} for k, v in monthly_sorted],
        "top_keywords": top_keywords,
        "status_by_month": status_trend,
    }
