from flask import Blueprint

prionpacks_bp = Blueprint(
    "prionpacks",
    __name__,
    template_folder="templates",
    url_prefix="/prionpacks",
)

from . import routes  # noqa: F401, E402
