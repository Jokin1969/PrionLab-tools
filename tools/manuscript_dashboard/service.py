"""Manuscript dashboard service — DB-first, CSV fallback."""
import json
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_STATUS_PROGRESS = {
    "draft": 10, "writing": 30, "review": 60,
    "revision": 75, "submitted": 90, "accepted": 95, "published": 100,
}


def _db():
    try:
        from database.config import db
        return db if db.is_configured() else None
    except Exception:
        return None


def _csv_path(name: str) -> str:
    try:
        import config
        base = config.DATA_DIR
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "..", "..", "data")
    return os.path.join(base, name)


# ── JSON file fallback helpers ─────────────────────────────────────────────────

def _load_json_store(path: str) -> List[Dict]:
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_json_store(path: str, data: List[Dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _manuscripts_path() -> str:
    return _csv_path("manuscripts.json")


def _projects_path() -> str:
    return _csv_path("projects.json")


def _activity_path() -> str:
    return _csv_path("manuscript_activity.json")

# ── Project operations ─────────────────────────────────────────────────────────

def create_project(data: Dict, username: str = "") -> Dict:
    name = (data.get("name") or "").strip()
    if not name:
        return {"success": False, "error": "name required"}
    db = _db()
    if db:
        try:
            from database.models import Project
            with db.get_session() as s:
                p = Project(
                    name=name,
                    description=data.get("description", ""),
                    research_area=data.get("research_area", ""),
                    priority=data.get("priority", "medium"),
                    created_by=username,
                )
                s.add(p)
                s.flush()
                pid = str(p.id)
                d = p.to_dict()
            return {"success": True, "project_id": pid, "project": d}
        except Exception as exc:
            logger.warning("DB create_project: %s", exc)
    # CSV fallback
    projects = _load_json_store(_projects_path())
    new_p = {
        "id": str(uuid.uuid4()), "name": name,
        "description": data.get("description", ""),
        "research_area": data.get("research_area", ""),
        "priority": data.get("priority", "medium"),
        "status": "active", "created_by": username,
        "manuscript_count": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "start_date": None, "target_completion": None,
    }
    projects.append(new_p)
    _save_json_store(_projects_path(), projects)
    return {"success": True, "project_id": new_p["id"], "project": new_p}


def get_projects(username: str = "") -> List[Dict]:
    db = _db()
    if db:
        try:
            from database.models import Project
            with db.get_session() as s:
                q = s.query(Project).filter(Project.status == "active")
                if username:
                    q = q.filter(Project.created_by == username)
                return [p.to_dict() for p in q.order_by(Project.name).all()]
        except Exception as exc:
            logger.warning("DB get_projects: %s", exc)
    projects = _load_json_store(_projects_path())
    if username:
        projects = [p for p in projects if p.get("created_by") == username]
    return [p for p in projects if p.get("status", "active") == "active"]

# ── Manuscript CRUD ────────────────────────────────────────────────────────────

def create_manuscript(data: Dict, username: str = "") -> Dict:
    title = (data.get("title") or "").strip()
    if not title:
        return {"success": False, "error": "title required"}
    research_area = (data.get("research_area") or "").strip()
    if not research_area:
        return {"success": False, "error": "research_area required"}

    # Resolve project_id
    project_id = None
    if data.get("project_id"):
        project_id = str(data["project_id"])
    elif data.get("new_project_name"):
        res = create_project({
            "name": data["new_project_name"],
            "description": data.get("project_description", ""),
            "research_area": research_area,
        }, username)
        if res.get("success"):
            project_id = res["project_id"]

    db = _db()
    if db:
        try:
            import uuid as _uuid
            from database.models import Manuscript, ManuscriptStatus
            pid_val = _uuid.UUID(project_id) if project_id else None
            with db.get_session() as s:
                m = Manuscript(
                    title=title, research_area=research_area,
                    manuscript_type=data.get("manuscript_type", "research_article"),
                    priority=data.get("priority", "medium"),
                    target_journal=data.get("target_journal", ""),
                    abstract=data.get("abstract", ""),
                    keywords=data.get("keywords", ""),
                    corresponding_author=data.get("corresponding_author", ""),
                    author_list=json.dumps(data.get("authors", [])),
                    collaboration_type=data.get("collaboration_type", "internal"),
                    external_collaborators=json.dumps(data.get("external_collaborators", [])),
                    funding_sources=json.dumps(data.get("funding_sources", [])),
                    tags=data.get("tags", ""),
                    notes=data.get("notes", ""),
                    project_id=pid_val,
                    created_by=username, last_modified_by=username,
                    status="draft", progress_percentage=0.0,
                )
                if data.get("target_deadline"):
                    try:
                        m.target_deadline = datetime.fromisoformat(data["target_deadline"])
                    except Exception:
                        pass
                s.add(m)
                s.flush()
                mid = str(m.id)
                s.add(ManuscriptStatus(
                    manuscript_id=m.id, status="draft",
                    changed_by=username, notes="Manuscript created",
                ))
                d = m.to_dict()
            _append_activity(mid, title, "Created", username)
            return {"success": True, "manuscript_id": mid, "manuscript": d}
        except Exception as exc:
            logger.warning("DB create_manuscript: %s", exc)

    # CSV fallback
    manuscripts = _load_json_store(_manuscripts_path())
    now = datetime.now(timezone.utc).isoformat()
    new_m: Dict = {
        "id": str(uuid.uuid4()), "title": title, "status": "draft",
        "progress_percentage": 0.0, "research_area": research_area,
        "manuscript_type": data.get("manuscript_type", "research_article"),
        "priority": data.get("priority", "medium"),
        "abstract": data.get("abstract", ""),
        "keywords": data.get("keywords", ""),
        "target_journal": data.get("target_journal", ""),
        "corresponding_author": data.get("corresponding_author", ""),
        "authors": data.get("authors", []),
        "funding_sources": data.get("funding_sources", []),
        "external_collaborators": data.get("external_collaborators", []),
        "project_id": project_id,
        "tags": data.get("tags", ""),
        "notes": data.get("notes", ""),
        "collaboration_type": data.get("collaboration_type", "internal"),
        "word_count": 0, "figure_count": 0, "reference_count": 0,
        "created_by": username, "last_modified_by": username,
        "created_at": now, "updated_at": now,
        "target_deadline": data.get("target_deadline"),
        "submission_date": None,
    }
    manuscripts.append(new_m)
    _save_json_store(_manuscripts_path(), manuscripts)
    _append_activity(new_m["id"], title, "Created", username)
    return {"success": True, "manuscript_id": new_m["id"], "manuscript": new_m}

def get_manuscripts(username: str = "", status_filter: str = "", project_filter: str = "", limit: int = 50) -> List[Dict]:
    db = _db()
    if db:
        try:
            from sqlalchemy import or_, desc
            from database.models import Manuscript
            with db.get_session() as s:
                q = s.query(Manuscript)
                if username:
                    q = q.filter(or_(
                        Manuscript.created_by == username,
                        Manuscript.last_modified_by == username,
                    ))
                if status_filter and status_filter != "all":
                    q = q.filter(Manuscript.status == status_filter)
                if project_filter and project_filter != "all":
                    try:
                        import uuid as _uuid
                        q = q.filter(Manuscript.project_id == _uuid.UUID(project_filter))
                    except Exception:
                        pass
                q = q.order_by(desc(Manuscript.updated_at))
                return [m.to_dict() for m in q.limit(limit).all()]
        except Exception as exc:
            logger.warning("DB get_manuscripts: %s", exc)

    manuscripts = _load_json_store(_manuscripts_path())
    if username:
        manuscripts = [m for m in manuscripts if m.get("created_by") == username or m.get("last_modified_by") == username]
    if status_filter and status_filter != "all":
        manuscripts = [m for m in manuscripts if m.get("status") == status_filter]
    if project_filter and project_filter != "all":
        manuscripts = [m for m in manuscripts if m.get("project_id") == project_filter]
    manuscripts.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
    return manuscripts[:limit]


def get_manuscript(manuscript_id: str, username: str = "") -> Optional[Dict]:
    db = _db()
    if db:
        try:
            import uuid as _uuid
            from database.models import Manuscript
            with db.get_session() as s:
                m = s.query(Manuscript).filter(Manuscript.id == _uuid.UUID(manuscript_id)).first()
                if m:
                    return m.to_dict()
        except Exception as exc:
            logger.warning("DB get_manuscript: %s", exc)

    manuscripts = _load_json_store(_manuscripts_path())
    return next((m for m in manuscripts if m.get("id") == manuscript_id), None)


def update_manuscript_status(manuscript_id: str, new_status: str, username: str = "", notes: str = "") -> Dict:
    db = _db()
    if db:
        try:
            import uuid as _uuid
            from database.models import Manuscript, ManuscriptStatus
            with db.get_session() as s:
                m = s.query(Manuscript).filter(Manuscript.id == _uuid.UUID(manuscript_id)).first()
                if not m:
                    return {"success": False, "error": "Manuscript not found"}
                old = m.status
                m.status = new_status
                m.last_modified_by = username
                m.updated_at = datetime.now(timezone.utc)
                m.progress_percentage = float(_STATUS_PROGRESS.get(new_status, m.progress_percentage or 0))
                if new_status == "submitted" and not m.submission_date:
                    m.submission_date = datetime.now(timezone.utc)
                s.add(ManuscriptStatus(
                    manuscript_id=m.id, status=new_status, changed_by=username,
                    notes=notes or f"Status changed from {old} to {new_status}",
                ))
                d = m.to_dict()
            _append_activity(manuscript_id, d.get("title", ""), f"Status → {new_status}", username)
            return {"success": True, "manuscript": d}
        except Exception as exc:
            logger.warning("DB update_status: %s", exc)

    manuscripts = _load_json_store(_manuscripts_path())
    for m in manuscripts:
        if m.get("id") == manuscript_id:
            old = m.get("status", "draft")
            m["status"] = new_status
            m["progress_percentage"] = float(_STATUS_PROGRESS.get(new_status, m.get("progress_percentage", 0)))
            m["last_modified_by"] = username
            m["updated_at"] = datetime.now(timezone.utc).isoformat()
            if new_status == "submitted" and not m.get("submission_date"):
                m["submission_date"] = datetime.now(timezone.utc).isoformat()
            _save_json_store(_manuscripts_path(), manuscripts)
            _append_activity(manuscript_id, m.get("title", ""), f"Status → {new_status}", username)
            return {"success": True, "manuscript": m}
    return {"success": False, "error": "Manuscript not found"}

# ── Activity log ──────────────────────────────────────────────────────────────

def _append_activity(manuscript_id: str, title: str, action: str, username: str) -> None:
    try:
        activity = _load_json_store(_activity_path())
        activity.append({
            "manuscript_id": manuscript_id,
            "manuscript_title": title,
            "action": action,
            "user": username,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        _save_json_store(_activity_path(), activity[-200:])
    except Exception:
        pass


def get_recent_activity(username: str = "", limit: int = 10) -> List[Dict]:
    db = _db()
    if db:
        try:
            from sqlalchemy import desc
            from database.models import ManuscriptStatus, Manuscript
            with db.get_session() as s:
                q = s.query(ManuscriptStatus).join(Manuscript)
                if username:
                    q = q.filter(ManuscriptStatus.changed_by == username)
                rows = q.order_by(desc(ManuscriptStatus.changed_at)).limit(limit).all()
                return [{
                    "manuscript_id": str(r.manuscript_id),
                    "manuscript_title": r.manuscript.title,
                    "action": f"Status changed to {r.status}",
                    "user": r.changed_by,
                    "timestamp": r.changed_at.isoformat(),
                    "notes": r.notes,
                } for r in rows]
        except Exception as exc:
            logger.warning("DB get_recent_activity: %s", exc)

    activity = list(reversed(_load_json_store(_activity_path())))
    if username:
        activity = [a for a in activity if a.get("user") == username]
    return activity[:limit]


# ── Dashboard aggregation ──────────────────────────────────────────────────────

def get_dashboard_data(username: str = "") -> Dict:
    manuscripts = get_manuscripts(username, limit=50)
    projects = get_projects(username)
    activity = get_recent_activity(username, limit=10)

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    status_counts: Dict[str, int] = {}
    total_progress = 0.0
    overdue = 0
    this_month = 0
    deadlines = []

    for m in manuscripts:
        st = m.get("status", "draft")
        status_counts[st] = status_counts.get(st, 0) + 1
        total_progress += float(m.get("progress_percentage") or 0)
        created = m.get("created_at")
        try:
            if created and datetime.fromisoformat(created.replace("Z", "+00:00")) >= month_start:
                this_month += 1
        except Exception:
            pass
        deadline_str = m.get("target_deadline")
        if deadline_str and st not in ("published", "accepted"):
            try:
                dl = datetime.fromisoformat(deadline_str.replace("Z", "+00:00"))
                days = (dl - now).days
                deadlines.append({
                    "manuscript_id": m.get("id"), "manuscript_title": m.get("title", ""),
                    "deadline": deadline_str, "days_until": days,
                    "status": st, "priority": m.get("priority", "medium"),
                    "is_overdue": days < 0,
                })
                if days < 0:
                    overdue += 1
            except Exception:
                pass

    deadlines.sort(key=lambda x: x["days_until"])

    return {
        "success": True,
        "manuscripts": manuscripts,
        "projects": projects,
        "statistics": {
            "total_manuscripts": len(manuscripts),
            "by_status": status_counts,
            "average_progress": round(total_progress / len(manuscripts), 1) if manuscripts else 0.0,
            "overdue_count": overdue,
            "this_month_created": this_month,
        },
        "recent_activity": activity,
        "upcoming_deadlines": deadlines[:10],
    }


def get_templates() -> List[Dict]:
    db = _db()
    if db:
        try:
            from database.models import ManuscriptTemplate
            with db.get_session() as s:
                rows = s.query(ManuscriptTemplate).filter(
                    ManuscriptTemplate.is_active == True
                ).order_by(ManuscriptTemplate.name).all()
                return [t.to_dict() for t in rows]
        except Exception as exc:
            logger.warning("DB get_templates: %s", exc)
    return [
        {
            "id": "neuro-standard", "name": "Neurodegeneration Research Standard",
            "description": "Standard template for neurodegeneration research papers",
            "research_area": "neuroscience", "manuscript_type": "research_article",
            "usage_count": 0,
        },
        {
            "id": "review-article", "name": "Review Article",
            "description": "Comprehensive review template",
            "research_area": "neuroscience", "manuscript_type": "review",
            "usage_count": 0,
        },
    ]
