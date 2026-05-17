"""Two-way auto-sync: PrionPack references ↔ PrionVault collections.

For each active PrionPack the service ensures two PrionVault
collections exist under the same group/subgroup the sidebar already
uses, and keeps them populated with the articles whose DOI appears in
the pack's reference lists:

  Group:    PrionPacks
  Subgroup: <pack-id> — <pack-title>             (e.g. "PRP-001 — Octapeptide…")
  Names:    "Introducción"            ← driven by pack.introReferences
            "Referencias generales"   ← driven by pack.references

Triggers wired by callers:
  - sync_doi(doi)  : called from the worker after each article insert
                     and from the article-PATCH route when the DOI
                     field changes. Cheapest path — only re-walks the
                     packs that cite this DOI.
  - sync_pack(pkg) : called from the PrionPacks routes after every
                     save (create / update / import-article /
                     import-section). Re-resolves the pack's full
                     reference list against the catalogue.
  - sync_all()     : full backfill, triggered manually from
                     /api/admin/prionpacks/sync and from the
                     auto-scan daemon at the tail of each scan.

The sync is idempotent: collections.add_articles() skips entries that
are already members, so re-runs are cheap and never duplicate rows.
Errors anywhere bubble UP as logged warnings — they must never crash
the ingest worker or the PrionPacks save path.
"""
from __future__ import annotations

import logging
import re
from typing import Iterable, Optional

from sqlalchemy import text as sql_text

from ..ingestion.queue import _get_engine
from . import collections as _collections

logger = logging.getLogger(__name__)


PACK_GROUP_NAME    = "PrionPacks"
INTRO_COLL_NAME    = "Introducción"
GENERAL_COLL_NAME  = "Referencias generales"

# Matches DOIs embedded inside free-text reference strings. Same regex
# the listing's PrionPack badge uses (see routes._extract_dois) so the
# two paths can't disagree about what counts as a DOI.
_DOI_RE = re.compile(r"10\.\d{4,}/[^\s'\";,)>\]]+", re.IGNORECASE)


def _extract_dois(ref) -> list[str]:
    if not isinstance(ref, str):
        return []
    return [m.group(0).rstrip(".,;").lower() for m in _DOI_RE.finditer(ref)]


def _subgroup_label_for(pack: dict) -> str:
    """Stable subgroup label = the pack id only ("PRP-001"). The pack
    title is intentionally NOT part of the label — titles get edited
    over time and we don't want every rename to orphan the existing
    auto-collections under a new subgroup. The id is immutable.
    Earlier versions of this code used "<id> — <title>"; the migration
    path in ensure_collections_for_pack() catches those legacy
    subgroups and folds them into the new convention on the next sync.
    """
    return (pack.get("id") or "").strip()


def _find_legacy_subgroup(pid: str) -> Optional[str]:
    """Look for a collection whose subgroup_name starts with `<pid> — `
    under the PrionPacks group. Returns the matched subgroup_name so
    callers can decide whether to migrate it to the new convention."""
    if not pid:
        return None
    try:
        eng = _get_engine()
        with eng.connect() as conn:
            row = conn.execute(sql_text("""
                SELECT subgroup_name
                  FROM prionvault_collection
                 WHERE lower(group_name) = lower(:g)
                   AND subgroup_name LIKE :prefix
                 LIMIT 1
            """), {"g": PACK_GROUP_NAME, "prefix": f"{pid} %"}).first()
            return row[0] if row else None
    except Exception as exc:
        logger.debug("legacy-subgroup lookup failed for %s: %s", pid, exc)
        return None


def _rename_subgroup(old_subgroup: str, new_subgroup: str) -> int:
    """Rename every PrionPacks-group collection that lived under
    `old_subgroup` to `new_subgroup`. Used to migrate the old
    "<id> — <title>" naming to the stable "<id>" naming.
    Returns the row count. Catches unique-constraint clashes so
    one bad pair (collection already exists at the target) doesn't
    abort the whole sync — those rows stay as-is and the caller
    will just reuse the canonical one.
    """
    if not old_subgroup or old_subgroup == new_subgroup:
        return 0
    try:
        eng = _get_engine()
        with eng.begin() as conn:
            res = conn.execute(sql_text("""
                UPDATE prionvault_collection
                   SET subgroup_name = :new, updated_at = NOW()
                 WHERE lower(group_name) = lower(:g)
                   AND subgroup_name      = :old
                   AND NOT EXISTS (
                       SELECT 1 FROM prionvault_collection c2
                        WHERE lower(c2.group_name)    = lower(:g)
                          AND c2.subgroup_name        = :new
                          AND lower(c2.name)          = lower(prionvault_collection.name)
                   )
            """), {"g": PACK_GROUP_NAME, "old": old_subgroup, "new": new_subgroup})
            return res.rowcount or 0
    except Exception as exc:
        logger.warning("rename subgroup %r → %r failed: %s",
                       old_subgroup, new_subgroup, exc)
        return 0


