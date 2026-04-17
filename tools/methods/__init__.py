from flask import Blueprint

methods_bp = Blueprint(
    "methods",
    __name__,
    template_folder="templates",
    url_prefix="/methods",
)

from . import routes  # noqa: F401, E402
