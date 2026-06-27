import os
import logging
import logging.handlers
from urllib.parse import urlencode

# ── Sentry: init as early as possible so unhandled errors during
# blueprint registration / DB bootstrap also get captured. No-op when
# SENTRY_DSN is unset, so local dev stays untouched.
if os.environ.get("SENTRY_DSN"):
    import sentry_sdk

    # Patterns inside `message` we explicitly DON'T want to alert on.
    # Mostly QPDF / pdfminer / ocrmypdf chatter that gets logged at
    # WARNING level when processing slightly-malformed PDFs — the
    # tools recover and produce valid output, so a Sentry alert per
    # input is pure noise.
    _SENTRY_NOISE_PATTERNS = (
        "pl_dct::decompress",
        "error decoding stream data for object",
        "qpdf:",
        "jpeg data is corrupt",
        "ocrmypdf: warning",
    )

    def _sentry_filter(event, hint):
        try:
            msg = (event.get("message") or "").lower()
            if not msg and event.get("logentry"):
                msg = (event["logentry"].get("message") or "").lower()
            if any(p in msg for p in _SENTRY_NOISE_PATTERNS):
                return None    # drop
        except Exception:
            pass
        return event

    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
        release=os.environ.get("RAILWAY_GIT_COMMIT_SHA"),
        send_default_pii=False,
        traces_sample_rate=0.0,
        before_send=_sentry_filter,
    )
    sentry_sdk.set_tag("service", "prionvault")

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from flask_babel import Babel
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

import config
from core.auth import auth_bp, bootstrap_admin_user
from core.db import init_db
from core.decorators import login_required
from core.sync import initial_sync


def _ensure_data_dirs():
    for d in [config.CSV_DIR, config.PAPERS_DIR, config.CACHE_DIR, config.LOGS_DIR]:
        os.makedirs(d, exist_ok=True)


def _setup_logging(app: Flask):
    log_file = os.path.join(config.LOGS_DIR, "prionlab.log")
    handler = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=5 * 1024 * 1024, backupCount=3
    )
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s: %(message)s"
    ))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    if app.debug:
        root.addHandler(logging.StreamHandler())


def _init_postgresql(app: Flask) -> None:
    """Optionally initialise PostgreSQL if DATABASE_URL is configured."""
    from database.config import db
    if not db.is_configured():
        app.logger.info("DATABASE_URL not set — running in CSV-only mode")
        return
    try:
        if not db.test_connection():
            app.logger.warning("PostgreSQL connection test failed — CSV fallback active")
            return
        db.create_all_tables()
        from database.migration import run_migration
        result = run_migration()
        if result.get("success"):
            app.logger.info(
                "PostgreSQL ready — users=%d labs=%d pubs=%d",
                result.get("users_migrated", 0),
                result.get("labs_migrated", 0),
                result.get("publications_migrated", 0),
            )
        else:
            app.logger.warning("Migration reported: %s", result.get("error", "unknown"))
    except Exception as e:
        app.logger.warning("PostgreSQL init failed (CSV fallback active): %s", e)


def _start_maintenance_scheduler(app: Flask) -> None:
    """Start background maintenance tasks when DB is configured."""
    try:
        from database.maintenance import MaintenanceScheduler
        scheduler = MaintenanceScheduler(app)
        scheduler.start()
        app._maintenance_scheduler = scheduler
    except Exception as e:
        app.logger.warning("Maintenance scheduler not started: %s", e)


def _start_prionpacks_backup_scheduler(app: Flask) -> None:
    """Periodically back up prionpacks.json to Dropbox if changes are detected."""
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from tools.prionpacks.backup import run_backup

        scheduler = BackgroundScheduler(daemon=True)
        scheduler.add_job(
            run_backup,
            trigger='interval',
            hours=config.PRIONPACKS_BACKUP_INTERVAL_HOURS,
            id='prionpacks_dropbox_backup',
            replace_existing=True,
        )
        scheduler.start()
        app._prionpacks_backup_scheduler = scheduler
        app.logger.info(
            "PrionPacks backup scheduler started (every %dh → Dropbox)",
            config.PRIONPACKS_BACKUP_INTERVAL_HOURS,
        )
    except Exception as e:
        app.logger.warning("PrionPacks backup scheduler not started: %s", e)


