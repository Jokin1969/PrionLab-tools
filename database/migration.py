"""
CSV → PostgreSQL migration.

Reads the existing CSV files and inserts records into PostgreSQL.
Safe to run multiple times — skips records that already exist.
"""
import logging
import os
import uuid
from datetime import datetime

logger = logging.getLogger(__name__)


def _split_full_name(full_name: str) -> tuple[str, str]:
    """Split 'First Last' into (first, last)."""
    parts = (full_name or "").strip().split(" ", 1)
    return parts[0], parts[1] if len(parts) > 1 else ""


def _migrate_users(session) -> dict[str, uuid.UUID]:
    """Migrate users.csv → users table.  Returns {username: uuid} map."""
    from core.users import load_users
    from database.models import User

    username_to_id: dict[str, uuid.UUID] = {}
    existing = {u.username for u in session.query(User.username).all()}

    for row in load_users():
        uname = row.get("username", "").strip().lower()
        if not uname or uname in existing:
            if uname:
                obj = session.query(User).filter_by(username=uname).first()
                if obj:
                    username_to_id[uname] = obj.id
            continue

        email = row.get("email", "").strip().lower() or f"{uname}@prionlab.local"
        first, last = _split_full_name(row.get("full_name", uname))

        last_login = None
        raw_ll = row.get("last_login", "")
        if raw_ll:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
                try:
                    last_login = datetime.strptime(raw_ll, fmt)
                    break
                except ValueError:
                    pass

        created_at = None
        raw_ca = row.get("created_at", "")
        if raw_ca:
            try:
                created_at = datetime.strptime(raw_ca[:10], "%Y-%m-%d")
            except ValueError:
                pass

        user = User(
            username=uname,
            email=email,
            password_hash=row.get("password_hash", ""),
            first_name=first,
            last_name=last,
            affiliation=row.get("affiliation", ""),
            position=row.get("position", ""),
            research_areas=row.get("research_areas", ""),
            orcid=row.get("orcid", "") or None,
            bio=row.get("bio", ""),
            role=row.get("role", "reader"),
            language=row.get("language", "es"),
            is_active=row.get("active", "true").lower() == "true",
            last_login=last_login,
            created_at=created_at or datetime.utcnow(),
        )
        session.add(user)
        session.flush()
        username_to_id[uname] = user.id
        existing.add(uname)
        logger.info("Migrated user: %s", uname)

    return username_to_id


def _migrate_labs(session, username_to_id: dict[str, uuid.UUID]) -> dict[str, uuid.UUID]:
    """Migrate labs.csv → labs table.  Returns {lab_code: uuid} map."""
    try:
        from tools.userprofile.models import _read, LABS_CSV, _LAB_COLS
    except Exception:
        logger.info("No labs CSV found — skipping labs migration")
        return {}

    from database.models import Lab

    lab_code_to_id: dict[str, uuid.UUID] = {}
    existing_codes = {l.lab_code for l in session.query(Lab.lab_code).all()}

    rows = _read(LABS_CSV, _LAB_COLS)
    for row in rows:
        code = row.get("lab_code", "").upper()
        if not code or code in existing_codes:
            if code:
                obj = session.query(Lab).filter_by(lab_code=code).first()
                if obj:
                    lab_code_to_id[code] = obj.id
            continue

        pi_uname = row.get("pi_username", "").lower()
        pi_uuid = username_to_id.get(pi_uname)
        max_m = 20
        try:
            max_m = int(row.get("max_members", 20))
        except (ValueError, TypeError):
            pass

        created_at = None
        raw = row.get("created_at", "")
        if raw:
            try:
                created_at = datetime.fromisoformat(raw[:19])
            except ValueError:
                pass

        lab = Lab(
            name=row.get("lab_name", "").strip(),
            institution=row.get("institution", "").strip(),
            department=row.get("department", "").strip(),
            description=row.get("description", "").strip(),
            website=row.get("website", "").strip(),
            location=row.get("location", "").strip(),
            lab_code=code,
            pi_user_id=pi_uuid,
            max_members=max_m,
            is_active=row.get("is_active", "true").lower() != "false",
            created_at=created_at or datetime.utcnow(),
        )
        session.add(lab)
        session.flush()
        lab_code_to_id[code] = lab.id
        existing_codes.add(code)
        logger.info("Migrated lab: %s (%s)", lab.name, code)

    return lab_code_to_id


