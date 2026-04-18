from flask import Blueprint

userprofile_bp = Blueprint(
    "userprofile", __name__,
    template_folder="templates",
    url_prefix="/lab",
)

from . import routes  # noqa: F401, E402
