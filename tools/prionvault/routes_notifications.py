"""Notification-subscription routes for PrionVault.

Extracted from routes.py to keep that file manageable.
Imported at the bottom of routes.py so these routes are
registered on prionvault_bp as a side effect of that import.
"""
import logging

from flask import jsonify, request, session

from core.decorators import login_required
from . import prionvault_bp

logger = logging.getLogger(__name__)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _notif_sub_to_dict(row) -> dict:
    sub = dict(row)
    for k in ("id", "user_id"):
        if sub.get(k):
            sub[k] = str(sub[k])
    for k in ("last_sent_at", "next_send_at", "created_at", "updated_at"):
        if sub.get(k):
            sub[k] = sub[k].isoformat()
    if sub.get("topics") and not isinstance(sub["topics"], list):
        sub["topics"] = list(sub["topics"])
    return sub


def _validate_notif_payload(data: dict, uemail: str) -> dict:
    import json as _json
    topics = [t for t in (data.get("topics") or []) if isinstance(t, str)]
    if not topics:
        topics = ["prion"]
    freq = data.get("frequency", "weekly")
    if freq not in ("weekly", "biweekly", "monthly"):
        freq = "weekly"
    raw_days = data.get("days_of_week")
    if raw_days and isinstance(raw_days, list):
        days = sorted({max(0, min(6, int(d))) for d in raw_days if str(d).isdigit() or isinstance(d, int)})
    else:
        try:
            days = [max(0, min(6, int(data.get("day_of_week", 4))))]
        except (TypeError, ValueError):
            days = [4]
    if not days:
        days = [4]
    dow = days[0]
    try:
        hour = max(0, min(23, int(data.get("send_hour", 15))))
    except (TypeError, ValueError):
        hour = 15
    try:
        minute = max(0, min(59, int(data.get("send_minute", 0))))
    except (TypeError, ValueError):
        minute = 0
    try:
        lookback = int(data.get("lookback_days", 7))
        if lookback not in (7, 14, 30):
            lookback = 7
    except (TypeError, ValueError):
        lookback = 7
    try:
        ape = max(1, min(50, int(data.get("articles_per_email", 5))))
    except (TypeError, ValueError):
        ape = 5
    source = data.get("source", "pubmed")
    if source not in ("pubmed", "flagged"):
        source = "pubmed"
    return {
        "name":         (data.get("name", "").strip() or "Mi suscripción")[:80],
        "source":       source,
        "email":        (data.get("email") or "").strip() or uemail,
        "topics":       _json.dumps(topics),
        "freq":         freq,
        "dow":          dow,
        "days":         days,
        "hour":         hour,
        "minute":       minute,
        "tz":           (data.get("user_timezone") or "UTC").strip(),
        "lookback":     lookback,
        "oa_only":      bool(data.get("include_oa_only", False)),
        "enabled":      bool(data.get("enabled", True)),
        "ape":          ape,
        "include_pdfs": bool(data.get("include_pdfs", True)),
    }


# ── Single-subscription backwards-compat endpoints ───────────────────────────

@prionvault_bp.route("/api/notifications/subscription", methods=["GET"])
@login_required
def api_notifications_get():
    from sqlalchemy import text as _t
    from database.config import db as _db
    from core.users import get_user as _get_user
    _uid = session.get("user_id")
    _uemail = (_get_user(session.get("username", "")) or {}).get("email", "")
    try:
        with _db.engine.connect() as conn:
            row = conn.execute(_t(
                "SELECT * FROM prionvault_notification_subscriptions "
                "WHERE user_id = :uid ORDER BY created_at LIMIT 1"
            ), {"uid": str(_uid)}).mappings().first()
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500
    if row:
        return jsonify(_notif_sub_to_dict(row))
    return jsonify({
        "enabled": False, "email": _uemail, "topics": ["prion"],
        "frequency": "weekly", "day_of_week": 4, "send_hour": 15,
        "send_minute": 0, "user_timezone": "UTC", "lookback_days": 7,
        "include_oa_only": False, "last_sent_at": None, "next_send_at": None,
        "source": "pubmed", "name": "Mi suscripción", "articles_per_email": 5,
    })


