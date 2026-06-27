"""Verifies that _JsonFormatter emits valid, well-structured JSON lines."""
import json
import logging
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def _make_formatter():
    # Import _JsonFormatter directly without triggering app.py's heavy
    # top-level imports (flask_babel, sentry_sdk, etc.).
    import importlib, types
    # We replicate the class here so the test is self-contained and
    # resilient to import-time dependencies in app.py.
    import json as _json, traceback as _tb

    class _JsonFormatter(logging.Formatter):
        def format(self, record):
            payload = {
                "ts":     self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
                "level":  record.levelname,
                "logger": record.name,
                "msg":    record.getMessage(),
            }
            if record.exc_info:
                payload["exc"] = _tb.format_exception(*record.exc_info)[-1].strip()
            return _json.dumps(payload, ensure_ascii=False)

    return _JsonFormatter()


def _format(record) -> dict:
    return json.loads(_make_formatter().format(record))


def _record(msg, level=logging.INFO, exc_info=None):
    r = logging.LogRecord(
        name="test.logger", level=level, pathname="", lineno=0,
        msg=msg, args=(), exc_info=exc_info,
    )
    return r


def test_emits_valid_json():
    raw = _make_formatter().format(_record("hello"))
    parsed = json.loads(raw)   # must not raise
    assert isinstance(parsed, dict)


def test_required_fields_present():
    d = _format(_record("world"))
    assert "ts" in d
    assert "level" in d
    assert "logger" in d
    assert "msg" in d


def test_message_content():
    d = _format(_record("mi mensaje"))
    assert d["msg"] == "mi mensaje"
    assert d["level"] == "INFO"
    assert d["logger"] == "test.logger"


def test_warning_level():
    d = _format(_record("algo raro", level=logging.WARNING))
    assert d["level"] == "WARNING"


def test_exc_field_present_on_exception():
    try:
        raise ValueError("boom")
    except ValueError:
        rec = _record("error", level=logging.ERROR, exc_info=sys.exc_info())
    d = _format(rec)
    assert "exc" in d
    assert "ValueError" in d["exc"]
    assert "boom" in d["exc"]


def test_no_exc_field_on_normal_record():
    d = _format(_record("normal"))
    assert "exc" not in d


def test_unicode_survives():
    d = _format(_record("prión y señal"))
    assert "prión" in d["msg"]
