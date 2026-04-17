import os
import logging
import logging.handlers
from flask import Flask, render_template, jsonify

import config
from core.db import init_db
from core.auth import auth_bp
from core.decorators import login_required
from core.sync import initial_sync

def _ensure_data_dirs():
    for d in [config.CSV_DIR, config.CACHE_DIR, config.LOGS_DIR]:
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

    initial_sync()

    app.register_blueprint(auth_bp)

    @app.route("/")
    @login_required
    def home():
        return render_template("home.html", version=config.APP_VERSION, contact=config.CONTACT_EMAIL)

    @app.route("/health")
    def health():
        return jsonify({
            "status": "ok",
            "dropbox": config.dropbox_configured(),
            "smtp": config.smtp_configured(),
        })

    @app.route("/tools/manuscriptforge/")
    @login_required
    def manuscriptforge_placeholder():
        return render_template("tools_coming_soon.html", tool_name="ManuscriptForge")

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
