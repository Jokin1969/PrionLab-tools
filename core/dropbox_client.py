import logging
import dropbox
from dropbox.exceptions import ApiError, AuthError
from config import DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, dropbox_configured

logger = logging.getLogger(__name__)

_client: dropbox.Dropbox | None = None

def get_client() -> dropbox.Dropbox | None:
    global _client
    if not dropbox_configured():
        logger.warning("Dropbox credentials not configured")
        return None
    if _client is None:
        _client = dropbox.Dropbox(
            oauth2_refresh_token=DROPBOX_REFRESH_TOKEN,
            app_key=DROPBOX_APP_KEY,
            app_secret=DROPBOX_APP_SECRET,
        )
    return _client

def check_connection() -> bool:
    client = get_client()
    if client is None:
        return False
    try:
        client.users_get_current_account()
        return True
    except (ApiError, AuthError, Exception) as e:
        logger.warning("Dropbox connection check failed: %s", e)
        return False
