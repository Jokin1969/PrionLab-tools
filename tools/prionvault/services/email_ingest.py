"""Email → PrionVault ingest.

Polls dedicated IMAP mailboxes at a fixed interval, finds unread
messages from approved senders that carry a PDF attachment, and feeds
each PDF into the existing ingest queue (the same path Add-by-DOI,
Import-PDFs and Scan-Dropbox-folder use). When the ingest finishes,
the sender gets an SMTP reply with the outcome — title, DOI/PMID when
CrossRef/PubMed resolved, and a deep link to the article in
PrionVault.

Two independent mailboxes ("profiles"), each with its own IMAP
credentials, sender-validation strategy and reply behaviour:

  * "admin" — the original mailbox (prionvault@...), used by the
    operator. Senders are checked against a fixed allowlist
    (PRIONVAULT_EMAIL_INGEST_ALLOW). No BCC.
  * "lab"   — a second mailbox (e.g. prionvault_lab@...) meant for
    non-admin users. There's no static allowlist here: a sender is
    accepted whenever their address matches a REGISTERED PrionLab
    tools user account (any role — see core.users.get_user_by_email),
    so any lab member can use it with the email they already log in
    with. Every reply from this profile is also sent BCC to every
    admin (core.users.list_admin_emails), so the admin can see who
    used it and how each submission resolved — the sender is never
    told they're copied.

Config knobs, PRIONVAULT_EMAIL_INGEST_* for "admin" and
PRIONVAULT_EMAIL_INGEST2_* for "lab" (falls back to the admin
mailbox's HOST/PORT when unset — same mail provider, just a different
mailbox login, is the common case):

  * ..._HOST / ..._PORT / ..._USER / ..._PASS   IMAP credentials.
  * ..._FOLDER / ..._PROCESSED_FOLDER           default INBOX / Processed.
  * ..._POLL_SECONDS                            default 180.
  * ..._DISABLED                                skip this profile.
  * ..._ALLOW      ("admin" only) comma-separated sender allowlist,
    required — without it the admin profile refuses to start.
  * ..._TARGET     optional, either profile. When the mailbox is
    actually an alias forwarded into a shared inbox, set this to the
    *recipient* address you want to act on; messages addressed
    elsewhere are skipped.

Idempotent against the rest of the catalogue because enqueue_pdf
deduplicates by md5 downstream.

Design choices vs alternatives:
  - IMAP polling vs Mailgun/SendGrid inbound webhook: zero third-party
    cost, no extra DNS work, and SMTP+IMAP credentials cover both
    directions of the email loop.
  - Mark-as-seen vs move-to-folder: we move processed messages to a
    "Processed" subfolder when present, otherwise we flag them
    SEEN. Either way they don't get reprocessed on the next tick.
"""
from __future__ import annotations

import email
import email.header
import imaplib
import logging
import os
import re
import ssl
import threading
import time
from email.message import Message
from typing import Iterable, Optional

logger = logging.getLogger(__name__)


_PROFILES = ("admin", "lab")

# Default config (everything overridable via env vars).
_DEFAULT_PORT = 993
_DEFAULT_FOLDER = "INBOX"
_DEFAULT_PROCESSED_FOLDER = "Processed"
_DEFAULT_POLL_SECONDS = 180        # 3 min — Railway-friendly
_MAX_ATTACHMENT_BYTES = 80 * 1024 * 1024   # mirror upload-pdf endpoint cap
_PUBLIC_BASE_URL = os.environ.get(
    "PRIONVAULT_PUBLIC_BASE_URL",
    "https://web-production-5517e.up.railway.app",
)


def _fresh_state() -> dict:
    return {
        "running":           False,
        "last_poll_at":      None,
        "last_poll_status":  None,    # "ok" | "error"
        "last_poll_error":   None,
        "ingested_total":    0,
        "rejected_total":    0,       # sender not allowed, no PDFs, etc.
        "last_email_from":   None,
        "last_email_subject": None,
    }


# Lightweight in-memory state for /status diagnostics, one entry per profile.
_state: dict[str, dict] = {p: _fresh_state() for p in _PROFILES}
_lock = threading.Lock()
_stop:   dict[str, threading.Event] = {p: threading.Event() for p in _PROFILES}
_force:  dict[str, threading.Event] = {p: threading.Event() for p in _PROFILES}
_thread: dict[str, Optional[threading.Thread]] = {p: None for p in _PROFILES}

