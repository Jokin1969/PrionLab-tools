"""PrionVault Collections — CRUD + membership management.

Manual collections store membership in `prionvault_collection_article`.
Smart collections (kind='smart') carry a `rules` JSON object and are
evaluated live by the list endpoint (see routes._apply_collection_rules).

All functions return plain dicts or ints. They never raise on missing
optional fields; SQL / validation errors propagate so the route layer
can map them to HTTP status codes.
"""
from __future__ import annotations

import logging
import uuid
from typing import List, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine

logger = logging.getLogger(__name__)


_VALID_KINDS = {"manual", "smart"}
# Subset of the article-list query params that smart collections may
# carry as their `rules` payload. Anything outside this set is dropped.
_SMART_RULE_KEYS = {
    "q", "authors", "journal", "year_min", "year_max",
    "tag", "has_summary", "priority_eq",
    "color_label", "is_flagged", "is_milestone",
    "extraction_status",
    "in_prionread", "is_favorite", "is_read",
}


def list_all(viewer_id=None) -> List[dict]:
    """Return all collections with their article count."""
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT c.id, c.name, c.description, c.kind, c.rules,
                      c.color, c.created_at, c.updated_at, c.created_by,
                      (SELECT COUNT(*) FROM prionvault_collection_article
                       WHERE collection_id = c.id) AS article_count
               FROM prionvault_collection c
               ORDER BY lower(c.name) ASC"""
        )).mappings().all()
    return [_shape(r) for r in rows]


def get(cid) -> Optional[dict]:
    eng = _get_engine()
    with eng.connect() as conn:
        row = conn.execute(sql_text(
            """SELECT c.id, c.name, c.description, c.kind, c.rules,
                      c.color, c.created_at, c.updated_at, c.created_by,
                      (SELECT COUNT(*) FROM prionvault_collection_article
                       WHERE collection_id = c.id) AS article_count
               FROM prionvault_collection c
               WHERE c.id = :id"""
        ), {"id": str(cid)}).mappings().first()
    return _shape(row) if row else None


def create(*, name: str, description: Optional[str] = None,
           kind: str = "manual", rules: Optional[dict] = None,
           color: Optional[str] = None,
           created_by=None) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("name required")
    if kind not in _VALID_KINDS:
        raise ValueError(f"invalid kind: {kind!r}")
    if kind == "smart":
        rules = _filter_rules(rules or {})
    else:
        rules = {}

    cid = str(uuid.uuid4())
    eng = _get_engine()
    with eng.begin() as conn:
        conn.execute(sql_text(
            """INSERT INTO prionvault_collection
               (id, name, description, kind, rules, color, created_by,
                created_at, updated_at)
               VALUES (:id, :name, :description, :kind,
                       :rules::jsonb, :color, :created_by, NOW(), NOW())"""
        ), {
            "id":          cid,
            "name":        name,
            "description": description,
            "kind":        kind,
            "rules":       _json_dumps(rules),
            "color":       color,
            "created_by":  str(created_by) if created_by else None,
        })
    out = get(cid)
    if not out:
        raise RuntimeError("collection vanished after INSERT")
    return out


def update(cid, *, name=None, description=None,
           rules=None, color=None) -> Optional[dict]:
    """Patch a collection. None means "leave unchanged"."""
    sets = []
    params: dict = {"id": str(cid)}
    if name is not None:
        sets.append("name = :name")
        params["name"] = name.strip()
        if not params["name"]:
            raise ValueError("name cannot be empty")
    if description is not None:
        sets.append("description = :description")
        params["description"] = description
    if rules is not None:
        sets.append("rules = :rules::jsonb")
        params["rules"] = _json_dumps(_filter_rules(rules))
    if color is not None:
        sets.append("color = :color")
        params["color"] = color or None
    if not sets:
        return get(cid)
    sets.append("updated_at = NOW()")

    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text(
            f"UPDATE prionvault_collection SET {', '.join(sets)} WHERE id = :id"
        ), params)
        if (res.rowcount or 0) == 0:
            return None
    return get(cid)


def delete(cid) -> bool:
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text(
            "DELETE FROM prionvault_collection WHERE id = :id"
        ), {"id": str(cid)})
        return (res.rowcount or 0) > 0


def add_articles(cid, article_ids: List, added_by=None) -> dict:
    """Add `article_ids` to a MANUAL collection. Returns counts.
    Smart collections cannot be modified this way and raise ValueError."""
    c = get(cid)
    if not c:
        raise LookupError("collection not found")
    if c["kind"] != "manual":
        raise ValueError("only manual collections accept add_articles")
    ids = [str(x) for x in (article_ids or []) if x]
    if not ids:
        return {"added": 0, "skipped": 0}
    eng = _get_engine()
    with eng.begin() as conn:
        # Existing rows would normally raise on PK conflict; the
        # ON CONFLICT clause makes the call idempotent and returns
        # the actual number of fresh insertions.
        res = conn.execute(sql_text(
            """INSERT INTO prionvault_collection_article
               (collection_id, article_id, added_at, added_by)
               SELECT :cid, x.id, NOW(), :added_by
               FROM (SELECT unnest(CAST(:ids AS uuid[])) AS id) x
               WHERE EXISTS (SELECT 1 FROM articles a WHERE a.id = x.id)
               ON CONFLICT DO NOTHING"""
        ), {
            "cid":      str(cid),
            "ids":      ids,
            "added_by": str(added_by) if added_by else None,
        })
        added = res.rowcount or 0
    return {"added": added, "skipped": len(ids) - added}


def remove_articles(cid, article_ids: List) -> int:
    ids = [str(x) for x in (article_ids or []) if x]
    if not ids:
        return 0
    eng = _get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text(
            """DELETE FROM prionvault_collection_article
               WHERE collection_id = :cid
                 AND article_id = ANY(CAST(:ids AS uuid[]))"""
        ), {"cid": str(cid), "ids": ids})
    return res.rowcount or 0


def article_ids_in(cid) -> List[str]:
    """Return every article_id in a MANUAL collection."""
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            """SELECT article_id FROM prionvault_collection_article
               WHERE collection_id = :cid"""
        ), {"cid": str(cid)}).all()
    return [str(r[0]) for r in rows]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _shape(row) -> Optional[dict]:
    if row is None:
        return None
    return {
        "id":            str(row["id"]),
        "name":          row["name"],
        "description":   row["description"] or "",
        "kind":          row["kind"],
        "rules":         dict(row["rules"]) if isinstance(row["rules"], dict)
                         else (row["rules"] or {}),
        "color":         row["color"],
        "article_count": int(row["article_count"] or 0),
        "created_at":    row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at":    row["updated_at"].isoformat() if row["updated_at"] else None,
        "created_by":    str(row["created_by"]) if row["created_by"] else None,
    }


def _filter_rules(rules: dict) -> dict:
    """Drop anything not in the allow-list so a malicious / careless
    caller cannot smuggle SQL through the smart-rules payload."""
    if not isinstance(rules, dict):
        return {}
    return {k: v for k, v in rules.items() if k in _SMART_RULE_KEYS}


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)