def create_app() -> Flask:
    app = Flask(__name__)
    app.secret_key = config.SECRET_KEY

    _ensure_data_dirs()
    _setup_logging(app)

    # ── Rate limiting ────────────────────────────────────────────────────────
    # Uses Redis when REDIS_URL is set (production), falls back to in-memory
    # for local dev. The limiter is applied selectively on sensitive endpoints.
    _redis_uri = os.environ.get("REDIS_URL") or os.environ.get("REDIS_URI")
    limiter = Limiter(
        key_func=get_remote_address,
        app=app,
        storage_uri=_redis_uri or "memory://",
        default_limits=[],          # no global limit — apply per-route only
        headers_enabled=True,       # X-RateLimit-* headers in responses
        swallow_errors=True,        # never crash the app on limiter errors
    )
    app.extensions["limiter"] = limiter

    try:
        init_db()
    except Exception as e:
        app.logger.warning("DB init failed: %s", e)

    # Pull CSVs from Dropbox, bootstrap admin user, ensure CSV schemas exist
    initial_sync()
    bootstrap_admin_user()
    try:
        from tools.manuscriptforge.models import bootstrap_schema
        bootstrap_schema()
    except Exception as e:
        app.logger.warning("CSV schema bootstrap failed: %s", e)

    try:
        from tools.methods.models import bootstrap_methods_schema
        bootstrap_methods_schema()
    except Exception as e:
        app.logger.warning("Methods schema bootstrap failed: %s", e)

    try:
        from tools.export.models import bootstrap_export_schema
        bootstrap_export_schema()
    except Exception as e:
        app.logger.warning("Export schema bootstrap failed: %s", e)

    try:
        from tools.introduction.models import bootstrap_introduction_schema
        bootstrap_introduction_schema()
    except Exception as e:
        app.logger.warning("Introduction schema bootstrap failed: %s", e)

    try:
        from tools.research.models import bootstrap_research_schema
        bootstrap_research_schema()
    except Exception as e:
        app.logger.warning("Research schema bootstrap failed: %s", e)

    try:
        from tools.userprofile.models import bootstrap_lab_schema
        bootstrap_lab_schema()
    except Exception as e:
        app.logger.warning("Lab schema bootstrap failed: %s", e)

    try:
        from core.users import bootstrap_demo_users
        bootstrap_demo_users()
    except Exception as e:
        app.logger.warning("Demo users bootstrap failed: %s", e)

    # Seed the prion-lab team accounts (Jun 2026) with the shared
    # starter password "12345678" + must_change_pw=true so each user
    # picks their own on first login. Idempotent — skips emails
    # already present.
    try:
        from core.users import bootstrap_team_users
        bootstrap_team_users()
    except Exception as e:
        app.logger.warning("Team users bootstrap failed: %s", e)

    # PostgreSQL initialisation — graceful fallback to CSV if unavailable
    _init_postgresql(app)

    # ── Babel / i18n ────────────────────────────────────────────────────────

    def get_locale() -> str:
        lang = session.get("language")
        if lang in config.LANGUAGES:
            return lang
        lang = request.cookies.get("prionlab_lang")
        if lang in config.LANGUAGES:
            return lang
        return config.DEFAULT_LANGUAGE

    Babel(app, locale_selector=get_locale)

    # ── Security headers ─────────────────────────────────────────────────────
    @app.after_request
    def set_security_headers(response):
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
        # CSP: allow same-origin resources + CDNs already used in templates.
        # 'unsafe-inline' is needed for inline styles/scripts present throughout
        # the templates; tighten further when templates are refactored.
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com https://cdn.jsdelivr.net; "
            "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; "
            "img-src 'self' data: https:; "
            "connect-src 'self'; "
            "frame-ancestors 'self';"
        )
        return response

    @app.before_request
    def force_password_change():
        """When a user logs in with the starter password and hasn't
        chosen their own yet (session['must_change_pw'] is True),
        every request gets redirected to /change-password — except
        the change-password endpoint itself, the logout link, and
        static assets. Without this, a savvy user could click around
        the navbar while still authenticated with the shared
        starter credential."""
        if not session.get("must_change_pw"):
            return None
        endpoint = (request.endpoint or "")
        # Whitelist of endpoints / path prefixes the user MUST be able
        # to reach even when their password change is pending.
        if endpoint in ("auth.change_password", "auth.logout", "static"):
            return None
        if request.path.startswith("/static/"):
            return None
        # AJAX / fetch calls (e.g. JS-driven endpoints) get a 403
        # with a hint instead of a redirect, so a stray /api/* call
        # while still on the change-password page doesn't trip a
        # confusing JSON-shaped login redirect chain.
        if request.path.startswith("/api/") \
           or request.path.startswith("/prionvault/api/") \
           or request.path.startswith("/prionpacks/api/"):
            from flask import jsonify
            return jsonify({"error": "password_change_required",
                            "redirect": url_for("auth.change_password")}), 403
        return redirect(url_for("auth.change_password"))

    @app.before_request
    def handle_lang_param():
        lang = request.args.get("lang")
        if lang in config.LANGUAGES:
            args = request.args.to_dict()
            del args["lang"]
            qs = ("?" + urlencode(args)) if args else ""
            resp = redirect(request.path + qs)
            resp.set_cookie("prionlab_lang", lang, max_age=365 * 24 * 3600, samesite="Lax")
            if session.get("logged_in"):
                session["language"] = lang
            return resp

    @app.context_processor
    def inject_globals():
        def lang_url(lang: str) -> str:
            args = request.args.to_dict()
            args["lang"] = lang
            return request.path + "?" + urlencode(args)

        return {
            "version": config.APP_VERSION,
            "contact": config.CONTACT_EMAIL,
            "current_locale": get_locale(),
            "lang_url": lang_url,
        }

    # ── Blueprints ───────────────────────────────────────────────────────────

    app.register_blueprint(auth_bp)
    # Limit login attempts: 10 per minute + 50 per hour per IP.
    # Slows credential-stuffing without blocking legitimate typos.
    from core.auth import login as _login_view
    limiter.limit("10 per minute; 50 per hour")(_login_view)

    from tools.admin import admin_bp
    app.register_blueprint(admin_bp)

    from tools.manuscriptforge import manuscriptforge_bp
    app.register_blueprint(manuscriptforge_bp)

    from tools.methods import methods_bp
    app.register_blueprint(methods_bp)

    from tools.export import export_bp
    app.register_blueprint(export_bp)

    from tools.introduction import introduction_bp
    app.register_blueprint(introduction_bp)

    from tools.research import research_bp
    app.register_blueprint(research_bp)

    from tools.userprofile import userprofile_bp
    app.register_blueprint(userprofile_bp)

    from tools.ai_assistant import ai_bp
    app.register_blueprint(ai_bp)

    from tools.external_apis import external_api_bp
    app.register_blueprint(external_api_bp)

    from tools.lab_integration import lab_integration_bp
    app.register_blueprint(lab_integration_bp)

    from tools.manuscript_dashboard import manuscript_dashboard_bp
    app.register_blueprint(manuscript_dashboard_bp)

    from tools.references import references_bp
    app.register_blueprint(references_bp)

    from tools.analytics import analytics_bp
    app.register_blueprint(analytics_bp)

    from tools.help import help_bp
    app.register_blueprint(help_bp)

    from tools.data_management import data_mgmt_bp
    app.register_blueprint(data_mgmt_bp)

    from tools.spanish_academic import spanish_academic_bp
    app.register_blueprint(spanish_academic_bp)

    from tools.prionpacks import prionpacks_bp
    app.register_blueprint(prionpacks_bp)

    from tools.prionread import prionread_bp
    app.register_blueprint(prionread_bp)

    # PrionVault — opt-out kill switch.
    # Set DISABLE_PRIONVAULT=1 in Railway env vars to skip every
    # PrionVault-related import / registration / migration. Use as a
    # safety valve if the new module ever causes deploy issues; the
    # rest of the Flask app keeps working exactly like before.
    if os.environ.get('DISABLE_PRIONVAULT', '').strip() not in ('', '0', 'false', 'False'):
        app.logger.warning('PrionVault disabled via DISABLE_PRIONVAULT env var.')
    else:
        # Registered defensively. Any import / blueprint error is logged
        # but never aborts boot, so a bug in PrionVault never takes
        # PrionRead or PrionPacks down.
        try:
            from tools.prionvault import prionvault_bp
            app.register_blueprint(prionvault_bp)
            # Limit external-lookup endpoints: they hit PubMed/CrossRef APIs
            # and are expensive. 60/min per IP is generous for normal use.
            from tools.prionvault.routes import api_article_lookup, api_articles_lookup_bulk
            limiter.limit("60 per minute")(api_article_lookup)
            limiter.limit("30 per minute")(api_articles_lookup_bulk)
        except Exception as e:
            app.logger.error('PrionVault blueprint registration failed: %s', e, exc_info=True)

        # Schedule PrionVault DB migrations in a background daemon thread.
        # MUST be non-blocking — Railway's healthcheck has a 30 s timeout
        # and gunicorn cannot answer /health if we sit here applying SQL.
        # Errors inside the thread are logged but never crash the app.
        try:
            from tools.prionvault.migrate import (
                schedule_pending_migrations, start_periodic_self_heal,
            )
            schedule_pending_migrations(app)
            # Run an idempotent schema-repair sweep every 5 min so any
            # Railway / Postgres restore that drops a column gets
            # auto-cured within minutes instead of taking the
            # catalogue down until the next deploy.
            start_periodic_self_heal(interval_seconds=300)
        except Exception as e:
            app.logger.warning('PrionVault migration scheduler failed: %s', e)

        # Start the ingest worker (also a daemon thread, also non-blocking).
        # Set PRIONVAULT_WORKER_DISABLED=1 to opt out (e.g. on a worker-only
        # deployment where the web instance shouldn't process jobs).
        try:
            from tools.prionvault.ingestion.worker import start_worker
            start_worker()
        except Exception as e:
            app.logger.warning('PrionVault ingest worker failed to start: %s', e)

        # Auto-scan-folder daemon: every 6 h (configurable) checks the
        # Dropbox watch folder for new PDFs and pushes them into the
        # ingest queue. Multi-worker safe via a DB lease (see
        # prionvault_scheduled_runs / migration 025). Set
        # PRIONVAULT_AUTO_SCAN_DISABLED=1 to opt out.
        try:
            from tools.prionvault.services.auto_scan import start_auto_scan
            start_auto_scan()
        except Exception as e:
            app.logger.warning('PrionVault auto-scan daemon failed to start: %s', e)

        # PubMed inventory daemon: refreshes the catalogue-vs-PubMed
        # delta every 7 days (and on demand via the modal's "Refrescar"
        # button). Same lease pattern as auto-scan. Opt out with
        # PRIONVAULT_PUBMED_INVENTORY_DISABLED=1.
        try:
            from tools.prionvault.services.pubmed_inventory import start_inventory_daemon
            start_inventory_daemon()
        except Exception as e:
            app.logger.warning('PubMed inventory daemon failed to start: %s', e)

        # OA-PDF auto-fetcher: wakes on a 60-second poll AND on demand
        # whenever the inventory import endpoint creates new rows, so
        # PDFs trickle in seconds after the metadata. Disable with
        # PRIONVAULT_OA_FETCHER_DISABLED=1.
        try:
            from tools.prionvault.services.oa_pdf_fetcher import start_oa_fetcher_daemon
            start_oa_fetcher_daemon()
        except Exception as e:
            app.logger.warning('OA-PDF fetcher daemon failed to start: %s', e)

        # Email-to-PrionVault ingest: polls a dedicated IMAP mailbox
        # every PRIONVAULT_EMAIL_INGEST_POLL_SECONDS (default 180 s)
        # and feeds attached PDFs into the ingest queue. No-op until
        # the operator sets PRIONVAULT_EMAIL_INGEST_{HOST,USER,PASS,
        # ALLOW}; disable with PRIONVAULT_EMAIL_INGEST_DISABLED=1.
        try:
            from tools.prionvault.services.email_ingest import start_email_ingest_daemon
            start_email_ingest_daemon()
        except Exception as e:
            app.logger.warning('PrionVault email-ingest daemon failed to start: %s', e)

        # Pre-populate the biomedical query-expansion dictionary so a
        # freshly-deployed instance immediately benefits from the
        # acronym + synonym seed. Idempotent via ON CONFLICT DO NOTHING
        # in the SQL, so it's safe to re-run on every boot. Admin
        # edits ('source' = 'admin') are preserved.
        # One-shot: copy global article marks (is_flagged /
        # is_milestone / color_label / priority) onto the first
        # admin's prionvault_user_state row, so the migration from
        # global to per-user marks doesn't lose any prior work.
        # Idempotent via a control row in prionvault_scheduled_runs.
        try:
            from tools.prionvault.services.marks_backfill import backfill_once
            summary = backfill_once()
            if summary.get("copied"):
                app.logger.info(
                    "PrionVault marks backfill: copied=%d → user_id=%s",
                    summary["copied"], summary.get("user_id"))
            elif summary.get("error"):
                app.logger.warning(
                    "PrionVault marks backfill error: %s", summary["error"])
        except Exception as e:
            app.logger.warning(
                "PrionVault marks backfill skipped: %s", e)

        try:
            from tools.prionvault.services.query_expansion import ensure_seeded
            inserted, refreshed = ensure_seeded()
            if inserted or refreshed:
                app.logger.info(
                    'PrionVault query_expansion seed: '
                    'inserted=%d, refreshed=%d',
                    inserted, refreshed)
        except Exception as e:
            app.logger.warning(
                'PrionVault query_expansion seed failed: %s', e)

    try:
        from tools.prionpacks.models import bootstrap_demo_data
        bootstrap_demo_data()
    except Exception as e:
        app.logger.warning('PrionPacks demo seed failed: %s', e)

    try:
        from tools.prionpacks.members import bootstrap_demo_data as bootstrap_members
        bootstrap_members()
    except Exception as e:
        app.logger.warning('PrionPacks members seed failed: %s', e)

    try:
        import database.help_system  # noqa: F401 — registers models with Base.metadata
        from database.config import db as _db
        if _db.is_configured():
            _db.create_all_tables()
    except Exception as e:
        app.logger.debug("Help system DB tables skipped: %s", e)

    # Start background scheduler (cleanup + cloud backup placeholder)
    try:
        from tools.export.models import init_scheduler
        import os as _os
        # Only start in main process (avoid double-start under Werkzeug reloader)
        if not app.debug or _os.environ.get("WERKZEUG_RUN_MAIN") == "true":
            init_scheduler(app)
    except Exception as e:
        app.logger.warning("Scheduler init failed: %s", e)

    # Database maintenance scheduler (no-op when DATABASE_URL not set)
    try:
        import os as _os
        if not app.debug or _os.environ.get("WERKZEUG_RUN_MAIN") == "true":
            _start_maintenance_scheduler(app)
    except Exception as e:
        app.logger.warning("Maintenance scheduler init failed: %s", e)

    # PrionPacks Dropbox backup scheduler
    try:
        import os as _os
        if not app.debug or _os.environ.get("WERKZEUG_RUN_MAIN") == "true":
            _start_prionpacks_backup_scheduler(app)
    except Exception as e:
        app.logger.warning("PrionPacks backup scheduler init failed: %s", e)

    # Background job manager for external API enrichment
    try:
        import atexit as _atexit
        from tools.external_apis.background_jobs import start_background_jobs, stop_background_jobs
        start_background_jobs()
        _atexit.register(stop_background_jobs)
    except Exception as e:
        app.logger.warning("Background job manager init failed: %s", e)

    # ── Template context: expose feature flags so navbar / footer can
    # conditionally render links without raising BuildError when a module
    # is disabled or its blueprint failed to register.
    @app.context_processor
    def _inject_app_features():
        return {
            "has_prionvault": "prionvault.index" in app.view_functions,
            "has_prionread":  "prionread.index"  in app.view_functions,
            "has_prionpacks": "prionpacks.index" in app.view_functions,
        }

    # ── Asset cache-busting ──────────────────────────────────────────
    # Templates can call asset_url('js/prionvault.js') instead of
    # url_for('static', filename='js/prionvault.js') to get a URL with
    # ?v=<mtime> appended. The mtime changes every time we touch the
    # file (i.e. every deploy), so browsers will fetch the fresh copy
    # automatically — no more "I deployed the fix but the user still
    # sees the old JS". On Railway the static folder is read-only so
    # mtime is stable after deploy; cache hits behave normally between
    # deploys. The first call per file computes the mtime; we cache
    # the answer in a process-local dict so we're not stat()'ing on
    # every request.
    import os as _os
    _asset_v_cache: dict[str, str] = {}
    _static_root = _os.path.join(app.root_path, "static")

    def asset_url(relative_path: str) -> str:
        v = _asset_v_cache.get(relative_path)
        if v is None:
            try:
                v = str(int(_os.path.getmtime(
                    _os.path.join(_static_root, relative_path))))
            except OSError:
                v = "0"
            _asset_v_cache[relative_path] = v
        from flask import url_for
        return f"{url_for('static', filename=relative_path)}?v={v}"

    app.jinja_env.globals["asset_url"] = asset_url

    # ── Browser-side Sentry: every base.html-rendered page picks these
    # up and (when the DSN is set) loads the SDK so JS errors and
    # unhandled promise rejections in the static admin pages flow
    # to the same Sentry project as the Flask server, tagged
    # `service: prionvault-browser` to keep them separable.
    @app.context_processor
    def _inject_sentry_browser():
        # The DSN is a public key — safe to expose to the browser.
        # Reusing SENTRY_DSN here keeps Railway config to one knob;
        # tags distinguish the two services in Sentry's UI.
        return {
            "sentry_dsn_browser": os.environ.get("SENTRY_DSN") or "",
            "sentry_env":         os.environ.get("SENTRY_ENVIRONMENT", "production"),
            "commit_sha":         os.environ.get("RAILWAY_GIT_COMMIT_SHA") or "",
        }

    # ── Routes ───────────────────────────────────────────────────────────────

    @app.route("/")
    @login_required
    def home():
        return render_template("home.html")

    @app.route("/lab/integration")
    @login_required
    def lab_integration_page():
        return render_template(
            "lab_integration/lab_import.html",
            is_admin=(session.get("role") == "admin"),
        )

    @app.route("/manuscripts/dashboard")
    @login_required
    def manuscript_dashboard_page():
        return render_template("dashboard/main.html")

    @app.route("/manuscripts/<manuscript_id>")
    @login_required
    def manuscript_detail_page(manuscript_id):
        return render_template("manuscripts/detail.html", manuscript_id=manuscript_id)

    @app.route("/manuscripts/<manuscript_id>/edit")
    @login_required
    def manuscript_edit_page(manuscript_id):
        return render_template("manuscripts/edit.html", manuscript_id=manuscript_id)

    @app.route("/manuscripts/<manuscript_id>/references")
    @login_required
    def manuscript_references_page(manuscript_id):
        return render_template("references/manage.html", manuscript_id=manuscript_id)

    @app.route("/manuscripts/<manuscript_id>/references/intelligence")
    @login_required
    def manuscript_intelligence_page(manuscript_id):
        return render_template("references/intelligence.html", manuscript_id=manuscript_id)

    @app.route("/manuscripts/<manuscript_id>/references/network-dashboard")
    @login_required
    def manuscript_network_dashboard(manuscript_id):
        return render_template("references/network_dashboard.html", manuscript_id=manuscript_id)

    @app.route("/analytics")
    @login_required
    def analytics_page():
        return render_template("analytics/dashboard.html")

    @app.route("/analytics/settings")
    @login_required
    def analytics_settings_page():
        return render_template("analytics/settings.html")

    @app.route("/health")
    def health():
        # Railway sets RAILWAY_GIT_COMMIT_SHA at build time; surfacing it
        # here lets us compare the running deploy against the latest
        # commit on main without opening the Railway dashboard. Handy
        # for "did my fix ship?" questions during incident response.
        sha = os.environ.get("RAILWAY_GIT_COMMIT_SHA") or os.environ.get("GIT_COMMIT_SHA")
        return jsonify({
            "status":     "ok",
            "dropbox":    config.dropbox_configured(),
            "smtp":       config.smtp_configured(),
            "commit_sha": sha,
            "commit_short": (sha[:7] if sha else None),
        })

    @app.errorhandler(404)
    def not_found(e):
        return render_template("errors/404.html"), 404

    @app.errorhandler(500)
    def server_error(e):
        return render_template("errors/500.html"), 500

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
