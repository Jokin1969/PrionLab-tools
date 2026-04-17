import re
from datetime import date as date_type


def validate_email(email: str) -> bool:
    return bool(re.match(r'^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$', email.strip()))


def validate_orcid(orcid: str) -> bool:
    return bool(re.match(r'^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$', orcid.strip()))


def validate_iso_date(date_str: str) -> bool:
    try:
        date_type.fromisoformat(date_str.strip())
        return True
    except (ValueError, AttributeError):
        return False


VALID_STATUSES = {'active', 'alumni', 'visiting', 'collaborator_external'}


def validate_member(data: dict, existing_usernames: list[str] | None = None) -> list[str]:
    errors = []

    if not data.get('first_name', '').strip():
        errors.append("First name is required.")
    if not data.get('last_name', '').strip():
        errors.append("Last name is required.")
    if not data.get('display_name', '').strip():
        errors.append("Display name is required.")

    email = data.get('email', '').strip()
    if not email:
        errors.append("Email is required.")
    elif not validate_email(email):
        errors.append("Invalid email format.")

    orcid = data.get('orcid', '').strip()
    if orcid and not validate_orcid(orcid):
        errors.append("ORCID format must be 0000-0000-0000-000X.")

    status = data.get('status', '').strip()
    if not status:
        errors.append("Status is required.")
    elif status not in VALID_STATUSES:
        errors.append(f"Invalid status. Must be one of: {', '.join(sorted(VALID_STATUSES))}.")

    joined = data.get('joined_date', '').strip()
    if joined and not validate_iso_date(joined):
        errors.append("Joined date must be YYYY-MM-DD.")

    left = data.get('left_date', '').strip()
    if left and not validate_iso_date(left):
        errors.append("Left date must be YYYY-MM-DD.")

    has_ci = data.get('has_competing_interests', 'false').lower() in ('true', '1', 'on')
    if has_ci and not data.get('competing_interests_text', '').strip():
        errors.append("Competing interests declaration is required when flagged.")

    linked = data.get('linked_username', '').strip()
    if linked and existing_usernames is not None and linked not in existing_usernames:
        errors.append(f"Linked username '{linked}' does not exist.")

    return errors


def validate_affiliation(data: dict) -> list[str]:
    errors = []
    if not data.get('short_name', '').strip():
        errors.append("Short name is required.")
    if not data.get('full_name', '').strip():
        errors.append("Full name is required.")
    if not data.get('city', '').strip():
        errors.append("City is required.")
    if not data.get('country', '').strip():
        errors.append("Country is required.")
    cc = data.get('country_code', '').strip()
    if cc and not re.match(r'^[A-Z]{2}$', cc):
        errors.append("Country code must be 2 uppercase letters (e.g. ES, US).")
    return errors
