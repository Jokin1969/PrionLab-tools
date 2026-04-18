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

    # Start background scheduler (cleanup + cloud backup placeholder)
    try:
        from tools.export.models import init_scheduler
        import os as _os
        # Only start in main process (avoid double-start under Werkzeug reloader)
        if not app.debug or _os.environ.get("WERKZEUG_RUN_MAIN") == "true":
            init_scheduler(app)
    except Exception as e:
        app.logger.warning("Scheduler init failed: %s", e)

    # ── Routes ───────────────────────────────────────────────────────────────

    @app.route("/")
    @login_required
    def home():
        return render_template("home.html")

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
