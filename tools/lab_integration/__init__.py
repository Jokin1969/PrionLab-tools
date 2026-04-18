"""Lab Publication Integration — Blueprint."""
from flask import Blueprint

lab_integration_bp = Blueprint(
    "lab_integration", __name__,
    url_prefix="/api/lab",
)

from . import routes  # noqa: F401, E402