@prionvault_bp.route("/api/notifications/subscription", methods=["POST"])
@login_required
def api_notifications_save():
    from sqlalchemy import text as _t
    from database.config import db as _db
    from core.users import get_user as _get_user
    from .services.email_digest import compute_next_send
    _uid = session.get("user_id")
    _uemail = (_get_user(session.get("username", "")) or {}).get("email", "")
    data = request.get_json(silent=True) or {}
    p = _validate_notif_payload(data, _uemail)
    next_send = compute_next_send({"frequency": p["freq"], "days_of_week": p["days"],
                                   "send_hour": p["hour"], "send_minute": p["minute"],
                                   "user_timezone": p["tz"]})
    try:
        with _db.engine.connect() as conn:
            existing_id = conn.execute(_t(
                "SELECT id FROM prionvault_notification_subscriptions "
                "WHERE user_id = :uid ORDER BY created_at LIMIT 1"
            ), {"uid": str(_uid)}).scalar()
        with _db.engine.begin() as conn:
            if existing_id:
                conn.execute(_t("""
                    UPDATE prionvault_notification_subscriptions SET
                        name=:name, source=:source, enabled=:enabled, email=:email,
                        topics=CAST(:topics AS jsonb), frequency=:freq, day_of_week=:dow,
                        days_of_week=:days, send_hour=:hour, send_minute=:minute,
                        user_timezone=:tz, lookback_days=:lookback, include_oa_only=:oa_only,
                        articles_per_email=:ape, include_pdfs=:include_pdfs,
                        next_send_at=:next_send, updated_at=NOW()
                    WHERE id=:id
                """), {**p, "next_send": next_send, "id": existing_id})
            else:
                conn.execute(_t("""
                    INSERT INTO prionvault_notification_subscriptions
                        (user_id, name, source, enabled, email, topics, frequency,
                         day_of_week, days_of_week, send_hour, send_minute, user_timezone,
                         lookback_days, include_oa_only, articles_per_email, include_pdfs,
                         next_send_at, updated_at)
                    VALUES (:uid, :name, :source, :enabled, :email,
                            CAST(:topics AS jsonb), :freq, :dow, :days, :hour, :minute,
                            :tz, :lookback, :oa_only, :ape, :include_pdfs, :next_send, NOW())
                """), {**p, "uid": str(_uid), "next_send": next_send})
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500
    return jsonify({"ok": True, "next_send_at": next_send.isoformat()})


@prionvault_bp.route("/api/notifications/test", methods=["POST"])
@login_required
def api_notifications_test():
    from sqlalchemy import text as _t
    from database.config import db as _db
    from core.users import get_user as _get_user
    from config import smtp_configured
    from .services.email_digest import compute_next_send
    import json as _json

    _uid = session.get("user_id")
    if not smtp_configured():
        return jsonify({"error": "smtp_not_configured",
                        "detail": "SMTP no configurado en el servidor."}), 503
    try:
        with _db.engine.connect() as conn:
            sub_id = conn.execute(_t(
                "SELECT id::text FROM prionvault_notification_subscriptions "
                "WHERE user_id = :uid ORDER BY created_at LIMIT 1"
            ), {"uid": str(_uid)}).scalar()
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500

    if not sub_id:
        data = request.get_json(silent=True) or {}
        _uemail = (_get_user(session.get("username", "")) or {}).get("email", "")
        p = _validate_notif_payload(data, _uemail)
        next_send = compute_next_send({"frequency": p["freq"], "day_of_week": p["dow"],
                                       "send_hour": p["hour"], "send_minute": p["minute"],
                                       "user_timezone": p["tz"]})
        try:
            with _db.engine.begin() as conn:
                sub_id = conn.execute(_t("""
                    INSERT INTO prionvault_notification_subscriptions
                        (user_id, name, source, enabled, email, topics, frequency,
                         day_of_week, days_of_week, send_hour, send_minute, user_timezone,
                         lookback_days, include_oa_only, articles_per_email, include_pdfs,
                         next_send_at, updated_at)
                    VALUES (:uid, :name, :source, true, :email,
                            CAST(:topics AS jsonb), :freq, :dow, :days, :hour, :minute,
                            :tz, :lookback, :oa_only, :ape, :include_pdfs, :next_send, NOW())
                    RETURNING id::text
                """), {**p, "uid": str(_uid), "next_send": next_send}).scalar()
        except Exception as exc:
            return jsonify({"error": str(exc)[:300]}), 500

    from .services.email_digest import send_digest_for_sub
    ok = send_digest_for_sub(str(sub_id), force=True)
    if ok:
        return jsonify({"ok": True, "detail": "Email de prueba enviado."})
    return jsonify({"error": "send_failed",
                    "detail": "No se pudo enviar el email. Revisa la configuración SMTP."}), 502


@prionvault_bp.route("/api/notifications/timezones", methods=["GET"])
@login_required
def api_notifications_timezones():
    zones = [
        "UTC", "Europe/Madrid", "Europe/London", "Europe/Paris",
        "Europe/Berlin", "America/New_York", "America/Chicago",
        "America/Denver", "America/Los_Angeles", "America/Sao_Paulo",
        "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Australia/Sydney",
    ]
    return jsonify(zones)


# ── Multi-subscription CRUD ───────────────────────────────────────────────────

@prionvault_bp.route("/api/notifications/subscriptions", methods=["GET"])
@login_required
def api_notifications_list():
    from sqlalchemy import text as _t
    from database.config import db as _db
    _uid = session.get("user_id")
    try:
        with _db.engine.connect() as conn:
            rows = conn.execute(_t(
                "SELECT * FROM prionvault_notification_subscriptions "
                "WHERE user_id = :uid ORDER BY created_at"
            ), {"uid": str(_uid)}).mappings().all()
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500
    return jsonify([_notif_sub_to_dict(r) for r in rows])


