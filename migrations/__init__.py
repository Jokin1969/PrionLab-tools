"""Database & content migration scripts.

The SQL files (`001_*.sql`) are auto-applied at app boot via
`tools.prionvault.migrate.run_pending_migrations`.

Python modules in this folder are one-off migrations that move data
between systems (e.g. relocating PDFs in Dropbox). They are exposed as
admin endpoints under /prionvault/api/admin/migrate-* and can also be
run from the CLI: `python -m migrations.002_relocate_prionread_pdfs`.
"""
