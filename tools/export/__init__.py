from flask import Blueprint

export_bp = Blueprint("export", __name__, template_folder="templates", url_prefix="/export")

from . import routes  # noqa: F401, E402