def _assign_user_labs(session, username_to_id: dict[str, uuid.UUID],
                      lab_code_to_id: dict[str, uuid.UUID]) -> None:
    """Update User.lab_id from the original CSV lab_id/lab_code mapping."""
    from core.users import load_users
    from database.models import Lab, User

    for row in load_users():
        uname = row.get("username", "").strip().lower()
        csv_lab_id = row.get("lab_id", "").strip()
        if not uname or not csv_lab_id:
            continue
        user = session.query(User).filter_by(username=uname).first()
        if not user or user.lab_id:
            continue
        # csv lab_id is like "lab_abc12345" — match by lab_code or by position lookup
        lab = (session.query(Lab).filter_by(lab_code=csv_lab_id.upper()).first()
               or session.query(Lab).first())
        if lab:
            user.lab_id = lab.id


def _migrate_publications(session, username_to_id: dict) -> int:
    """Migrate publications CSV → publications table.  Returns count inserted."""
    try:
        from tools.research.models import get_all_publications
    except Exception:
        logger.info("No research module found — skipping publications migration")
        return 0

    from database.models import Publication

    existing_pub_ids = {
        r[0] for r in session.query(Publication.pub_id).filter(
            Publication.pub_id.isnot(None)
        ).all()
    }
    inserted = 0

    for row in get_all_publications():
        pub_id = row.get("pub_id", "").strip()
        if not pub_id or pub_id in existing_pub_ids:
            continue

        year = 2000
        try:
            year = int(row.get("year", 2000))
        except (ValueError, TypeError):
            pass

        creator_uname = row.get("created_by", "").strip().lower()
        created_by_id = username_to_id.get(creator_uname)

        doi = row.get("doi", "").strip() or None
        # Skip duplicate DOIs
        if doi and session.query(Publication).filter_by(doi=doi).first():
            doi = None

        pub = Publication(
            pub_id=pub_id,
            title=row.get("title", "").strip() or "Untitled",
            authors=row.get("authors", "").strip(),
            journal=row.get("journal", "").strip(),
            year=year,
            doi=doi,
            pmid=row.get("pmid", "").strip() or None,
            abstract=row.get("abstract", "").strip() or None,
            keywords=row.get("keywords", "").strip() or None,
            research_area=row.get("research_area", "").strip() or None,
            publication_type=row.get("pub_type", "research_article"),
            is_lab_publication=row.get("is_lab_publication", "false").lower() == "true",
            is_open_access=row.get("is_open_access", "false").lower() == "true",
            impact_factor=float(row["impact_factor"]) if row.get("impact_factor") else None,
            citation_count=int(row["citation_count"]) if row.get("citation_count") else 0,
            created_by_id=created_by_id,
        )
        pub.update_search_vector()
        session.add(pub)
        existing_pub_ids.add(pub_id)
        inserted += 1

    if inserted:
        logger.info("Migrated %d publications", inserted)
    return inserted


def run_migration() -> dict:
    """Run full CSV → PostgreSQL migration.  Returns {'success': bool, ...}."""
    from database.config import db
    from sqlalchemy import text as _text

    if not db.is_configured():
        return {"success": False, "error": "DATABASE_URL not set"}

    try:
        db.create_all_tables()
        logger.info("Schema created / verified")
    except Exception as e:
        return {"success": False, "error": f"Schema creation failed: {e}"}

    # Skip the CSV import when the live `users` table already follows the
    # PrionRead / Sequelize schema (columns: name, password, email, role
    # ENUM). The ORM-style queries in _migrate_users would otherwise hit
    # `column users.username does not exist` and crash the startup. This
    # is the case on the deployed instance, where Postgres has always
    # been the source of truth and CSVs were never loaded.
    try:
        with db.engine.connect() as conn:
            cols = {r[0] for r in conn.execute(_text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'users'"
            )).all()}
        if cols and "username" not in cols and "name" in cols:
            logger.info(
                "Skipping legacy CSV→Postgres migration: live users table "
                "uses the PrionRead schema (columns=%s).",
                sorted(cols)[:8] + (["…"] if len(cols) > 8 else []),
            )
            return {"success": True, "skipped": "prionread_schema"}
    except Exception as exc:
        # Introspection failure is non-fatal — just fall through to the
        # legacy path so the original behaviour is preserved.
        logger.warning("users schema probe failed: %s", exc)

    try:
        with db.get_session() as session:
            username_to_id = _migrate_users(session)
            lab_code_to_id = _migrate_labs(session, username_to_id)
            _assign_user_labs(session, username_to_id, lab_code_to_id)
            pubs_count = _migrate_publications(session, username_to_id)

        logger.info(
            "Migration complete — %d users, %d labs, %d publications",
            len(username_to_id), len(lab_code_to_id), pubs_count,
        )
        return {
            "success": True,
            "users_migrated": len(username_to_id),
            "labs_migrated": len(lab_code_to_id),
            "publications_migrated": pubs_count,
        }
    except Exception as e:
        logger.error("Migration failed: %s", e)
        return {"success": False, "error": str(e)}