# Cluster-wide singleton per profile: gunicorn runs the app with
# --workers 2, so without coordination both worker processes would poll
# IMAP at the same interval and each see the same UNSEEN message before
# either marked it SEEN, ending up with two ingest jobs (and two reply
# emails) per incoming PDF. We use a Postgres advisory lock as the
# leader-election primitive — only one worker holds it at a time per
# profile, the other stays idle and takes over if the leader dies. Two
# profiles need two distinct lock keys or they'd contend with each
# other's leadership instead of running independently.
_LEADER_LOCK_KEYS = {
    "admin": 0x7072765F656D6C,   # ASCII "prv_eml" packed as a bigint
    "lab":   0x7072765F6C6162,   # ASCII "prv_lab" packed as a bigint
}
_leader_conn: dict[str, object] = {p: None for p in _PROFILES}


# ── Config ──────────────────────────────────────────────────────────────────

def _config(profile: str = "admin") -> dict:
    prefix = "PRIONVAULT_EMAIL_INGEST" if profile == "admin" else "PRIONVAULT_EMAIL_INGEST2"

    host = os.environ.get(f"{prefix}_HOST", "").strip()
    port = _env_int(f"{prefix}_PORT", _DEFAULT_PORT)
    if profile == "lab" and not host:
        # Fall back to the admin mailbox's IMAP server — same provider,
        # just a different mailbox login is the common setup, so most
        # deployments only need PRIONVAULT_EMAIL_INGEST2_USER/PASS set.
        host = os.environ.get("PRIONVAULT_EMAIL_INGEST_HOST", "").strip()
        port = _env_int("PRIONVAULT_EMAIL_INGEST_PORT", _DEFAULT_PORT)

    cfg = {
        "profile":   profile,
        "disabled":  os.environ.get(f"{prefix}_DISABLED", "").strip()
                       in ("1", "true", "True"),
        "host":      host,
        "port":      port,
        "user":      os.environ.get(f"{prefix}_USER", "").strip(),
        "pwd":       os.environ.get(f"{prefix}_PASS", ""),
        "folder":    os.environ.get(f"{prefix}_FOLDER",
                                    _DEFAULT_FOLDER).strip() or _DEFAULT_FOLDER,
        "processed_folder": os.environ.get(
            f"{prefix}_PROCESSED_FOLDER", _DEFAULT_PROCESSED_FOLDER,
        ).strip() or _DEFAULT_PROCESSED_FOLDER,
        "poll":      _env_int(f"{prefix}_POLL_SECONDS", _DEFAULT_POLL_SECONDS),
        # Optional: only process emails addressed to this recipient.
        # Useful when the mailbox is an alias forwarded into a shared
        # inbox and you want to ignore everything else.
        "target":    os.environ.get(f"{prefix}_TARGET", "")
                       .strip().lower() or None,
    }
    if profile == "admin":
        cfg["allow"] = [s.strip().lower() for s in
                        os.environ.get("PRIONVAULT_EMAIL_INGEST_ALLOW", "").split(",")
                        if s.strip()]
        cfg["sender_check"] = "allowlist"
        cfg["bcc_admins"] = False
    else:
        cfg["allow"] = []
        cfg["sender_check"] = "registered_user"
        cfg["bcc_admins"] = True
    return cfg


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _is_configured(cfg: dict) -> bool:
    """Refuse to start without a complete config — anything missing is
    an operator error, not a runtime bug. The admin profile additionally
    needs its allowlist; the lab profile validates senders dynamically
    against the users table instead, so it has no such requirement."""
    base = bool(cfg["host"] and cfg["user"] and cfg["pwd"])
    if cfg["sender_check"] == "allowlist":
        return base and bool(cfg["allow"])
    return base