def _resolve_dois_to_article_ids(dois: Iterable[str]) -> list[str]:
    """Bulk DOI → article-id lookup. Returns ids of articles whose DOI
    (lower-cased) appears in `dois`. Missing DOIs are silently dropped —
    the article hasn't entered PrionVault yet; sync_doi() will catch it
    when it does."""
    dois = sorted({d.strip().lower() for d in dois if d and isinstance(d, str)})
    if not dois:
        return []
    eng = _get_engine()
    with eng.connect() as conn:
        rows = conn.execute(sql_text(
            "SELECT id FROM articles WHERE lower(doi) = ANY(:dois)"
        ), {"dois": dois}).all()
    return [str(r[0]) for r in rows]


def _ensure_collection(*, name: str, group: str, subgroup: str,
                       description: str) -> Optional[str]:
    """Return the collection id, creating it if missing. Manual kind,
    so add_articles() works on it."""
    # find_in_group is case-insensitive; collections.list_all is the
    # only way to filter by name on top, so do that in Python.
    candidates = _collections.find_in_group(group, subgroup)
    if candidates:
        # Pick the one whose name matches (case-insensitive). The
        # collection_name_scoped_uniq migration (016) guarantees at
        # most one match per (group, subgroup, name).
        for cid in candidates:
            c = _collections.get(cid)
            if c and (c.get("name") or "").strip().lower() == name.strip().lower():
                return cid

    try:
        created = _collections.create(
            name=name, kind="manual",
            description=description,
            group_name=group, subgroup_name=subgroup,
            color=None, rules=None,
            created_by=None,
        )
        logger.info("prionpack_sync: created collection %s/%s/%s -> %s",
                    group, subgroup, name, created.get("id"))
        return created.get("id")
    except Exception as exc:
        # Most likely the unique constraint fires because of a race.
        # Try the lookup one more time.
        logger.info("prionpack_sync: create raced (%s) — re-reading", exc)
        candidates = _collections.find_in_group(group, subgroup)
        for cid in candidates:
            c = _collections.get(cid)
            if c and (c.get("name") or "").strip().lower() == name.strip().lower():
                return cid
        logger.warning("prionpack_sync: could not ensure collection %s/%s/%s",
                       group, subgroup, name)
        return None


def ensure_collections_for_pack(pack: dict) -> dict:
    """Make sure the two auto-managed collections exist for this pack.

    Subgroup convention is just the pack id ("PRP-001"). On the first
    sync after the convention change, any legacy collections under
    "<pid> — <old title>" are folded into the new naming so the user
    doesn't end up with duplicates.

    Returns {'intro': cid_or_None, 'general': cid_or_None}.
    """
    pid = (pack.get("id") or "").strip()
    if not pid:
        return {"intro": None, "general": None}
    subgroup = _subgroup_label_for(pack)   # == pid

    # One-time migration: collections under "<pid> — …" get their
    # subgroup_name flipped to just "<pid>" so they're reused by the
    # ensure step below. The query is cheap (indexed on subgroup_name
    # via the migrations) and idempotent — no rows match after the
    # first sync.
    legacy = _find_legacy_subgroup(pid)
    if legacy and legacy != subgroup:
        moved = _rename_subgroup(legacy, subgroup)
        if moved:
            logger.info("prionpack_sync: migrated %d collection(s) from "
                        "subgroup %r to %r", moved, legacy, subgroup)

    intro_cid = _ensure_collection(
        name=INTRO_COLL_NAME, group=PACK_GROUP_NAME, subgroup=subgroup,
        description=f"Auto-sincronizada con las introReferences de {pid}.",
    )
    general_cid = _ensure_collection(
        name=GENERAL_COLL_NAME, group=PACK_GROUP_NAME, subgroup=subgroup,
        description=f"Auto-sincronizada con las references de {pid}.",
    )
    return {"intro": intro_cid, "general": general_cid}


