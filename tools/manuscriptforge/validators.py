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


VALID_GRANT_STATUSES = {'active', 'closed', 'pending'}
VALID_PUB_TYPES = {'article', 'review', 'preprint', 'book_chapter', 'conference', 'other'}
VALID_ACK_CATEGORIES = {
    'technical_staff', 'core_facility', 'external_collaborator',
    'sample_donor', 'infrastructure', 'other',
}


def validate_grant(data: dict) -> list[str]:
    errors = []
    if not data.get('code', '').strip():
        errors.append("Grant code is required.")
    if not data.get('title', '').strip():
        errors.append("Title is required.")
    if not data.get('funding_agency', '').strip():
        errors.append("Funding agency is required.")
    if not data.get('acknowledgment_text', '').strip():
        errors.append("Acknowledgment text is required.")

    status = data.get('status', '').strip()
    if not status:
        errors.append("Status is required.")
    elif status not in VALID_GRANT_STATUSES:
        errors.append(f"Invalid status. Must be one of: {', '.join(sorted(VALID_GRANT_STATUSES))}.")

    start = data.get('start_date', '').strip()
    end = data.get('end_date', '').strip()
    if start and not validate_iso_date(start):
        errors.append("Start date must be YYYY-MM-DD.")
    if end and not validate_iso_date(end):
        errors.append("End date must be YYYY-MM-DD.")
    if start and end and validate_iso_date(start) and validate_iso_date(end):
        if date_type.fromisoformat(start) > date_type.fromisoformat(end):
            errors.append("Start date must not be after end date.")

    amount = data.get('amount_eur', '').strip()
    if amount:
        try:
            if float(amount) < 0:
                errors.append("Amount must be >= 0.")
        except ValueError:
            errors.append("Amount must be a number.")

    return errors


def validate_publication(data: dict) -> list[str]:
    errors = []
    if not data.get('title', '').strip():
        errors.append("Title is required.")
    if not data.get('authors_raw', '').strip():
        errors.append("Authors are required.")
    if not data.get('journal', '').strip():
        errors.append("Journal is required.")

    year = data.get('year', '').strip()
    if not year:
        errors.append("Year is required.")
    else:
        try:
            y = int(year)
            if y < 1900 or y > 2100:
                errors.append("Year must be between 1900 and 2100.")
        except ValueError:
            errors.append("Year must be a number.")

    doi = data.get('doi', '').strip()
    if doi and not re.match(r'^10\.\d{4,}/', doi):
        errors.append("DOI must start with '10.XXXX/' (e.g. 10.1038/...).")

    pub_type = data.get('pub_type', '').strip()
    if pub_type and pub_type not in VALID_PUB_TYPES:
        errors.append(f"Invalid publication type.")

    return errors


def validate_ack_block(data: dict) -> list[str]:
    errors = []
    if not data.get('short_label', '').strip():
        errors.append("Label is required.")
    if not data.get('text', '').strip():
        errors.append("Text is required.")

    category = data.get('category', '').strip()
    if not category:
        errors.append("Category is required.")
    elif category not in VALID_ACK_CATEGORIES:
        errors.append(f"Invalid category.")

    return errors
