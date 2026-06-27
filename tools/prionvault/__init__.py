"""PrionVault — searchable AI-powered prion-research library.

Reads from the canonical `articles` table that PrionRead also uses, plus
its own sibling tables (`article_chunk`, `article_tag`, `article_tag_link`,
`article_annotation`, `prionvault_ingest_job`, `prionvault_usage`).

URL prefix: /prionvault
"""
import os
import secrets

from flask import Blueprint, g, request

prionvault_bp = Blueprint(
    "prionvault",
    __name__,
    template_folder="templates",
    url_prefix="/prionvault",
)


@prionvault_bp.before_request
def _check_extension_api_key() -> None:
    """Authenticate the Chrome extension via X-PrionVault-Key header.

    Sets g._ext_authed = True when the key matches PRIONVAULT_EXTENSION_API_KEY.
    The auth decorators (login_required / admin_required) and _helpers
    (_viewer_role, _viewer_id) check this flag so existing route code
    needs no changes. We deliberately do NOT touch the session to avoid
    accidentally issuing an admin session cookie to a browser.
    """
    key = (request.headers.get("X-PrionVault-Key") or "").strip()
    if not key:
        return
    expected = os.environ.get("PRIONVAULT_EXTENSION_API_KEY", "").strip()
    if expected and secrets.compare_digest(key, expected):
        g._ext_authed = True


from . import routes  # noqa: F401, E402  (registers route handlers)
