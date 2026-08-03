"""Notas de Inicio — shared corkboard of sticky notes, mounted in the
PrionVault sidebar (between the brand block and the Library nav).

Ported from the PrionAAV Atlas blueprint. Multi-board system with
configurable per-note visibility (private / everyone / specific people)
and per-user "seen" tracking.

Any logged-in user (admin or reader) can use every endpoint here; per-row
authorization is enforced in SQL/Python below, not via @admin_required.
"""
import logging

from flask import jsonify, request, session
from sqlalchemy import text as sql_text

from core.decorators import login_required
from database.config import db

from . import home_notes_bp

logger = logging.getLogger(__name__)

_HOME_NOTA_COLORS = {"#FEF08A", "#BFDBFE", "#BBF7D0", "#FBCFE8",
                      "#FDE68A", "#DDD6FE", "#FECACA", "#E2E8F0"}
_VISIBILIDADES = ("privada", "todos", "personalizada")


def _payload():
    return request.get_json(silent=True) or {}


def _uid():
    return session.get("user_id")


def _is_admin():
    return session.get("role") == "admin"


def _require_user():
    uid = _uid()
    if not uid:
        return None, (jsonify({"error": "not_authenticated"}), 401)
    return uid, None


def _fmt_nombre(first_name, last_name):
    return " ".join(filter(None, [first_name, last_name])) or "—"


def _visible_where():
    """SQL condition (+ named params) for notes the current user may SEE."""
    return (
        "(n.autor_id = CAST(:uid AS uuid) OR n.visibilidad = 'todos' OR "
        " (n.visibilidad = 'personalizada' AND EXISTS("
        "    SELECT 1 FROM home_nota_usuario hu "
        "    WHERE hu.id_nota = n.id_nota AND hu.id_usuario = CAST(:uid AS uuid))))"
    )


def _ensure_default_tablon(s):
    """Self-heal: guarantee board id=1 ("Notas") exists before any read/write.
    Belt-and-suspenders alongside the migration's seed insert — if the
    migration hasn't run yet (or ran before this table existed), notes
    would otherwise fail with "Tablón no encontrado" on first use."""
    s.execute(sql_text(
        "INSERT INTO home_tablon (id_tablon, nombre, autor_id, orden) "
        "VALUES (1, 'Notas', NULL, 0) ON CONFLICT (id_tablon) DO NOTHING"
    ))
    s.commit()


def _tablones_rows(s, uid, is_admin):
    where = _visible_where()
    rows = s.execute(sql_text(
        f"""SELECT t.id_tablon, t.nombre, t.autor_id, t.orden,
                   au.first_name AS autor_first, au.last_name AS autor_last,
                   (SELECT COUNT(*) FROM home_nota n
                      WHERE n.id_tablon = t.id_tablon AND {where}) AS n,
                   (SELECT COUNT(*) FROM home_nota n
                      LEFT JOIN home_nota_visto v
                        ON v.id_nota = n.id_nota AND v.id_usuario = CAST(:uid AS uuid)
                     WHERE n.id_tablon = t.id_tablon AND {where}
                       AND (v.fecha_visto IS NULL OR v.fecha_visto < n.fecha_modif)) AS nuevas
              FROM home_tablon t
              LEFT JOIN users au ON au.id = t.autor_id
             ORDER BY t.orden, t.id_tablon"""
    ), {"uid": uid}).mappings().all()
    out = []
    for r in rows:
        out.append({
            "id_tablon": r["id_tablon"], "nombre": r["nombre"], "autor_id": str(r["autor_id"]) if r["autor_id"] else None,
            "autor_nombre": _fmt_nombre(r["autor_first"], r["autor_last"]) if r["autor_id"] else None,
            "es_mio": str(r["autor_id"]) == str(uid) if r["autor_id"] else False,
            "puede_gestionar": (str(r["autor_id"]) == str(uid) if r["autor_id"] else False) or is_admin,
            "n": r["n"], "nuevas": r["nuevas"],
        })
    return out


