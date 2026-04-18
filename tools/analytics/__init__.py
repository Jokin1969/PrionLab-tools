"""Analytics Blueprint — research intelligence dashboard."""
from flask import Blueprint

analytics_bp = Blueprint(
    "analytics", __name__,
    url_prefix="/api/analytics",
)

from . import routes  # noqa: F401, E402
