# PrionLab Tools

Internal web application for the prion research group. A modular platform where each research tool lives as a Flask blueprint, sharing a common chassis (auth, Dropbox sync, SQLite, SMTP).

## Tools

| Tool | Status | Path |
|------|--------|------|
| ManuscriptForge | Coming soon | `/tools/manuscriptforge/` |

---

## Environment variables

Copy `.env.example` to `.env` and fill in the values. In Railway, set these as environment variables in the service settings.

| Variable | Description |
|---|---|
| `ADMIN_PASSWORD` | Single password for the admin login. Changing it invalidates all existing sessions. |
| `CONTACT_EMAIL` | Admin email address (Jokin). Used as the `From:` address for outgoing emails. |
| `DROPBOX_APP_KEY` | OAuth2 App Key from the Dropbox developer console. |
| `DROPBOX_APP_SECRET` | OAuth2 App Secret from the Dropbox developer console. |
| `DROPBOX_REFRESH_TOKEN` | Long-lived OAuth2 refresh token. The app exchanges it automatically for short-lived access tokens. |
| `SMTP_HOST` | SMTP server hostname (e.g. `smtp.gmail.com`). |
| `SMTP_PORT` | SMTP port (e.g. `587` for STARTTLS, `465` for SSL). |
| `SMTP_USER` | SMTP login username. |
| `SMTP_PASS` | SMTP login password or app password. |
| `SMTP_SECURE` | Connection security: `tls` (STARTTLS), `ssl` (SMTP_SSL), or `none`. |

If Dropbox or SMTP variables are missing, the app starts normally and logs a warning — it does not crash.

---

## Deploying to Railway

1. Connect the GitHub repo `Jokin1969/PrionLab-tools` to a Railway project.
2. Add a **Volume** in Railway and set the mount path to `/data`.
3. Set all environment variables listed above in the Railway service settings.
4. Railway will build automatically via Nixpacks and run `gunicorn` via the `Procfile`.
5. The `/health` endpoint is configured as the healthcheck path in `railway.json`.

No additional manual steps are required.

---

## Adding a new tool

1. Create a new directory under `tools/`, e.g. `tools/mytool/`.
2. Add an `__init__.py` with a Flask `Blueprint` named `mytool_bp` and register its routes.
3. Import and register the blueprint in `app.py`:
   ```python
   from tools.mytool import mytool_bp
   app.register_blueprint(mytool_bp, url_prefix="/tools/mytool")
   ```
4. Add a `<a class="tool-card" ...>` entry to `templates/home.html`.
5. Protect all routes with the `@login_required` decorator from `core.decorators`.

---

## Local development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in values
python app.py
```

The app will listen on `http://localhost:5000`. SQLite and CSV data go into `/data/` by default; override with the `DATA_DIR` env var if needed locally.
