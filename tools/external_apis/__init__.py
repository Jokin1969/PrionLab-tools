"""External API Integration — Blueprint registration."""
from flask import Blueprint

external_api_bp = Blueprint(
    "external_apis", __name__,
    url_prefix="/api/external",
)

from . import routes  # noqa: F401, E402