def get_status() -> dict:
    """Status for both mailboxes, keyed by profile name."""
    out = {}
    for profile in _PROFILES:
        with _lock:
            snap = dict(_state[profile])
        cfg = _config(profile)
        snap["configured"]  = _is_configured(cfg)
        snap["host"]        = cfg["host"]
        snap["user"]        = cfg["user"]
        snap["folder"]      = cfg["folder"]
        snap["target"]      = cfg["target"]
        snap["sender_check"] = cfg["sender_check"]
        snap["allow"]       = cfg["allow"]
        snap["bcc_admins"]  = cfg["bcc_admins"]
        snap["poll_seconds"] = cfg["poll"]
        snap["is_leader"]   = _leader_conn.get(profile) is not None
        out[profile] = snap
    return out


# ── IMAP helpers ────────────────────────────────────────────────────────────

def _decode_header(value: Optional[str]) -> str:
    if not value:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for chunk, enc in parts:
        if isinstance(chunk, bytes):
            try:
                out.append(chunk.decode(enc or "utf-8", errors="replace"))
            except (LookupError, TypeError):
                out.append(chunk.decode("utf-8", errors="replace"))
        else:
            out.append(chunk)
    return "".join(out).strip()


def _extract_address(header_value: str) -> str:
    """Pull just the email out of a `Name <addr@host>` style header."""
    if not header_value:
        return ""
    m = re.search(r"[\w\.\-+]+@[\w\.\-]+", header_value)
    return (m.group(0) if m else header_value).strip().lower()


def _is_allowed_sender(from_addr: str, allow: Iterable[str]) -> bool:
    """Match against the allowlist. Each allow entry is treated as a
    suffix match so "@cicbiogune.es" allows every address on that
    domain, while "castilla@joaquincastilla.com" matches just that."""
    f = (from_addr or "").lower()
    for a in allow:
        a = (a or "").lower()
        if not a:
            continue
        if a.startswith("@"):
            if f.endswith(a):
                return True
        elif f == a or f.endswith(a):
            return True
    return False


def _is_registered_sender(from_addr: str) -> bool:
    """True when `from_addr` matches a PrionLab tools user account
    (any role) — the "lab" profile's sender check: anyone who already
    has an app login can use their own address, no separate allowlist
    to maintain."""
    if not from_addr:
        return False
    try:
        from core.users import get_user_by_email
        return get_user_by_email(from_addr) is not None
    except Exception:
        logger.exception("email_ingest: registered-user lookup failed for %s", from_addr)
        return False


def _admin_bcc(from_addr: str) -> list[str]:
    """Every active admin's email, minus the sender itself (so an admin
    emailing their own lab-profile address doesn't get a duplicate copy
    via BCC of a reply they're already the primary recipient of)."""
    try:
        from core.users import list_admin_emails
        f = (from_addr or "").lower()
        return [e for e in list_admin_emails() if e.lower() != f]
    except Exception:
        logger.exception("email_ingest: admin BCC lookup failed")
        return []


def _is_addressed_to_target(msg: Message, target: Optional[str]) -> bool:
    if not target:
        return True
    needles = []
    for hdr in ("To", "Cc", "Bcc", "Delivered-To"):
        v = _decode_header(msg.get(hdr) or "")
        if v:
            needles.append(v.lower())
    return any(target in n for n in needles)


def _pdf_parts(msg: Message) -> list[tuple[str, bytes]]:
    """Yield (filename, bytes) for every PDF attachment in `msg`."""
    out: list[tuple[str, bytes]] = []
    if msg.is_multipart():
        for part in msg.walk():
            disp = (part.get("Content-Disposition") or "").lower()
            ctype = (part.get_content_type() or "").lower()
            is_attachment = "attachment" in disp or "filename" in disp
            looks_pdf = ctype == "application/pdf" or \
                        (part.get_filename() or "").lower().endswith(".pdf")
            if not (is_attachment and looks_pdf):
                continue
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            if len(payload) > _MAX_ATTACHMENT_BYTES:
                logger.warning(
                    "email_ingest: skipping attachment >%dMB (%s)",
                    _MAX_ATTACHMENT_BYTES // (1024 * 1024),
                    part.get_filename(),
                )
                continue
            fname = _decode_header(part.get_filename() or "attachment.pdf")
            out.append((fname, payload))
    return out


# ── Pipeline glue ───────────────────────────────────────────────────────────

