import os
import hashlib
from dotenv import load_dotenv

load_dotenv()

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "")

DROPBOX_APP_KEY = os.environ.get("DROPBOX_APP_KEY", "")
DROPBOX_APP_SECRET = os.environ.get("DROPBOX_APP_SECRET", "")
DROPBOX_REFRESH_TOKEN = os.environ.get("DROPBOX_REFRESH_TOKEN", "")

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_SECURE = os.environ.get("SMTP_SECURE", "tls").lower()

DATA_DIR = os.environ.get("DATA_DIR", "/data")
CSV_DIR = os.path.join(DATA_DIR, "csv")
PAPERS_DIR = os.path.join(DATA_DIR, "papers")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
LOGS_DIR = os.path.join(DATA_DIR, "logs")
DB_PATH = os.path.join(DATA_DIR, "prionlab.db")

DROPBOX_REMOTE_FOLDER = "/Web-tools/PrionLab tools"
DROPBOX_PAPERS_FOLDER = "/Web-tools/PrionLab tools/papers"

MAX_PDF_SIZE_MB = int(os.environ.get("MAX_PDF_SIZE_MB", "30"))

APP_VERSION = "0.3.0"

# i18n
LANGUAGES = ["es", "en"]
DEFAULT_LANGUAGE = "es"
BABEL_DEFAULT_LOCALE = "es"
BABEL_TRANSLATION_DIRECTORIES = "translations"

def _derive_secret_key(password: str) -> str:
    if not password:
        return "dev-insecure-secret-key-set-ADMIN_PASSWORD"
    return hashlib.sha256(f"prionlab-secret:{password}".encode()).hexdigest()

SECRET_KEY = _derive_secret_key(ADMIN_PASSWORD)

def dropbox_configured() -> bool:
    return all([DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN])

def smtp_configured() -> bool:
    return all([SMTP_HOST, SMTP_USER, SMTP_PASS])
