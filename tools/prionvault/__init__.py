"""PrionVault — searchable AI-powered prion-research library.

Reads from the canonical `articles` table that PrionRead also uses, plus
its own sibling tables (`article_chunk`, `article_tag`, `article_tag_link`,
`article_annotation`, `prionvault_ingest_job`, `prionvault_usage`).

URL prefix: /prionvault
"""
from flask import Blueprint

prionvault_bp = Blueprint(
    "prionvault",
    __name__,
    template_folder="templates",
    url_prefix="/prionvault",
)

from . import routes  # noqa: F401, E402  (registers route handlers)