@prionvault_bp.route("/api/notifications/subscriptions", methods=["POST"])
@login_required
def api_notifications_create():
    from sqlalchemy import text as _t
    from database.config import db as _db
    from core.users import get_user as _get_user
    from .services.email_digest import compute_next_send
    _uid = session.get("user_id")
    _uemail = (_get_user(session.get("username", "")) or {}).get("email", "")
    data = request.get_json(silent=True) or {}
    p = _validate_notif_payload(data, _uemail)
    next_send = compute_next_send({"frequency": p["freq"], "days_of_week": p["days"],
                                   "send_hour": p["hour"], "send_minute": p["minute"],
                                   "user_timezone": p["tz"]})
    try:
        with _db.engine.begin() as conn:
            new_id = conn.execute(_t("""
                INSERT INTO prionvault_notification_subscriptions
                    (user_id, name, source, enabled, email, topics, frequency,
                     day_of_week, days_of_week, send_hour, send_minute, user_timezone,
                     lookback_days, include_oa_only, articles_per_email, include_pdfs,
                     next_send_at, updated_at)
                VALUES (:uid, :name, :source, :enabled, :email,
                        CAST(:topics AS jsonb), :freq, :dow, :days, :hour, :minute,
                        :tz, :lookback, :oa_only, :ape, :include_pdfs, :next_send, NOW())
                RETURNING id::text
            """), {**p, "uid": str(_uid), "next_send": next_send}).scalar()
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500
    return jsonify({"ok": True, "id": new_id, "next_send_at": next_send.isoformat()})


@prionvault_bp.route("/api/notifications/subscriptions/<sub_id>", methods=["PUT"])
@login_required
def api_notifications_update(sub_id):
    from sqlalchemy import text as _t
    from database.config import db as _db
    from core.users import get_user as _get_user
    from .services.email_digest import compute_next_send
    _uid = session.get("user_id")
    _uemail = (_get_user(session.get("username", "")) or {}).get("email", "")
    data = request.get_json(silent=True) or {}
    p = _validate_notif_payload(data, _uemail)
    next_send = compute_next_send({"frequency": p["freq"], "days_of_week": p["days"],
                                   "send_hour": p["hour"], "send_minute": p["minute"],
                                   "user_timezone": p["tz"]})
    try:
        with _db.engine.begin() as conn:
            result = conn.execute(_t("""
                UPDATE prionvault_notification_subscriptions SET
                    name=:name, source=:source, enabled=:enabled, email=:email,
                    topics=CAST(:topics AS jsonb), frequency=:freq, day_of_week=:dow,
                    days_of_week=:days, send_hour=:hour, send_minute=:minute,
                    user_timezone=:tz, lookback_days=:lookback, include_oa_only=:oa_only,
                    articles_per_email=:ape, include_pdfs=:include_pdfs,
                    next_send_at=:next_send, updated_at=NOW()
                WHERE id=:id AND user_id=:uid
            """), {**p, "next_send": next_send, "id": sub_id, "uid": str(_uid)})
            if result.rowcount == 0:
                return jsonify({"error": "not_found"}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500
    return jsonify({"ok": True, "next_send_at": next_send.isoformat()})


@prionvault_bp.route("/api/notifications/subscriptions/<sub_id>", methods=["DELETE"])
@login_required
def api_notifications_delete(sub_id):
    from sqlalchemy import text as _t
    from database.config import db as _db
    _uid = session.get("user_id")
    try:
        with _db.engine.begin() as conn:
            result = conn.execute(_t(
                "DELETE FROM prionvault_notification_subscriptions "
                "WHERE id=:id AND user_id=:uid"
            ), {"id": sub_id, "uid": str(_uid)})
            if result.rowcount == 0:
                return jsonify({"error": "not_found"}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500
    return jsonify({"ok": True})


@prionvault_bp.route("/api/notifications/subscriptions/<sub_id>/test", methods=["POST"])
@login_required
def api_notifications_sub_test(sub_id):
    from sqlalchemy import text as _t
    from database.config import db as _db
    from config import smtp_configured
    _uid = session.get("user_id")
    if not smtp_configured():
        return jsonify({"error": "smtp_not_configured",
                        "detail": "SMTP no configurado en el servidor."}), 503
    try:
        with _db.engine.connect() as conn:
            actual_id = conn.execute(_t(
                "SELECT id::text FROM prionvault_notification_subscriptions "
                "WHERE id=:id AND user_id=:uid"
            ), {"id": sub_id, "uid": str(_uid)}).scalar()
    except Exception as exc:
        return jsonify({"error": str(exc)[:300]}), 500
    if not actual_id:
        return jsonify({"error": "not_found"}), 404
    from .services.email_digest import send_digest_for_sub
    ok = send_digest_for_sub(actual_id, force=True)
    if ok:
        return jsonify({"ok": True, "detail": "Email de prueba enviado."})
    return jsonify({"error": "send_failed",
                    "detail": "No se pudo enviar el email. Revisa la configuración SMTP."}), 502