def _enqueue(content: bytes, filename: str, *,
             notify_email: Optional[str] = None,
             notify_subject: Optional[str] = None,
             notify_bcc: Optional[str] = None) -> Optional[int]:
    """Hand a PDF to the existing ingest queue, recording the email
    address to notify when the job finishes. Returns job id or None."""
    try:
        from ..ingestion import queue as ingest_queue
        return ingest_queue.enqueue_pdf(
            content=content, filename=filename, user_id=None,
            notify_email=notify_email,
            notify_subject=notify_subject,
            notify_bcc=notify_bcc,
        )
    except Exception as exc:
        logger.exception("email_ingest: enqueue_pdf failed for %s (%s)",
                         filename, exc)
        return None


def _reply(to_addr: str, *, subject: str, body: str,
           bcc: Optional[list[str]] = None) -> None:
    """Best-effort SMTP reply. Uses the same core.smtp_client the rest
    of the app already wires up."""
    try:
        from core.smtp_client import send_email
        send_email(to_addr, subject, body, bcc=bcc)
    except Exception as exc:
        logger.warning("email_ingest: reply to %s failed (%s)", to_addr, exc)


# ── IMAP poll ───────────────────────────────────────────────────────────────

def _connect(cfg: dict) -> imaplib.IMAP4_SSL:
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(cfg["host"], cfg["port"], ssl_context=ctx,
                             timeout=30)
    conn.login(cfg["user"], cfg["pwd"])
    return conn


def _ensure_processed_folder(conn: imaplib.IMAP4_SSL,
                             folder: str) -> Optional[str]:
    """Try to create the Processed folder if it doesn't exist. Returns
    the folder name to use, or None if we can't make one (we'll fall
    back to flagging messages SEEN instead)."""
    try:
        typ, _data = conn.list()
        if typ != "OK":
            return None
        # Already exists?
        try:
            conn.select(folder, readonly=True)
            return folder
        except Exception:
            pass
        conn.create(folder)
        return folder
    except Exception:
        return None


def poll_once(profile: str = "admin") -> dict:
    """Single IMAP pass over one mailbox. Returns a summary dict."""
    cfg = _config(profile)
    if cfg["disabled"]:
        return {"skipped": "disabled"}
    if not _is_configured(cfg):
        return {"skipped": "incomplete_config"}

    summary = {"checked": 0, "enqueued": 0, "rejected": 0, "errors": []}
    try:
        conn = _connect(cfg)
    except Exception as exc:
        msg = f"connect failed: {exc}"
        logger.warning("email_ingest[%s]: %s", profile, msg)
        _set_state(profile, last_poll_status="error", last_poll_error=msg)
        return {"error": msg}

    try:
        proc_folder = _ensure_processed_folder(conn, cfg["processed_folder"])
        conn.select(cfg["folder"])
        typ, data = conn.uid("SEARCH", None, "UNSEEN")
        if typ != "OK":
            summary["errors"].append("search failed")
            return summary
        ids = (data[0] or b"").split()
        summary["checked"] = len(ids)
        for msg_uid in ids:
            try:
                _process_one(conn, msg_uid, cfg, proc_folder, summary)
            except Exception as exc:
                logger.exception("email_ingest[%s]: per-message handler crashed", profile)
                summary["errors"].append(str(exc)[:200])
    finally:
        try: conn.close()
        except Exception: pass
        try: conn.logout()
        except Exception: pass

    _set_state(profile, last_poll_status="ok",
               last_poll_error=None,
               ingested_total=_state[profile].get("ingested_total", 0) + summary["enqueued"],
               rejected_total=_state[profile].get("rejected_total", 0) + summary["rejected"])
    return summary


