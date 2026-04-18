"""Manuscript Dashboard Blueprint."""
from flask import Blueprint

manuscript_dashboard_bp = Blueprint(
    "manuscript_dashboard", __name__,
    url_prefix="/api/manuscripts",
)

from . import routes  # noqa: F401, E402
