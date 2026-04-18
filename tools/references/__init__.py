"""References Blueprint — BibTeX import and bibliography management."""
from flask import Blueprint

references_bp = Blueprint(
    "references", __name__,
    url_prefix="/api/references",
)

from . import routes  # noqa: F401, E402