def _process_one(conn: imaplib.IMAP4_SSL, msg_id: bytes, cfg: dict,
                 proc_folder: Optional[str], summary: dict) -> None:
    profile = cfg["profile"]
    typ, msg_data = conn.uid("FETCH", msg_id, "(RFC822)")
    if typ != "OK" or not msg_data:
        summary["errors"].append(f"fetch failed for {msg_id!r}")
        return
    raw = None
    for chunk in msg_data:
        if isinstance(chunk, tuple) and len(chunk) >= 2 and chunk[1]:
            raw = chunk[1]
            break
    if not raw:
        summary["errors"].append(f"empty payload for {msg_id!r}")
        return
    msg = email.message_from_bytes(raw)
    subject  = _decode_header(msg.get("Subject"))
    from_hdr = _decode_header(msg.get("From"))
    from_addr = _extract_address(from_hdr)

    _set_state(profile, last_email_from=from_addr, last_email_subject=subject)

    # Sender validation — a fixed allowlist for "admin", or "is this a
    # registered PrionLab tools user" for "lab".
    if cfg["sender_check"] == "allowlist":
        allowed = _is_allowed_sender(from_addr, cfg["allow"])
    else:
        allowed = _is_registered_sender(from_addr)
    if not allowed:
        logger.info("email_ingest[%s]: rejected (sender %s not allowed)", profile, from_addr)
        summary["rejected"] += 1
        _mark_handled(conn, msg_id, proc_folder)
        return

    # Recipient filter (alias setup)
    if cfg["target"] and not _is_addressed_to_target(msg, cfg["target"]):
        logger.info("email_ingest[%s]: skipped (not addressed to %s)", profile, cfg["target"])
        _mark_handled(conn, msg_id, proc_folder)
        return

    bcc = _admin_bcc(from_addr) if cfg["bcc_admins"] else []
    bcc_str = ",".join(bcc) if bcc else None

    pdfs = _pdf_parts(msg)
    if not pdfs:
        _reply(from_addr,
               subject=f"[PrionVault] Sin PDF adjunto — {subject[:80]}",
               body=(
                   "Recibí tu email pero no encontré ningún PDF adjunto.\n\n"
                   "Asegúrate de que el fichero está adjuntado como "
                   "application/pdf y que su nombre termina en .pdf.\n"
               ),
               bcc=bcc)
        summary["rejected"] += 1
        _mark_handled(conn, msg_id, proc_folder)
        return

    ingested = []
    failed = []
    for filename, content in pdfs:
        if not content.startswith(b"%PDF"):
            failed.append((filename, "no parece un PDF (falta cabecera %PDF)"))
            continue
        job_id = _enqueue(content, filename,
                          notify_email=from_addr,
                          notify_subject=subject,
                          notify_bcc=bcc_str)
        if job_id:
            ingested.append((filename, job_id))
            summary["enqueued"] += 1
        else:
            failed.append((filename, "encolado fallido"))

    # We only send an immediate SMTP reply if NOTHING was enqueued
    # (i.e. every attachment was rejected before reaching the worker).
    # When at least one PDF was queued the sender will get a single
    # final email from the worker with resolved metadata and the PDF
    # attached (already carrying `bcc` via the job's notify_bcc column)
    # — sending an extra "received" message here would just be noise.
    if not ingested:
        _reply(from_addr,
               subject=f"[PrionVault] No se encoló ningún PDF — {subject[:80]}",
               body=_compose_reply_body(subject, from_addr, ingested, failed),
               bcc=bcc)
    _mark_handled(conn, msg_id, proc_folder)


# ── Leader election ──────────────────────────────────────────────────────────

def _try_become_leader(profile: str) -> bool:
    """Acquire the cluster-wide advisory lock for this profile. Returns
    True if we are (or have just become) the leader for it. False means
    another gunicorn worker holds it; back off and try again on the
    next tick.

    The lock is held for the lifetime of the SQLAlchemy connection in
    `_leader_conn[profile]`. Closing that connection (or losing it)
    frees the lock automatically — that's how a dead leader's slot
    opens up for a follower to take.
    """
    existing = _leader_conn.get(profile)
    if existing is not None:
        # Verify the connection is still alive. If the DB went away
        # while we held the lock, drop the handle so the next call
        # re-acquires.
        try:
            from sqlalchemy import text
            existing.execute(text("SELECT 1"))
            return True
        except Exception as exc:
            logger.warning("email_ingest[%s]: leader DB conn died (%s); will reacquire",
                           profile, exc)
            try: existing.close()
            except Exception: pass
            _leader_conn[profile] = None

    try:
        from sqlalchemy import text
        from ..ingestion.queue import _get_engine
        eng = _get_engine()
        conn = eng.connect()
        row = conn.execute(
            text("SELECT pg_try_advisory_lock(:k)"),
            {"k": _LEADER_LOCK_KEYS[profile]},
        ).first()
        if row and row[0]:
            _leader_conn[profile] = conn
            logger.info("email_ingest[%s]: acquired singleton leader lock", profile)
            return True
        conn.close()
        return False
    except Exception as exc:
        logger.warning("email_ingest[%s]: leader-lock attempt failed (%s)", profile, exc)
        return False


