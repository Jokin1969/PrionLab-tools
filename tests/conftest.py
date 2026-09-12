"""Shared test setup.

Tests under this folder are deliberately unit-level: they exercise
pure functions whose behaviour was reproduced as a regression on
the live deployment during this session. Anything that needs a
real Postgres or an external API key lives in tests/integration/
(not present yet) — out of scope for now.

The repo root is added to sys.path so `from tools…` imports work
without an editable install.
"""
import os
import sys

# Insert the repo root in sys.path so the tools/ package is importable.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
