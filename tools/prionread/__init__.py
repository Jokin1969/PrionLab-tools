from flask import Blueprint

prionread_bp = Blueprint(
    "prionread",
    __name__,
    url_prefix="/prionread",
)

from . import routes  # noqa: F401, E402
