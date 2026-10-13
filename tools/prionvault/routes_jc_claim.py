"""Journal Club reservation ("claim") of an article — see migration 096.

States of an article's JC button:
  free       — is_jc (blue book), nobody has reserved it, no presentation
  reserved   — someone picked it to present: red + locked; is_jc cleared
  announced  — the session was announced (convocation): still red, but the
               presenter can now upload their presentation
  presented  — it has a presentation: green (as before)

Only the JC responsible or an admin can release a reservation (back to the
pool) or unlock it early. Imported at the bottom of routes.py.
"""
import logging

from flask import jsonify, session
from sqlalchemy import text as sql_text

from core.decorators import login_required
from . import prionvault_bp
from ._helpers import _session, _viewer_id, _viewer_is_jc_responsible

logger = logging.getLogger(__name__)


def _viewer_name() -> str:
    return (session.get("full_name") or session.get("username") or "").strip()


def _is_manager() -> bool:
    return session.get("role") == "admin" or _viewer_is_jc_responsible()


def _responsible_names() -> list[str]:
    try:
        from core.users import list_jc_responsible
        return [(u.get("full_name") or u.get("username") or "").strip()
                for u in list_jc_responsible()]
    except Exception:
        return []


def _load(s, aid):
    return s.execute(sql_text("""
        SELECT a.id::text AS id, a.title, a.authors, a.year, a.journal, a.doi,
               a.pubmed_id, a.abstract, (a.dropbox_path IS NOT NULL) AS has_pdf,
               COALESCE(a.is_jc, FALSE) AS is_jc,
               a.jc_claimed_by, a.jc_claimed_by_name, a.jc_claimed_at, a.jc_announced_at,
               (SELECT COUNT(*) FROM prionvault_jc_presentation p
                 WHERE p.article_id = a.id) AS jc_count
          FROM articles a WHERE a.id = CAST(:aid AS uuid)
    """), {"aid": str(aid)}).mappings().first()


def _state_dict(r) -> dict:
    uid = _viewer_id()
    iso = lambda v: v.isoformat() if v else None
    return {
        "id": r["id"], "title": r["title"], "authors": r["authors"],
        "year": r["year"], "journal": r["journal"], "doi": r["doi"],
        "pubmed_id": r["pubmed_id"], "abstract": r["abstract"],
        "has_pdf": bool(r["has_pdf"]), "is_jc": bool(r["is_jc"]),
        "jc_count": int(r["jc_count"] or 0), "has_jc": bool(r["jc_count"]),
        "jc_claimed_by": r["jc_claimed_by"],
        "jc_claimed_by_name": r["jc_claimed_by_name"],
        "jc_claimed_at": iso(r["jc_claimed_at"]),
        "jc_announced_at": iso(r["jc_announced_at"]),
        "viewer": {
            "name": _viewer_name(),
            "is_manager": _is_manager(),
            "is_claimant": bool(uid and r["jc_claimed_by"] == str(uid)),
        },
        "responsibles": _responsible_names(),
    }