def sync_pack(pack: dict) -> dict:
    """Reconcile one pack's references with its two auto-collections.

    Best-effort. Returns a summary {pack_id, intro: {added, skipped,
    matched, total_dois}, general: {…}}.
    """
    if not pack or not pack.get("id"):
        return {"error": "no_pack_id"}
    if not pack.get("active", True):
        return {"pack_id": pack["id"], "skipped": "inactive"}

    cids = ensure_collections_for_pack(pack)

    def _branch(refs, cid, kind):
        dois = sorted({d for ref in (refs or []) for d in _extract_dois(ref)})
        if cid is None or not dois:
            return {"total_dois": len(dois), "matched": 0,
                    "added": 0, "skipped": 0}
        aids = _resolve_dois_to_article_ids(dois)
        if not aids:
            return {"total_dois": len(dois), "matched": 0,
                    "added": 0, "skipped": 0}
        try:
            r = _collections.add_articles(cid, aids, added_by=None)
            return {"total_dois": len(dois), "matched": len(aids),
                    "added": int(r.get("added") or 0),
                    "skipped": int(r.get("skipped") or 0)}
        except Exception as exc:
            logger.warning("prionpack_sync: add_articles failed for %s/%s: %s",
                           pack["id"], kind, exc)
            return {"total_dois": len(dois), "matched": len(aids),
                    "added": 0, "skipped": 0, "error": str(exc)[:200]}

    return {
        "pack_id": pack["id"],
        "intro":   _branch(pack.get("introReferences"), cids["intro"],   "intro"),
        "general": _branch(pack.get("references"),      cids["general"], "general"),
    }


def sync_doi(doi: Optional[str]) -> dict:
    """One DOI just entered (or got re-stamped on) PrionVault. Find
    every active pack that cites it and add the article to the matching
    collection(s). Cheap and bounded — packs are loaded from a small
    JSON file."""
    if not doi or not isinstance(doi, str):
        return {"skipped": "no_doi"}
    doi_l = doi.strip().lower()
    if not doi_l:
        return {"skipped": "empty_doi"}

    aids = _resolve_dois_to_article_ids([doi_l])
    if not aids:
        return {"doi": doi_l, "skipped": "article_not_in_prionvault"}

    try:
        from tools.prionpacks import models as pp_models
    except Exception as exc:
        logger.warning("prionpack_sync: prionpacks module unavailable: %s", exc)
        return {"doi": doi_l, "skipped": "prionpacks_unavailable"}

    touched: list[dict] = []
    for pack in pp_models.list_packages():
        if not pack.get("active", True):
            continue
        intro_dois   = {d for ref in (pack.get("introReferences") or []) for d in _extract_dois(ref)}
        general_dois = {d for ref in (pack.get("references")      or []) for d in _extract_dois(ref)}
        in_intro   = doi_l in intro_dois
        in_general = doi_l in general_dois
        if not (in_intro or in_general):
            continue
        cids = ensure_collections_for_pack(pack)
        entry = {"pack_id": pack["id"]}
        if in_intro and cids["intro"]:
            try:
                r = _collections.add_articles(cids["intro"], aids, added_by=None)
                entry["intro"] = {"added": int(r.get("added") or 0),
                                  "skipped": int(r.get("skipped") or 0)}
            except Exception as exc:
                entry["intro"] = {"error": str(exc)[:200]}
        if in_general and cids["general"]:
            try:
                r = _collections.add_articles(cids["general"], aids, added_by=None)
                entry["general"] = {"added": int(r.get("added") or 0),
                                    "skipped": int(r.get("skipped") or 0)}
            except Exception as exc:
                entry["general"] = {"error": str(exc)[:200]}
        touched.append(entry)
    return {"doi": doi_l, "article_ids": aids, "touched_packs": touched}


def sync_all() -> dict:
    """Full backfill: sync every active pack. Used by the admin button
    and at the tail of each auto-scan-folder run."""
    try:
        from tools.prionpacks import models as pp_models
    except Exception as exc:
        logger.warning("prionpack_sync: prionpacks module unavailable: %s", exc)
        return {"error": "prionpacks_unavailable", "detail": str(exc)[:200]}

    results = []
    totals  = {"packs": 0, "intro_added": 0, "general_added": 0,
               "intro_skipped": 0, "general_skipped": 0, "matched": 0}
    for pack in pp_models.list_packages():
        r = sync_pack(pack)
        results.append(r)
        if r.get("skipped"):
            continue
        totals["packs"] += 1
        for branch in ("intro", "general"):
            b = r.get(branch) or {}
            totals[f"{branch}_added"]   += int(b.get("added") or 0)
            totals[f"{branch}_skipped"] += int(b.get("skipped") or 0)
            totals["matched"]           += int(b.get("matched") or 0)
    return {"ok": True, "totals": totals, "per_pack": results}
