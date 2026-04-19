"""Manuscript dashboard API routes."""
import logging

from flask import jsonify, request, session

from core.decorators import login_required
from . import manuscript_dashboard_bp
from .service import (
    create_manuscript, create_project, get_dashboard_data,
    get_manuscript, get_manuscripts, get_projects, get_templates,
    update_manuscript_status, update_manuscript_abstract,
)

logger = logging.getLogger(__name__)


@manuscript_dashboard_bp.route("/dashboard")
@login_required
def dashboard_data():
    username = session.get("username", "")
    return jsonify(get_dashboard_data(username))


@manuscript_dashboard_bp.route("/create", methods=["POST"])
@login_required
def create():
    username = session.get("username", "")
    data = request.get_json(silent=True) or {}
    result = create_manuscript(data, username)
    return jsonify(result), 201 if result.get("success") else 400


@manuscript_dashboard_bp.route("/list")
@login_required
def list_manuscripts():
    username = session.get("username", "")
    status_filter = request.args.get("status", "all")
    project_filter = request.args.get("project_id", "")
    limit = min(int(request.args.get("limit", 50)), 100)
    items = get_manuscripts(username, status_filter, project_filter, limit)
    return jsonify({"success": True, "manuscripts": items, "count": len(items)})


@manuscript_dashboard_bp.route("/<manuscript_id>")
@login_required
def get_one(manuscript_id):
    username = session.get("username", "")
    m = get_manuscript(manuscript_id, username)
    if not m:
        return jsonify({"success": False, "error": "Manuscript not found"}), 404
    return jsonify({"success": True, "manuscript": m})


@manuscript_dashboard_bp.route("/<manuscript_id>/status", methods=["PUT"])
@login_required
def update_status(manuscript_id):
    username = session.get("username", "")
    data = request.get_json(silent=True) or {}
    new_status = data.get("status", "").strip()
    if not new_status:
        return jsonify({"success": False, "error": "status required"}), 400
    result = update_manuscript_status(manuscript_id, new_status, username, data.get("notes", ""))
    return jsonify(result), 200 if result.get("success") else 400


@manuscript_dashboard_bp.route("/projects")
@login_required
def list_projects():
    username = session.get("username", "")
    return jsonify({"success": True, "projects": get_projects(username)})


@manuscript_dashboard_bp.route("/<manuscript_id>/abstract", methods=["PUT"])
@login_required
def update_abstract(manuscript_id):
    username = session.get("username", "")
    data = request.get_json(silent=True) or {}
    result = update_manuscript_abstract(
        manuscript_id,
        abstract_en=data.get("abstract_en", ""),
        abstract_es=data.get("abstract_es", ""),
        username=username,
    )
    return jsonify(result), 200 if result.get("success") else 400


@manuscript_dashboard_bp.route("/projects", methods=["POST"])
@login_required
def create_proj():
    username = session.get("username", "")
    data = request.get_json(silent=True) or {}
    result = create_project(data, username)
    return jsonify(result), 201 if result.get("success") else 400


@manuscript_dashboard_bp.route("/templates")
@login_required
def list_templates():
    return jsonify({"success": True, "templates": get_templates()})
