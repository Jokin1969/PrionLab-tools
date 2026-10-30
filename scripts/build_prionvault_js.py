#!/usr/bin/env python3
"""Build static/js/prionvault.js from its source parts.

PrionVault's frontend is one big IIFE, so the parts in
static/js/prionvault/NN_*.js are FRAGMENTS of a single script (not
standalone modules): edit them, then run

    python scripts/build_prionvault_js.py

which concatenates them in filename order into static/js/prionvault.js
(the file the page loads). `--check` exits 1 if the built file is stale;
tests/test_prionvault_js_build.py runs that check in CI.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS_DIR = ROOT / "static" / "js" / "prionvault"
OUT = ROOT / "static" / "js" / "prionvault.js"


def build() -> str:
    parts = sorted(PARTS_DIR.glob("[0-9][0-9]_*.js"))
    if not parts:
        raise SystemExit(f"no parts in {PARTS_DIR}")
    return "".join(p.read_text(encoding="utf-8") for p in parts)


def main() -> int:
    content = build()
    if "--check" in sys.argv:
        if OUT.read_text(encoding="utf-8") != content:
            print("static/js/prionvault.js is out of date — run scripts/build_prionvault_js.py")
            return 1
        return 0
    OUT.write_text(content, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({content.count(chr(10))} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
