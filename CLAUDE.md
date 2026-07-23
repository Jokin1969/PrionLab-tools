# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run tests
pytest

# Run a single test file
pytest tests/test_tag_permissions.py -v

# Run the app in dev mode
python app.py

# Apply DB migrations (run missing ones in order)
python -c "from database.config import db; db.run_migrations()"
```

## Architecture

**Flask app factory** (`app.py`): `create_app()` registers all blueprints, sets up JSON structured logging (`_JsonFormatter`), and starts APScheduler background jobs with `misfire_grace_time`.

**Auth** (`core/`):
- Session-based: `session["logged_in"]`, `session["role"]` (`"admin"` or `"reader"`), `session["user_id"]`
- Decorators in `core/decorators.py`: `@login_required` redirects to `url_for("auth.login")`; `@admin_required` redirects authenticated non-admins to `url_for("home")`
- Two roles: `admin` (full access) and `reader` (PrionVault read + own tags only)

**Database** (`database/config.py`): SQLAlchemy with raw SQL via `db.Session()`. Not ORM — always call `s = db.Session(); s.execute(sql_text(...)); s.close()`. Migrations are numbered SQL files in `migrations/`.

**PrionVault** (`tools/prionvault/`): Largest tool. Blueprint defined in `__init__.py` as `prionvault_bp`. Routes split across modules:
- `routes.py` — core routes (listing, search, tags, annotations, collections, metadata lookup, PDF ops)
- `routes_admin.py` — `@admin_required` batch operations (side-effect imported at bottom of `routes.py`)
- `routes_notes.py` — per-user sticky notes CRUD (up to 5 per article; colour auto-assigned)
- `routes_notifications.py` — email subscription CRUD (same side-effect import pattern)
- `_helpers.py` — shared request-scoped helpers: `_viewer_role()`, `_viewer_id()`, `_session()`, `_ensure_can_modify()`
- `services/` — email_digest, ai_summary, batch_summary, rag, pubmed_inventory, pack_suggest, article_notes
- `ingestion/` — PDF queue, worker, deduplicator, dropbox_uploader, pdf_extractor

Sub-module imports pattern (avoids circular imports): sub-modules import `prionvault_bp` from the parent package (`from tools.prionvault import prionvault_bp`), then `routes.py` imports sub-modules at the bottom as side-effects.

**Frontend**:
- `IS_ADMIN` constant injected via `<meta name="user-is-admin">` tag; JS reads it at page load
- Reader UI: non-linked logo span, PrionVault nav link, direct logout button; admin-only UI hidden via `.pv-admin-only` CSS class
- `static/js/prionvault.js` — main PrionVault frontend (large; tag pickers open to all roles)

**Article Listing Features**:
- **Sticky Notes** (`prionvault_article_note` table): Per-user, up to 5 per article. Colour auto-assigned (0=amarilla/yellow, 1=azul/blue, 2=verde/green, 3=morada/purple, 4=naranja/orange). Notes cluster shown in listing rows and detail modal nav bar. Routes: `GET/POST /api/articles/<id>/notes`, `PATCH/DELETE /api/notes/<id>`.
- **Article Isolation**: Filter listing to show only a single article via `📍` button in listing or detail modal. State tracked in `state.isolatedArticleId`; `buildListParams()` filters by ID when set. Visual indicator shows when isolation active with clear button.
- **Notes Counter** (left sidebar "📝 Con notas"): Counts articles with sticky notes for current user (not human summaries). Backend counts rows in `prionvault_article_note WHERE user_id = :viewer_id`; filter parameter `has_summary=human` queries sticky notes table.

**Tests** (`tests/`): Use `pytest.importorskip()` for graceful CI skips. Admin/reader permission tests use a mini-Flask-app pattern — create a minimal app, register the blueprint, add a stub `home` endpoint (needed because `admin_required` redirects to `url_for("home")`), then call test client routes. No real DB needed for permission tests.

**Scheduling**: `APScheduler BackgroundScheduler` with `misfire_grace_time` set per scheduler (`app.py`, `database/maintenance.py`, `tools/export/models.py`).

**Dropbox integration** (`core/dropbox_client.py`): timeout + size cap enforced in `services/email_digest.py` (`_PDF_ATTACH_MAX_BYTES=25MB`, `_PDF_ATTACH_TIMEOUT=30s`).

## Key conventions

- `_ensure_can_modify(table, owner_col, row_id)` — returns `(response, status)` tuple or `None` to proceed; admins always pass
- Reader-only collections: readers can view and filter but cannot create/edit/delete collections or modify membership
- Readers can create their own tags and associate them with articles; tag write routes check ownership via `_ensure_can_modify`
- Sticky notes are per-user and per-article (up to 5); use `_noteClusterInner(notes)` + `_wireNoteCluster(container, article)` in JS to render/wire. Notes are fetched separately via `/api/articles/<id>/notes` in detail modal since not included in main article endpoint.
- Article isolation: use `_setIsolatedArticleId(aid)` to isolate, `_clearArticleIsolation()` to clear. Frontend reflects state via `state.isolatedArticleId` and shows/hides isolation indicator badge. Indicator has click listener wired in `init()`.
- SQL strings use `sql_text()` from SQLAlchemy with named `:param` placeholders — never f-string interpolation for values