def _notas_rows(s, uid, is_admin, id_tablon=None):
    where = _visible_where()
    params = {"uid": uid}
    extra = ""
    if id_tablon is not None:
        extra = " AND n.id_tablon = :id_tablon"
        params["id_tablon"] = id_tablon
    rows = s.execute(sql_text(
        f"""SELECT n.*,
                   au.first_name AS autor_first, au.last_name AS autor_last,
                   ed.first_name AS editor_first, ed.last_name AS editor_last,
                   v.fecha_visto AS mi_visto
              FROM home_nota n
              JOIN users au ON au.id = n.autor_id
              LEFT JOIN users ed ON ed.id = n.editado_por
              LEFT JOIN home_nota_visto v
                ON v.id_nota = n.id_nota AND v.id_usuario = CAST(:uid AS uuid)
             WHERE {where}{extra}
             ORDER BY n.fecha_creacion"""
    ), params).mappings().all()

    ids = [r["id_nota"] for r in rows]
    viewers_by_note = {}
    if ids:
        vrows = s.execute(sql_text(
            """SELECT hu.id_nota, u.id, u.first_name, u.last_name
                 FROM home_nota_usuario hu JOIN users u ON u.id = hu.id_usuario
                WHERE hu.id_nota = ANY(:ids)
                ORDER BY u.first_name"""
        ), {"ids": ids}).mappings().all()
        for r in vrows:
            viewers_by_note.setdefault(r["id_nota"], []).append(
                {"id_usuario": str(r["id"]), "nombre": _fmt_nombre(r["first_name"], r["last_name"])})

    out = []
    for r in rows:
        es_mia = str(r["autor_id"]) == str(uid)
        out.append({
            "id_nota": r["id_nota"], "id_tablon": r["id_tablon"],
            "contenido": r["contenido"], "color": r["color"],
            "pos_x": r["pos_x"], "pos_y": r["pos_y"],
            "ancho": r["ancho"], "alto": r["alto"],
            "visibilidad": r["visibilidad"], "autor_id": str(r["autor_id"]),
            "autor_nombre": _fmt_nombre(r["autor_first"], r["autor_last"]),
            "editor_nombre": _fmt_nombre(r["editor_first"], r["editor_last"]) if r["editado_por"] else None,
            "fecha_creacion": r["fecha_creacion"].isoformat() if r["fecha_creacion"] else None,
            "fecha_modif": r["fecha_modif"].isoformat() if r["fecha_modif"] else None,
            "es_mia": es_mia, "puede_gestionar": es_mia or is_admin,
            "nuevo": (r["mi_visto"] is None) or (r["mi_visto"] < r["fecha_modif"]),
            "destinatarios": viewers_by_note.get(r["id_nota"], []),
        })
    return out


# ── Tablones ─────────────────────────────────────────────────────────────

