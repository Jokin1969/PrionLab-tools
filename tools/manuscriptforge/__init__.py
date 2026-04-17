from flask import Blueprint

manuscriptforge_bp = Blueprint(
    "manuscriptforge",
    __name__,
    template_folder="templates",
    url_prefix="/tools/manuscriptforge",
)

from . import routes  # noqa: F401, E402