@prionvault_bp.route("/api/articles/<uuid:aid>/jc-state", methods=["GET"])
@login_required
def api_jc_state(aid):
    s = _session()
    try:
        r = _load(s, aid)
        if not r:
            return jsonify({"error": "not_found"}), 404
        return jsonify(_state_dict(r))
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/jc-claim", methods=["POST"])
@login_required
def api_jc_claim(aid):
    """Reserve a free JC-candidate article to present it. Atomic: two
    people clicking at once can't both get it."""
    uid = _viewer_id()
    if not uid:
        return jsonify({"error": "not_authenticated"}), 401
    name = _viewer_name()
    s = _session()
    try:
        got = s.execute(sql_text("""
            UPDATE articles
               SET jc_claimed_by = :uid, jc_claimed_by_name = :name,
                   jc_claimed_at = NOW(), jc_announced_at = NULL,
                   is_jc = FALSE, updated_at = NOW()
             WHERE id = CAST(:aid AS uuid)
               AND jc_claimed_by IS NULL
               AND is_jc IS TRUE
               AND NOT EXISTS (SELECT 1 FROM prionvault_jc_presentation p
                                WHERE p.article_id = articles.id)
            RETURNING id
        """), {"uid": str(uid), "name": name, "aid": str(aid)}).first()
        if not got:
            s.rollback()
            r = _load(s, aid)
            if not r:
                return jsonify({"error": "not_found"}), 404
            if r["jc_claimed_by"]:
                return jsonify({"error": "already_claimed",
                                "detail": f"Ya lo ha reservado {r['jc_claimed_by_name'] or 'otra persona'}."}), 409
            return jsonify({"error": "not_available",
                            "detail": "Este artículo ya no está disponible para Journal Club."}), 409
        s.commit()
    except Exception as exc:
        s.rollback()
        logger.exception("jc-claim failed for %s", aid)
        return jsonify({"error": "internal", "detail": str(exc)[:300]}), 500
    finally:
        s.close()

    email_sent, email_error = False, None
    try:
        from .services import article_share
        res = article_share.send_jc_claim_email(str(aid), presenter_name=name)
        email_sent = bool(res.get("ok"))
    except LookupError as exc:
        email_error = ("No hay ningún usuario marcado como responsable de Journal Club."
                       if str(exc) == "no_jc_responsible" else str(exc))
    except Exception as exc:
        logger.exception("jc-claim: notify responsible failed for %s", aid)
        email_error = str(exc)[:200]
    return jsonify({"ok": True, "responsibles": _responsible_names(),
                    "email_sent": email_sent, "email_error": email_error})


@prionvault_bp.route("/api/articles/<uuid:aid>/jc-release", methods=["POST"])
@login_required
def api_jc_release(aid):
    """Cancel a reservation: the article goes back to the JC pool."""
    if not _is_manager():
        return jsonify({"error": "forbidden",
                        "detail": "Solo el responsable de Journal Club o un administrador puede liberarlo."}), 403
    s = _session()
    try:
        s.execute(sql_text("""
            UPDATE articles
               SET jc_claimed_by = NULL, jc_claimed_by_name = NULL,
                   jc_claimed_at = NULL, jc_announced_at = NULL,
                   is_jc = TRUE, updated_at = NOW()
             WHERE id = CAST(:aid AS uuid)
        """), {"aid": str(aid)})
        s.commit()
        return jsonify({"ok": True})
    except Exception as exc:
        s.rollback()
        logger.exception("jc-release failed for %s", aid)
        return jsonify({"error": "internal", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


@prionvault_bp.route("/api/articles/<uuid:aid>/jc-unlock", methods=["POST"])
@login_required
def api_jc_unlock(aid):
    """Let the presenter upload their presentation without waiting for the
    convocation email (which normally does this)."""
    if not _is_manager():
        return jsonify({"error": "forbidden",
                        "detail": "Solo el responsable de Journal Club o un administrador puede desbloquearlo."}), 403
    s = _session()
    try:
        s.execute(sql_text("""
            UPDATE articles SET jc_announced_at = COALESCE(jc_announced_at, NOW()),
                                updated_at = NOW()
             WHERE id = CAST(:aid AS uuid) AND jc_claimed_by IS NOT NULL
        """), {"aid": str(aid)})
        s.commit()
        return jsonify({"ok": True})
    except Exception as exc:
        s.rollback()
        logger.exception("jc-unlock failed for %s", aid)
        return jsonify({"error": "internal", "detail": str(exc)[:300]}), 500
    finally:
        s.close()


def check_can_upload_presentation(aid):
    """Gate for creating a JC presentation on a reserved article. Returns
    a (response, status) tuple to abort with, or None to proceed."""
    if _is_manager():
        return None
    s = _session()
    try:
        r = s.execute(sql_text(
            "SELECT jc_claimed_by, jc_claimed_by_name, jc_announced_at "
            "FROM articles WHERE id = CAST(:aid AS uuid)"), {"aid": str(aid)}).first()
    except Exception:
        return None   # columns not migrated yet — keep the old behaviour
    finally:
        s.close()
    if not r or not r[0]:
        return None
    uid = _viewer_id()
    if r[0] != str(uid):
        return jsonify({"error": "reserved",
                        "detail": f"Este artículo está reservado para que lo presente {r[1] or 'otra persona'}."}), 403
    if not r[2]:
        return jsonify({"error": "locked",
                        "detail": "Podrás subir la presentación cuando el responsable de Journal Club anuncie la sesión."}), 403
    return None