@home_notes_bp.route("/home-tablones", methods=["GET"])
@login_required
def home_tablones_get():
    uid, err = _require_user()
    if err:
        return err
    s = db.Session()
    try:
        _ensure_default_tablon(s)
        return jsonify({"tablones": _tablones_rows(s, uid, _is_admin())})
    except Exception:
        s.rollback()
        logger.exception("home_tablones_get failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


@home_notes_bp.route("/home-tablones", methods=["POST"])
@login_required
def home_tablones_create():
    uid, err = _require_user()
    if err:
        return err
    nombre = (_payload().get("nombre") or "").strip()[:60]
    if not nombre:
        return jsonify({"error": "El nombre es obligatorio"}), 400
    s = db.Session()
    try:
        orden = s.execute(sql_text(
            "SELECT COALESCE(MAX(orden), -1) + 1 AS o FROM home_tablon")).mappings().first()["o"]
        id_tablon = s.execute(sql_text(
            "INSERT INTO home_tablon (nombre, autor_id, orden) "
            "VALUES (:nombre, CAST(:uid AS uuid), :orden) RETURNING id_tablon"
        ), {"nombre": nombre, "uid": uid, "orden": orden}).scalar()
        s.commit()
        tablon = next((t for t in _tablones_rows(s, uid, _is_admin()) if t["id_tablon"] == id_tablon), None)
        return jsonify({"tablon": tablon}), 201
    except Exception:
        s.rollback()
        logger.exception("home_tablones_create failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


@home_notes_bp.route("/home-tablones/<int:id_tablon>", methods=["PUT"])
@login_required
def home_tablones_update(id_tablon):
    uid, err = _require_user()
    if err:
        return err
    is_admin = _is_admin()
    s = db.Session()
    try:
        row = s.execute(sql_text(
            "SELECT autor_id FROM home_tablon WHERE id_tablon = :id"
        ), {"id": id_tablon}).mappings().first()
        if not row:
            return jsonify({"error": "No encontrado"}), 404
        if str(row["autor_id"]) != str(uid) and not is_admin:
            return jsonify({"error": "Solo quien lo creó (o un Admin) puede renombrarlo"}), 403
        nombre = (_payload().get("nombre") or "").strip()[:60]
        if not nombre:
            return jsonify({"error": "El nombre es obligatorio"}), 400
        s.execute(sql_text(
            "UPDATE home_tablon SET nombre = :nombre WHERE id_tablon = :id"
        ), {"nombre": nombre, "id": id_tablon})
        s.commit()
        tablon = next((t for t in _tablones_rows(s, uid, is_admin) if t["id_tablon"] == id_tablon), None)
        return jsonify({"tablon": tablon})
    except Exception:
        s.rollback()
        logger.exception("home_tablones_update failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


@home_notes_bp.route("/home-tablones/<int:id_tablon>", methods=["DELETE"])
@login_required
def home_tablones_delete(id_tablon):
    uid, err = _require_user()
    if err:
        return err
    is_admin = _is_admin()
    s = db.Session()
    try:
        row = s.execute(sql_text(
            "SELECT autor_id FROM home_tablon WHERE id_tablon = :id"
        ), {"id": id_tablon}).mappings().first()
        if not row:
            return jsonify({"ok": True})
        if str(row["autor_id"]) != str(uid) and not is_admin:
            return jsonify({"error": "Solo quien lo creó (o un Admin) puede borrarlo"}), 403
        total = s.execute(sql_text("SELECT COUNT(*) AS c FROM home_tablon")).mappings().first()["c"]
        if total <= 1:
            return jsonify({"error": "No puedes borrar el último tablón"}), 400
        s.execute(sql_text("DELETE FROM home_nota WHERE id_tablon = :id"), {"id": id_tablon})
        s.execute(sql_text("DELETE FROM home_tablon WHERE id_tablon = :id"), {"id": id_tablon})
        s.commit()
        return jsonify({"ok": True})
    except Exception:
        s.rollback()
        logger.exception("home_tablones_delete failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


# ── Notas ────────────────────────────────────────────────────────────────

@home_notes_bp.route("/home-notas", methods=["GET"])
@login_required
def home_notas_get():
    uid, err = _require_user()
    if err:
        return err
    id_tablon = request.args.get("id_tablon", type=int)
    s = db.Session()
    try:
        _ensure_default_tablon(s)
        notas = _notas_rows(s, uid, _is_admin(), id_tablon)
        return jsonify({"notas": notas, "n": len(notas), "nuevas": sum(1 for n in notas if n["nuevo"])})
    except Exception:
        s.rollback()
        logger.exception("home_notas_get failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


@home_notes_bp.route("/home-notas", methods=["POST"])
@login_required
def home_notas_create():
    uid, err = _require_user()
    if err:
        return err
    data = _payload()
    contenido = (data.get("contenido") or "").strip()
    color = (data.get("color") or "#FEF08A").strip()
    if color not in _HOME_NOTA_COLORS:
        color = "#FEF08A"
    visibilidad = (data.get("visibilidad") or "privada").strip()
    if visibilidad not in _VISIBILIDADES:
        visibilidad = "privada"
    try:
        pos_x = float(data.get("pos_x")) if data.get("pos_x") is not None else 24.0
        pos_y = float(data.get("pos_y")) if data.get("pos_y") is not None else 24.0
    except (TypeError, ValueError):
        pos_x, pos_y = 24.0, 24.0
    try:
        ancho = max(160.0, float(data.get("ancho"))) if data.get("ancho") is not None else 240.0
        alto = max(140.0, float(data.get("alto"))) if data.get("alto") is not None else 200.0
    except (TypeError, ValueError):
        ancho, alto = 240.0, 200.0
    try:
        id_tablon = int(data.get("id_tablon")) if data.get("id_tablon") is not None else 1
    except (TypeError, ValueError):
        id_tablon = 1

    s = db.Session()
    try:
        _ensure_default_tablon(s)
        if not s.execute(sql_text(
                "SELECT 1 FROM home_tablon WHERE id_tablon = :id"), {"id": id_tablon}).first():
            return jsonify({"error": "Tablón no encontrado"}), 400
        id_nota = s.execute(sql_text(
            """INSERT INTO home_nota (contenido, color, pos_x, pos_y, ancho, alto, visibilidad, autor_id, id_tablon)
               VALUES (:contenido, :color, :pos_x, :pos_y, :ancho, :alto, :visibilidad, CAST(:uid AS uuid), :id_tablon)
               RETURNING id_nota"""
        ), {"contenido": contenido, "color": color, "pos_x": pos_x, "pos_y": pos_y,
            "ancho": ancho, "alto": alto, "visibilidad": visibilidad, "uid": uid,
            "id_tablon": id_tablon}).scalar()
        if visibilidad == "personalizada":
            viewer_ids = {str(v) for v in (data.get("viewer_ids") or []) if str(v).strip()}
            viewer_ids.discard(str(uid))
            for vid in viewer_ids:
                s.execute(sql_text(
                    "INSERT INTO home_nota_usuario (id_nota, id_usuario) VALUES (:id_nota, CAST(:vid AS uuid)) "
                    "ON CONFLICT DO NOTHING"
                ), {"id_nota": id_nota, "vid": vid})
        s.commit()
        row = next((n for n in _notas_rows(s, uid, _is_admin()) if n["id_nota"] == id_nota), None)
        return jsonify({"nota": row}), 201
    except Exception:
        s.rollback()
        logger.exception("home_notas_create failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


@home_notes_bp.route("/home-notas/<int:id_nota>", methods=["PUT"])
@login_required
def home_notas_update(id_nota):
    uid, err = _require_user()
    if err:
        return err
    is_admin = _is_admin()
    s = db.Session()
    try:
        row = s.execute(sql_text(
            "SELECT * FROM home_nota WHERE id_nota = :id"), {"id": id_nota}).mappings().first()
        if not row:
            return jsonify({"error": "No encontrada"}), 404
        where = _visible_where()
        puede_ver = s.execute(sql_text(
            f"SELECT 1 FROM home_nota n WHERE n.id_nota = :id AND {where}"
        ), {"id": id_nota, "uid": uid}).first()
        if not puede_ver:
            return jsonify({"error": "No tienes acceso a esta nota"}), 403

        es_gestor = (str(row["autor_id"]) == str(uid)) or is_admin
        data = _payload()
        fields, params = [], {"id": id_nota, "uid": uid}

        if "contenido" in data:
            fields.append("contenido = :contenido")
            params["contenido"] = (data.get("contenido") or "").strip()
        if "color" in data:
            c = (data.get("color") or "").strip()
            if c in _HOME_NOTA_COLORS:
                fields.append("color = :color")
                params["color"] = c
        if "pos_x" in data and "pos_y" in data:
            try:
                params["pos_x"] = float(data.get("pos_x"))
                params["pos_y"] = float(data.get("pos_y"))
                fields += ["pos_x = :pos_x", "pos_y = :pos_y"]
            except (TypeError, ValueError):
                pass
        if "ancho" in data and "alto" in data:
            try:
                params["ancho"] = max(160.0, float(data.get("ancho")))
                params["alto"] = max(140.0, float(data.get("alto")))
                fields += ["ancho = :ancho", "alto = :alto"]
            except (TypeError, ValueError):
                pass
        if es_gestor and "visibilidad" in data:
            vis = (data.get("visibilidad") or "").strip()
            if vis in _VISIBILIDADES:
                fields.append("visibilidad = :visibilidad")
                params["visibilidad"] = vis
                s.execute(sql_text(
                    "DELETE FROM home_nota_usuario WHERE id_nota = :id"), {"id": id_nota})
                if vis == "personalizada":
                    viewer_ids = {str(v) for v in (data.get("viewer_ids") or []) if str(v).strip()}
                    viewer_ids.discard(str(row["autor_id"]))
                    for vid in viewer_ids:
                        s.execute(sql_text(
                            "INSERT INTO home_nota_usuario (id_nota, id_usuario) "
                            "VALUES (:id_nota, CAST(:vid AS uuid)) ON CONFLICT DO NOTHING"
                        ), {"id_nota": id_nota, "vid": vid})

        if not fields:
            return jsonify({"error": "Sin cambios"}), 400

        fields += ["editado_por = CAST(:uid AS uuid)", "fecha_modif = NOW()"]
        s.execute(sql_text(
            f"UPDATE home_nota SET {', '.join(fields)} WHERE id_nota = :id"
        ), params)
        s.execute(sql_text(
            "INSERT INTO home_nota_visto (id_nota, id_usuario, fecha_visto) "
            "VALUES (:id, CAST(:uid AS uuid), NOW()) "
            "ON CONFLICT (id_nota, id_usuario) DO UPDATE SET fecha_visto = NOW()"
        ), {"id": id_nota, "uid": uid})
        s.commit()
        out = next((n for n in _notas_rows(s, uid, is_admin) if n["id_nota"] == id_nota), None)
        return jsonify({"nota": out})
    except Exception:
        s.rollback()
        logger.exception("home_notas_update failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


@home_notes_bp.route("/home-notas/<int:id_nota>", methods=["DELETE"])
@login_required
def home_notas_delete(id_nota):
    uid, err = _require_user()
    if err:
        return err
    is_admin = _is_admin()
    s = db.Session()
    try:
        row = s.execute(sql_text(
            "SELECT autor_id FROM home_nota WHERE id_nota = :id"), {"id": id_nota}).mappings().first()
        if not row:
            return jsonify({"ok": True})
        if str(row["autor_id"]) != str(uid) and not is_admin:
            return jsonify({"error": "Solo la autora/el autor (o un Admin) puede borrarla"}), 403
        s.execute(sql_text("DELETE FROM home_nota WHERE id_nota = :id"), {"id": id_nota})
        s.commit()
        return jsonify({"ok": True})
    except Exception:
        s.rollback()
        logger.exception("home_notas_delete failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


@home_notes_bp.route("/home-notas/marcar-vistas", methods=["POST"])
@login_required
def home_notas_marcar_vistas():
    uid, err = _require_user()
    if err:
        return err
    data = _payload()
    try:
        id_tablon = int(data.get("id_tablon")) if data.get("id_tablon") is not None else None
    except (TypeError, ValueError):
        id_tablon = None
    where = _visible_where()
    params = {"uid": uid}
    extra = ""
    if id_tablon is not None:
        extra = " AND n.id_tablon = :id_tablon"
        params["id_tablon"] = id_tablon
    s = db.Session()
    try:
        ids = [r[0] for r in s.execute(sql_text(
            f"SELECT n.id_nota FROM home_nota n WHERE {where}{extra}"), params).all()]
        for id_nota in ids:
            s.execute(sql_text(
                "INSERT INTO home_nota_visto (id_nota, id_usuario, fecha_visto) "
                "VALUES (:id, CAST(:uid AS uuid), NOW()) "
                "ON CONFLICT (id_nota, id_usuario) DO UPDATE SET fecha_visto = NOW()"
            ), {"id": id_nota, "uid": uid})
        s.commit()
        return jsonify({"ok": True, "n": len(ids)})
    except Exception:
        s.rollback()
        logger.exception("home_notas_marcar_vistas failed")
        return jsonify({"error": "internal"}), 500
    finally:
        s.close()


# ── Directorio de usuarios (para el modal de compartir) ────────────────────

@home_notes_bp.route("/home-notas/usuarios", methods=["GET"])
@login_required
def home_notas_usuarios():
    uid, err = _require_user()
    if err:
        return err
    s = db.Session()
    try:
        rows = s.execute(sql_text(
            "SELECT id, first_name, last_name, role FROM users ORDER BY first_name, last_name"
        )).mappings().all()
        return jsonify({"usuarios": [
            {"id_usuario": str(r["id"]), "nombre": _fmt_nombre(r["first_name"], r["last_name"]), "rol": r["role"]}
            for r in rows
        ]})
    finally:
        s.close()
