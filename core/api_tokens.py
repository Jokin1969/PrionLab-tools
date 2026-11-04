"""Personal API keys for the PrionVault browser extension.

Each user can hold one key ("pvu_…"). Only its SHA-256 is stored (column
`api_token_hash` in users.csv), so a leak of users.csv doesn't leak keys.
Issuing a new key revokes the previous one; deactivating the user revokes
it too. Requests carrying a personal key act AS that user (their role and
their PrionVault user id), unlike the old shared keys.
"""
import hashlib
import secrets

PREFIX = "pvu_"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_token(username: str) -> str:
    from core.users import update_user
    token = PREFIX + secrets.token_urlsafe(32)
    if not update_user(username, {"api_token_hash": _hash(token)}):
        raise LookupError(username)
    return token


def revoke_token(username: str) -> None:
    from core.users import update_user
    update_user(username, {"api_token_hash": ""})


def user_for_token(token: str) -> dict | None:
    if not token or not token.startswith(PREFIX):
        return None
    from core.users import load_users
    h = _hash(token)
    for u in load_users():
        stored = u.get("api_token_hash") or ""
        if stored and secrets.compare_digest(stored, h):
            if (u.get("active") or "true").lower() != "true":
                return None
            return u
    return None
