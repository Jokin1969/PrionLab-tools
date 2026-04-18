from flask import Blueprint

ai_bp = Blueprint(
    "ai_assistant", __name__,
    template_folder="templates",
    url_prefix="/ai",
)

from . import routes  # noqa: F401, E402
