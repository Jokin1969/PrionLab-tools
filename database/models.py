import re
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, CheckConstraint, Column, DateTime, Float, ForeignKey,
    Index, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import relationship, validates

from database.config import Base


class TimestampMixin:
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow,
                        onupdate=datetime.utcnow, nullable=False)


class User(Base, TimestampMixin):
    __tablename__ = "users"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    first_name = Column(String(100), nullable=False)
    last_name = Column(String(100), nullable=False, default="")
    affiliation = Column(String(255))
    position = Column(String(100))
    research_areas = Column(Text)
    orcid = Column(String(19))
    bio = Column(Text)
    profile_image_url = Column(String(512))
    email_verified = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    last_login = Column(DateTime(timezone=True))
    role = Column(String(20), default="reader", nullable=False)
    language = Column(String(10), default="es", nullable=False)
    lab_id = Column(UUID(as_uuid=True), ForeignKey("labs.id"), nullable=True)
    preferences = Column(JSON, default=lambda: {"theme": "light", "notifications": True})
    lab = relationship("Lab", back_populates="members", foreign_keys="[User.lab_id]")
    sessions = relationship("UserSession", back_populates="user",
                            cascade="all, delete-orphan")
    activities = relationship("UserActivity", back_populates="user",
                              cascade="all, delete-orphan")
    publications = relationship("Publication", back_populates="created_by",
                                foreign_keys="[Publication.created_by_id]")
    preferences_record = relationship("UserPreference", back_populates="user",
                                      uselist=False, cascade="all, delete-orphan")
    __table_args__ = (
        CheckConstraint(role.in_(["admin", "editor", "reader"]), name="valid_role"),
        Index("idx_user_email_active", email, is_active),
        Index("idx_user_lab_role", lab_id, role),
    )

    @validates("email")
    def validate_email(self, key, email):
        if not re.match(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$", email):
            raise ValueError("Invalid email format")
        return email.lower().strip()

    @validates("orcid")
    def validate_orcid(self, key, orcid):
        if orcid and not re.match(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$", orcid):
            raise ValueError("Invalid ORCID format")
        return orcid

    @hybrid_property
    def full_name(self):
        return f"{self.first_name} {self.last_name}".strip()

    @hybrid_property
    def research_areas_list(self):
        if self.research_areas:
            return [a.strip() for a in self.research_areas.split(";") if a.strip()]
        return []

    def to_dict(self, include_sensitive=False):
        d = {
            "id": str(self.id), "email": self.email, "username": self.username,
            "first_name": self.first_name, "last_name": self.last_name,
            "full_name": self.full_name, "affiliation": self.affiliation,
            "position": self.position, "research_areas": self.research_areas_list,
            "orcid": self.orcid, "bio": self.bio, "role": self.role,
            "language": self.language,
            "lab_id": str(self.lab_id) if self.lab_id else None,
            "email_verified": self.email_verified, "is_active": self.is_active,
            "last_login": self.last_login.isoformat() if self.last_login else None,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "preferences": self.preferences,
        }
        if include_sensitive:
            d["password_hash"] = self.password_hash
        return d


class Lab(Base, TimestampMixin):
    __tablename__ = "labs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    institution = Column(String(255), nullable=False, default="")
    department = Column(String(255))
    description = Column(Text)
    website = Column(String(512))
    location = Column(String(255))
    lab_code = Column(String(20), unique=True, nullable=False, index=True)
    pi_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", use_alter=True, name="fk_lab_pi_user"),
        nullable=True,
    )
    max_members = Column(Integer, default=20)
    is_active = Column(Boolean, default=True, nullable=False)
    pi = relationship("User", foreign_keys=[pi_user_id])
    members = relationship("User", back_populates="lab", foreign_keys="[User.lab_id]")
    invitations = relationship("LabInvitation", back_populates="lab",
                               cascade="all, delete-orphan")
    templates = relationship("ManuscriptTemplate", back_populates="lab")
    __table_args__ = (
        CheckConstraint("max_members > 0", name="positive_max_members"),
        Index("idx_lab_code_active", lab_code, is_active),
    )

    def to_dict(self):
        return {
            "id": str(self.id), "name": self.name, "institution": self.institution,
            "department": self.department, "description": self.description,
            "website": self.website, "location": self.location,
            "lab_code": self.lab_code,
            "pi_user_id": str(self.pi_user_id) if self.pi_user_id else None,
            "max_members": self.max_members, "is_active": self.is_active,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "member_count": len(self.members) if self.members else 0,
        }


class LabInvitation(Base, TimestampMixin):
    __tablename__ = "lab_invitations"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lab_id = Column(UUID(as_uuid=True), ForeignKey("labs.id"), nullable=False)
    email = Column(String(255), nullable=False)
    token = Column(String(64), unique=True, nullable=False, index=True)
    invited_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    accepted_at = Column(DateTime(timezone=True))
    expires_at = Column(DateTime(timezone=True), nullable=False)
    lab = relationship("Lab", back_populates="invitations")
    invited_by = relationship("User", foreign_keys=[invited_by_id])
    __table_args__ = (Index("idx_invitation_lab_email", lab_id, email),)


class UserSession(Base):
    __tablename__ = "user_sessions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    session_token = Column(String(128), unique=True, nullable=False, index=True)
    ip_address = Column(String(45))
    user_agent = Column(String(512))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    user = relationship("User", back_populates="sessions")
    __table_args__ = (Index("idx_session_user_active", user_id, is_active),)


class UserActivity(Base):
    __tablename__ = "user_activities"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    username = Column(String(50), nullable=False)
    action_type = Column(String(50), nullable=False)
    resource_type = Column(String(50))
    resource_id = Column(String(100))
    details = Column(Text)
    ip_address = Column(String(45))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    user = relationship("User", back_populates="activities")
    __table_args__ = (
        Index("idx_activity_user_action", user_id, action_type),
        Index("idx_activity_created_at", created_at),
    )


class Publication(Base, TimestampMixin):
    __tablename__ = "publications"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pub_id = Column(String(50), unique=True, index=True)  # legacy CSV identifier
    title = Column(Text, nullable=False, default="")
    authors = Column(Text, nullable=False, default="")
    journal = Column(String(255), nullable=False, default="")
    year = Column(Integer, nullable=False, default=2000)
    volume = Column(String(20))
    issue = Column(String(20))
    pages = Column(String(50))
    doi = Column(String(255), index=True)
    pmid = Column(String(20), index=True)
    pmc_id = Column(String(20))
    pdf_url = Column(String(512))
    abstract = Column(Text)
    keywords = Column(Text)
    research_area = Column(String(100), index=True)
    publication_type = Column(String(50), default="research_article")
    impact_factor = Column(Float)
    citation_count = Column(Integer, default=0)
    is_open_access = Column(Boolean, default=False)
    is_lab_publication = Column(Boolean, default=False)
    lab_authors = Column(Text)
    corresponding_author = Column(String(255))
    funding_sources = Column(Text)
    created_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    is_featured = Column(Boolean, default=False)
    quality_score = Column(Float)
    search_vector = Column(Text)
    created_by = relationship("User", back_populates="publications",
                              foreign_keys=[created_by_id])
    metrics = relationship("PublicationMetric", back_populates="publication",
                           cascade="all, delete-orphan")
    outgoing_citations = relationship(
        "CitationReference",
        foreign_keys="[CitationReference.citing_publication_id]",
        back_populates="citing_pub",
        cascade="all, delete-orphan",
    )
    cited_by_refs = relationship(
        "CitationReference",
        foreign_keys="[CitationReference.cited_publication_id]",
        back_populates="cited_pub",
    )
    __table_args__ = (
        CheckConstraint("year >= 1900 AND year <= 2100", name="valid_year"),
        CheckConstraint("impact_factor >= 0 OR impact_factor IS NULL",
                        name="non_negative_if"),
        CheckConstraint("citation_count >= 0 OR citation_count IS NULL",
                        name="non_negative_cites"),
        Index("idx_pub_year_journal", year, journal),
        Index("idx_pub_lab_featured", is_lab_publication, is_featured),
        Index("idx_pub_created_by", created_by_id),
    )

    @validates("doi")
    def validate_doi(self, key, doi):
        import re as _re
        if doi and not _re.match(r"^10\.\d+/.+", doi):
            raise ValueError("Invalid DOI format")
        return doi

    @validates("year")
    def validate_year(self, key, year):
        if year and year > datetime.now().year + 2:
            raise ValueError("Year cannot be more than 2 years in the future")
        return year

    @hybrid_property
    def authors_list(self):
        return [a.strip() for a in self.authors.split(";") if a.strip()] if self.authors else []

    @hybrid_property
    def keywords_list(self):
        return [k.strip() for k in self.keywords.split(";") if k.strip()] if self.keywords else []

    @hybrid_property
    def citation_text(self):
        authors = self.authors_list
        author_text = f"{authors[0]} et al." if len(authors) > 3 else ", ".join(authors)
        return f"{author_text} {self.title}. {self.journal}. {self.year}."

    def update_search_vector(self):
        parts = [self.title or "", self.authors or "", self.journal or "",
                 self.abstract or "", self.keywords or "",
                 str(self.year), self.research_area or ""]
        self.search_vector = " ".join(parts).lower()

    def to_dict(self):
        return {
            "id": str(self.id), "pub_id": self.pub_id, "title": self.title,
            "authors": self.authors_list, "journal": self.journal, "year": self.year,
            "volume": self.volume, "issue": self.issue, "pages": self.pages,
            "doi": self.doi, "pmid": self.pmid, "pmc_id": self.pmc_id,
            "pdf_url": self.pdf_url, "abstract": self.abstract,
            "keywords": self.keywords_list, "research_area": self.research_area,
            "publication_type": self.publication_type,
            "impact_factor": self.impact_factor, "citation_count": self.citation_count,
            "is_open_access": self.is_open_access,
            "is_lab_publication": self.is_lab_publication,
            "lab_authors": self.lab_authors,
            "corresponding_author": self.corresponding_author,
            "funding_sources": self.funding_sources,
            "created_by_id": str(self.created_by_id) if self.created_by_id else None,
            "is_featured": self.is_featured, "quality_score": self.quality_score,
            "citation_text": self.citation_text,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class PublicationMetric(Base, TimestampMixin):
    __tablename__ = "publication_metrics"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    publication_id = Column(UUID(as_uuid=True), ForeignKey("publications.id"),
                            nullable=False)
    metric_type = Column(String(50), nullable=False)
    value = Column(Float, nullable=False)
    source = Column(String(100))
    date_recorded = Column(DateTime(timezone=True), default=datetime.utcnow)
    notes = Column(Text)
    confidence_score = Column(Float)
    publication = relationship("Publication", back_populates="metrics")
    __table_args__ = (
        Index("idx_metric_pub_type", publication_id, metric_type),
        UniqueConstraint("publication_id", "metric_type", "source", "date_recorded",
                         name="unique_pub_metric"),
    )


class CitationReference(Base, TimestampMixin):
    __tablename__ = "citation_references"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    citing_publication_id = Column(UUID(as_uuid=True),
                                   ForeignKey("publications.id"), nullable=False)
    cited_publication_id = Column(UUID(as_uuid=True),
                                  ForeignKey("publications.id"), nullable=False)
    citation_context = Column(Text)
    citation_type = Column(String(50))
    section = Column(String(100))
    confidence_score = Column(Float)
    extracted_by = Column(String(50))
    citing_pub = relationship("Publication", foreign_keys=[citing_publication_id],
                              back_populates="outgoing_citations")
    cited_pub = relationship("Publication", foreign_keys=[cited_publication_id],
                             back_populates="cited_by_refs")
    __table_args__ = (
        Index("idx_citation_citing", citing_publication_id),
        Index("idx_citation_cited", cited_publication_id),
        UniqueConstraint("citing_publication_id", "cited_publication_id",
                         name="unique_citation_pair"),
    )


class ManuscriptTemplate(Base, TimestampMixin):
    __tablename__ = "manuscript_templates"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    journal = Column(String(255))
    template_type = Column(String(50), default="standard")
    category = Column(String(100))
    sections = Column(JSON, nullable=False, default=list)
    styles = Column(JSON)
    formatting_rules = Column(JSON)
    word_limit = Column(Integer)
    reference_style = Column(String(50))
    required_sections = Column(JSON)
    created_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    lab_id = Column(UUID(as_uuid=True), ForeignKey("labs.id"))
    is_public = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    usage_count = Column(Integer, default=0)
    average_rating = Column(Float)
    version = Column(String(20), default="1.0")
    parent_template_id = Column(UUID(as_uuid=True),
                                ForeignKey("manuscript_templates.id"), nullable=True)
    created_by = relationship("User")
    lab = relationship("Lab", back_populates="templates")
    parent_template = relationship(
        "ManuscriptTemplate",
        foreign_keys="[ManuscriptTemplate.parent_template_id]",
        remote_side="ManuscriptTemplate.id",
        back_populates="child_templates",
    )
    child_templates = relationship(
        "ManuscriptTemplate",
        foreign_keys="[ManuscriptTemplate.parent_template_id]",
        back_populates="parent_template",
    )
    __table_args__ = (
        Index("idx_template_journal_active", journal, is_active),
        Index("idx_template_public_active", is_public, is_active),
        Index("idx_template_lab", lab_id),
    )

    def to_dict(self):
        return {
            "id": str(self.id), "name": self.name, "description": self.description,
            "journal": self.journal, "template_type": self.template_type,
            "category": self.category, "sections": self.sections,
            "word_limit": self.word_limit, "reference_style": self.reference_style,
            "created_by_id": str(self.created_by_id) if self.created_by_id else None,
            "lab_id": str(self.lab_id) if self.lab_id else None,
            "is_public": self.is_public, "is_active": self.is_active,
            "usage_count": self.usage_count, "average_rating": self.average_rating,
            "version": self.version, "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class UserPreference(Base, TimestampMixin):
    __tablename__ = "user_preferences"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"),
                     nullable=False, unique=True)
    theme = Column(String(20), default="light")
    language = Column(String(10), default="en")
    timezone = Column(String(50), default="UTC")
    date_format = Column(String(20), default="YYYY-MM-DD")
    email_notifications = Column(Boolean, default=True)
    lab_notifications = Column(Boolean, default=True)
    publication_alerts = Column(Boolean, default=True)
    weekly_digest = Column(Boolean, default=True)
    default_citation_style = Column(String(50), default="vancouver")
    default_export_format = Column(String(20), default="pdf")
    auto_save_interval = Column(Integer, default=300)
    preferred_research_areas = Column(JSON)
    followed_journals = Column(JSON)
    profile_visibility = Column(String(20), default="lab")
    data_sharing_consent = Column(Boolean, default=False)
    analytics_consent = Column(Boolean, default=True)
    advanced_settings = Column(JSON, default=lambda: {})
    user = relationship("User", back_populates="preferences_record")

    def to_dict(self):
        return {
            "user_id": str(self.user_id), "theme": self.theme,
            "language": self.language, "timezone": self.timezone,
            "date_format": self.date_format,
            "email_notifications": self.email_notifications,
            "lab_notifications": self.lab_notifications,
            "publication_alerts": self.publication_alerts,
            "weekly_digest": self.weekly_digest,
            "default_citation_style": self.default_citation_style,
            "default_export_format": self.default_export_format,
            "auto_save_interval": self.auto_save_interval,
            "preferred_research_areas": self.preferred_research_areas or [],
            "followed_journals": self.followed_journals or [],
            "profile_visibility": self.profile_visibility,
            "data_sharing_consent": self.data_sharing_consent,
            "analytics_consent": self.analytics_consent,
            "advanced_settings": self.advanced_settings,
            "updated_at": self.updated_at.isoformat(),
        }


class SystemLog(Base):
    __tablename__ = "system_logs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    level = Column(String(20), nullable=False)
    logger_name = Column(String(100), nullable=False)
    message = Column(Text, nullable=False)
    module = Column(String(100))
    function = Column(String(100))
    line_number = Column(Integer)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    session_id = Column(String(255))
    ip_address = Column(String(45))
    user_agent = Column(Text)
    timestamp = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    trace_id = Column(String(100))
    extra_data = Column(JSON)
    execution_time_ms = Column(Float)
    memory_usage_mb = Column(Float)
    user = relationship("User")
    __table_args__ = (
        Index("idx_log_timestamp", timestamp),
        Index("idx_log_level_ts", level, timestamp),
        Index("idx_log_user_id", user_id),
        Index("idx_log_trace", trace_id),
    )


# ── Module-level performance indexes ──────────────────────────────────────────
Index("idx_user_created_at", User.created_at)
Index("idx_pub_created_at", Publication.created_at)
Index("idx_pub_year_desc", Publication.year.desc())
Index("idx_pub_if_desc", Publication.impact_factor.desc())
Index("idx_session_expires", UserSession.expires_at)
Index("idx_activity_user_created", UserActivity.created_at)
