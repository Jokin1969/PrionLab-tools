import logging
import os

import requests as http
from flask import Response, send_from_directory, request

from core.decorators import login_required
from . import prionread_bp

logger = logging.getLogger(__name__)

# Absolute path to the compiled React SPA
DIST_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../prionread/frontend/dist")
)

# URL of the PrionRead Node.js backend — set PRIONREAD_API_URL in Railway env vars
BACKEND_URL = os.environ.get("PRIONREAD_API_URL", "http://localhost:3001")

_STRIP_HEADERS = {"content-encoding", "transfer-encoding", "connection", "keep-alive"}


# ── API proxy ─────────────────────────────────────────────────────────────────
# Forwards /prionread/api/* → Node.js backend /api/*
# No Flask login_required here — PrionRead manages its own JWT auth

@prionread_bp.route("/api/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def proxy_api(path):
    url = f"{BACKEND_URL}/api/{path}"
    headers = {k: v for k, v in request.headers if k.lower() != "host"}
    try:
        resp = http.request(
            method=request.method,
            url=url,
            headers=headers,
            data=request.get_data(),
            params=request.args,
            cookies=request.cookies,
            allow_redirects=False,
            timeout=30,
        )
        response_headers = {
            k: v for k, v in resp.headers.items()
            if k.lower() not in _STRIP_HEADERS
        }
        return Response(resp.content, status=resp.status_code, headers=response_headers)
    except Exception as exc:
        logger.error("[prionread proxy] %s %s → %s", request.method, path, exc)
        return Response(
            '{"error":"PrionRead backend unavailable"}',
            status=503,
            mimetype="application/json",
        )


# ── Static assets (JS/CSS bundles) ───────────────────────────────────────────

@prionread_bp.route("/assets/<path:filename>")
def assets(filename):
    return send_from_directory(os.path.join(DIST_DIR, "assets"), filename)


# ── SPA entry point and client-side routes ────────────────────────────────────
# Requires Flask session login to access PrionRead at all

@prionread_bp.route("/")
@prionread_bp.route("/index")
@prionread_bp.route("/<path:path>")
@login_required
def index(path=""):
    if not os.path.isdir(DIST_DIR):
        return (
            "<h2>PrionRead frontend not built.</h2>"
            "<p>Run: <code>cd prionread/frontend && npm run build</code></p>",
            503,
        )
    return send_from_directory(DIST_DIR, "index.html")
