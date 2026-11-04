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
                   updated_at = NOW()
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
    except Exception as exc:
        if "does not exist" in str(exc):   # columns not migrated yet — old behaviour
            return None
        # Any other DB error: fail CLOSED (a reserved article must not
        # accept someone else's upload because the check couldn't run).
        logger.warning("check_can_upload_presentation failed for %s: %s", aid, exc)
        return jsonify({"error": "check_failed",
                        "detail": "No se pudo comprobar la reserva del artículo. Inténtalo de nuevo."}), 503
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


# ── "📖 Aceptar para Journal Club" button in the JC request email ──────────
# The link carries a signed token naming the recipient (admin or JC
# responsible) — no login needed. GET only shows a confirmation page;
# accepting is a POST, so a mail scanner that pre-opens links can't accept
# on its own.

def _accept_page(title: str, body_html: str, color: str = "#7c3aed") -> str:
    import html as _h
    return f"""<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Journal Club · PrionVault</title></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:560px;margin:48px auto;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden;">
  <div style="background:#0F3460;padding:18px 24px;color:#fff;font-weight:800;font-size:18px;">🔬 PrionVault · Journal Club</div>
  <div style="padding:22px 24px;">
    <h2 style="margin:0 0 12px;font-size:17px;color:{color};">{_h.escape(title)}</h2>
    {body_html}
  </div>
</div></body></html>"""


def _resolve_accept(token):
    """Returns (article_row, user_dict, error_message)."""
    from itsdangerous import BadSignature, SignatureExpired
    from .services.article_share import read_jc_accept_token
    try:
        data = read_jc_accept_token(token)
    except SignatureExpired:
        return None, None, "Este enlace ha caducado. Márcalo desde PrionVault con el libro azul 📖."
    except BadSignature:
        return None, None, "El enlace no es válido."
    from core.users import get_user
    user = get_user(data.get("u") or "")
    if not user or (user.get("active") or "true").lower() != "true":
        return None, None, "El usuario de este enlace no existe o está desactivado."
    allowed = ((user.get("role") or "").lower() == "admin"
               or (user.get("is_jc_responsible") or "").lower() == "true")
    if not allowed:
        return None, None, ("Solo un administrador o el responsable de Journal Club puede "
                            "aceptar artículos para Journal Club.")
    s = _session()
    try:
        r = _load(s, data.get("a"))
    finally:
        s.close()
    if not r:
        return None, None, "El artículo ya no existe en PrionVault."
    return r, user, None


@prionvault_bp.route("/jc-accept/<token>", methods=["GET", "POST"])
def jc_accept(token):
    import html as _h
    from flask import request
    r, user, err = _resolve_accept(token)
    if err:
        return _accept_page("No se ha podido aceptar", f'<p style="color:#374151;">{_h.escape(err)}</p>',
                            "#b91c1c"), 400

    title = _h.escape(r["title"] or "(sin título)")
    meta = _h.escape(" · ".join(str(x) for x in (r["journal"], r["year"]) if x))
    from .services.article_share import _base_url
    link = f'{_base_url()}/prionvault/?open={r["id"]}'
    card = (f'<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;background:#f9fafb;margin:0 0 16px;">'
            f'<div style="font-weight:700;color:#111827;">{title}</div>'
            f'<div style="font-size:12.5px;color:#6b7280;margin-top:3px;">{meta}</div></div>')
    open_btn = (f'<a href="{_h.escape(link)}" style="display:inline-block;background:#0F3460;color:#fff;'
                f'padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13.5px;">'
                f'Ver en PrionVault →</a>')

    state_msg = None
    if r["jc_count"]:
        state_msg = "Este artículo ya se ha presentado en Journal Club."
    elif r["jc_claimed_by"]:
        state_msg = f'Este artículo ya está reservado para que lo presente {r["jc_claimed_by_name"] or "alguien"}.'
    elif r["is_jc"]:
        state_msg = "Este artículo ya estaba aceptado para Journal Club (libro azul 📖)."

    if request.method == "GET":
        if state_msg:
            return _accept_page("Nada que hacer", card + f'<p style="color:#374151;">{_h.escape(state_msg)}</p>' + open_btn)
        form = (f'<form method="post" style="display:inline;">'
                f'<button type="submit" style="background:#7c3aed;color:#fff;border:none;padding:10px 20px;'
                f'border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;">📖 Sí, aceptar para Journal Club</button>'
                f'</form>')
        return _accept_page("¿Aceptar este artículo para Journal Club?", card +
                            f'<p style="color:#374151;font-size:14px;line-height:1.55;">'
                            f'Quedará marcado con el libro azul 📖 como disponible para que alguien lo presente.</p>'
                            + form)

    if state_msg:
        return _accept_page("Nada que hacer", card + f'<p style="color:#374151;">{_h.escape(state_msg)}</p>' + open_btn)
    s = _session()
    try:
        s.execute(sql_text("UPDATE articles SET is_jc = TRUE, updated_at = NOW() "
                           "WHERE id = CAST(:aid AS uuid)"), {"aid": r["id"]})
        s.commit()
    except Exception as exc:
        s.rollback()
        logger.exception("jc-accept failed for %s", r["id"])
        return _accept_page("No se ha podido aceptar", f'<p>Error: {_h.escape(str(exc)[:200])}</p>', "#b91c1c"), 500
    finally:
        s.close()
    logger.info("jc-accept: %s accepted article %s for Journal Club", user.get("username"), r["id"])
    return _accept_page("✓ Aceptado para Journal Club", card +
                        f'<p style="color:#374151;font-size:14px;line-height:1.55;">'
                        f'Gracias, {_h.escape(user.get("full_name") or user.get("username") or "")}. '
                        f'El artículo ya aparece con el libro azul 📖 como disponible para Journal Club.</p>' + open_btn,
                        "#15803d")
