from flask import Blueprint

research_bp = Blueprint(
    "research", __name__,
    template_folder="templates",
    url_prefix="/research",
)

from . import routes  # noqa: F401, E402
