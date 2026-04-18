"""Analytics API routes."""
import logging

from flask import jsonify, session

from core.decorators import login_required
from . import analytics_bp
from .service import (
    get_overview, get_pipeline_analytics, get_publication_intelligence,
    get_research_performance, get_predictive_analytics, get_trends,
)

logger = logging.getLogger(__name__)


@analytics_bp.route("/overview")
@login_required
def overview():
    return jsonify(get_overview(session.get("username", "")))


@analytics_bp.route("/pipeline")
@login_required
def pipeline():
    return jsonify(get_pipeline_analytics(session.get("username", "")))


@analytics_bp.route("/publications")
@login_required
def publications():
    return jsonify(get_publication_intelligence(session.get("username", "")))


@analytics_bp.route("/performance")
@login_required
def performance():
    return jsonify(get_research_performance(session.get("username", "")))


@analytics_bp.route("/predictive")
@login_required
def predictive():
    return jsonify(get_predictive_analytics(session.get("username", "")))


@analytics_bp.route("/trends")
@login_required
def trends():
    return jsonify(get_trends(session.get("username", "")))


@analytics_bp.route("/export")
@login_required
def export_data():
    username = session.get("username", "")
    return jsonify({
        "success": True,
        "data": {
            "overview": get_overview(username),
            "pipeline": get_pipeline_analytics(username),
            "publications": get_publication_intelligence(username),
            "performance": get_research_performance(username),
            "trends": get_trends(username),
        },
        "exported_at": __import__("datetime").datetime.utcnow().isoformat(),
    })
