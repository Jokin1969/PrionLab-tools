from flask import Blueprint

introduction_bp = Blueprint(
    "introduction",
    __name__,
    template_folder="templates",
    url_prefix="/introduction",
)

from . import routes  # noqa: F401, E402
