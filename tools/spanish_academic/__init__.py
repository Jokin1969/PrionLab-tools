"""Spanish Academic Systems — ANECA & CVN FECYT integration."""
from flask import Blueprint

spanish_academic_bp = Blueprint(
    "spanish_academic", __name__,
    url_prefix="/api/spanish-academic",
)

from . import routes  # noqa: F401, E402