def _mark_handled(conn: imaplib.IMAP4_SSL, msg_id: bytes,
                  proc_folder: Optional[str]) -> None:
    """Move to Processed folder when available, else just mark SEEN."""
    try:
        if proc_folder:
            conn.uid("COPY", msg_id, proc_folder)
            conn.uid("STORE", msg_id, "+FLAGS", r"(\Deleted)")
            conn.expunge()
        else:
            conn.uid("STORE", msg_id, "+FLAGS", r"(\Seen)")
    except Exception as exc:
        logger.warning("email_ingest: mark-handled failed (%s)", exc)


def _compose_reply_body(subject: str, from_addr: str,
                        ingested: list[tuple[str, int]],
                        failed: list[tuple[str, str]]) -> str:
    """Body for the immediate-rejection reply. Only used when none of
    the attachments made it into the queue — successful jobs send their
    own final reply from the worker once the ingest is complete."""
    lines = [
        f"Hola,",
        "",
        f"Recibí tu email («{subject or '(sin asunto)'}») pero no pude",
        "encolar ningún PDF. Detalle:",
        "",
    ]
    if failed:
        for fname, reason in failed:
            lines.append(f"  • {fname}  — {reason}")
    else:
        lines.append("  (sin adjuntos que parezcan PDFs)")
    lines.append("")
    lines.append("Si crees que es un error, vuelve a enviarlo o sube el PDF a mano")
    lines.append(f"desde {_PUBLIC_BASE_URL}/prionvault/")
    lines.append("")
    lines.append("— PrionVault")
    return "\n".join(lines)


# ── Daemon ──────────────────────────────────────────────────────────────────

def _set_state(profile: str, **kw) -> None:
    with _lock:
        _state[profile].update(kw)


def request_poll_now(profile: Optional[str] = None) -> None:
    """Wake the daemon(s) up immediately instead of waiting for the next
    interval. Omit `profile` to nudge both mailboxes."""
    for p in ((profile,) if profile else _PROFILES):
        _force[p].set()


def _run_loop(profile: str) -> None:
    while not _stop[profile].is_set():
        cfg = _config(profile)
        if cfg["disabled"] or not _is_configured(cfg):
            # Wait quietly; the operator may configure us at any time.
            _force[profile].wait(timeout=cfg["poll"])
            _force[profile].clear()
            continue

        # Only the leader gunicorn worker actually polls IMAP for this
        # profile. The other one sits in this branch retrying until
        # it's needed.
        if not _try_become_leader(profile):
            _set_state(profile, running=False, last_poll_status="follower")
            _force[profile].wait(timeout=cfg["poll"])
            _force[profile].clear()
            continue

        from datetime import datetime, timezone
        _set_state(profile, running=True,
                   last_poll_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        try:
            poll_once(profile)
        except Exception as exc:
            logger.exception("email_ingest[%s]: poll crashed (%s)", profile, exc)
            _set_state(profile, last_poll_status="error", last_poll_error=str(exc)[:240])
        finally:
            _set_state(profile, running=False)
        # Sleep until force OR poll interval.
        _force[profile].wait(timeout=cfg["poll"])
        _force[profile].clear()


def start_email_ingest_daemon() -> list[threading.Thread]:
    """Starts one polling thread per mailbox profile ("admin", "lab").
    Each profile independently no-ops (waits quietly) until its own env
    vars are configured, so deployments that only set up the admin
    mailbox are unaffected."""
    threads = []
    for profile in _PROFILES:
        t = _thread.get(profile)
        if t and t.is_alive():
            threads.append(t)
            continue
        _stop[profile].clear()
        t = threading.Thread(target=_run_loop, args=(profile,),
                             name=f"prionvault-email-ingest-{profile}",
                             daemon=True)
        t.start()
        _thread[profile] = t
        threads.append(t)
    return threads
