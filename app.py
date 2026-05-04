import os
import logging
import logging.handlers
from urllib.parse import urlencode

from flask import Flask, jsonify, redirect, render_template, request, session
from flask_babel import Babel

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


def create_app() -> Flask:
    app = Flask(__name__)
    app.secret_key = config.SECRET_KEY

    _ensure_data_dirs()
    _setup_logging(app)

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
        except Exception as e:
            app.logger.error('PrionVault blueprint registration failed: %s', e, exc_info=True)

        # Schedule PrionVault DB migrations in a background daemon thread.
        # MUST be non-blocking — Railway's healthcheck has a 30 s timeout
        # and gunicorn cannot answer /health if we sit here applying SQL.
        # Errors inside the thread are logged but never crash the app.
        try:
            from tools.prionvault.migrate import schedule_pending_migrations
            schedule_pending_migrations(app)
        except Exception as e:
            app.logger.warning('PrionVault migration scheduler failed: %s', e)

    try:
        from tools.prionpacks.models import bootstrap_demo_data
        bootstrap_demo_data()
    except Exception as e:
        app.logger.warning('PrionPacks demo seed failed: %s', e)

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

    # Background job manager for external API enrichment
    try:
        import atexit as _atexit
        from tools.external_apis.background_jobs import start_background_jobs, stop_background_jobs
        start_background_jobs()
        _atexit.register(stop_background_jobs)
    except Exception as e:
        app.logger.warning("Background job manager init failed: %s", e)

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
        return jsonify({
            "status": "ok",
            "dropbox": config.dropbox_configured(),
            "smtp": config.smtp_configured(),
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
