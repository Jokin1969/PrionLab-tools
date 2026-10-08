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

    Two possible shared keys, each granting a different role:
      - PRIONVAULT_EXTENSION_API_KEY   -> admin (the original key; can add
        articles/PDFs directly, unchanged from before).
      - PRIONVAULT_EXTENSION_READER_KEY -> reader (new: can only look up
        metadata and submit a suggestion by email — see
        POST /api/articles/suggest — everything gated @admin_required
        stays out of reach, enforced in core/decorators.py's _ext_role()
        check, not just here).
    Sets g._ext_authed = True and g._ext_authed_role accordingly. The auth
    decorators (login_required / admin_required / editor_required) and
    _helpers (_viewer_role, _viewer_id) check these so existing route code
    needs no changes. We deliberately do NOT touch the session to avoid
    accidentally issuing a session cookie to a browser.
    """
    key = (request.headers.get("X-PrionVault-Key") or "").strip()
    if not key:
        return
    admin_key = os.environ.get("PRIONVAULT_EXTENSION_API_KEY", "").strip()
    if admin_key and secrets.compare_digest(key, admin_key):
        g._ext_authed = True
        g._ext_authed_role = "admin"
        return
    reader_key = os.environ.get("PRIONVAULT_EXTENSION_READER_KEY", "").strip()
    if reader_key and secrets.compare_digest(key, reader_key):
        g._ext_authed = True
        g._ext_authed_role = "reader"


from . import routes  # noqa: F401, E402  (registers route handlers)
