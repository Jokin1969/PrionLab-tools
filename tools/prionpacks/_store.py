"""Safe JSON-file store shared by the PrionPacks models.

Two gunicorn workers write the same file, so every read-modify-write runs
under an exclusive file lock, writes go through a unique temp file, and a
file that exists but cannot be read RAISES instead of pretending to be empty
(which used to let the next save overwrite every pack).
"""
import functools
import json
import os
import tempfile
import threading

try:
    import fcntl
except ImportError:          # non-POSIX dev machines
    fcntl = None

_thread_lock = threading.RLock()


def load_json(path: str) -> list:
    if not os.path.exists(path):
        return []
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f'{os.path.basename(path)}: unexpected content')
    return data


def save_json(path: str, data: list) -> None:
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix='.' + os.path.basename(path) + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def locked(path_getter):
    """Decorator: run the function holding the store's exclusive lock."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            path = path_getter()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with _thread_lock:
                if fcntl is None:
                    return fn(*a, **kw)
                with open(path + '.lock', 'a') as lf:
                    fcntl.flock(lf, fcntl.LOCK_EX)
                    try:
                        return fn(*a, **kw)
                    finally:
                        fcntl.flock(lf, fcntl.LOCK_UN)
        return wrapper
    return deco
