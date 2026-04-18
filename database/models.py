import re
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, CheckConstraint, Column, DateTime, ForeignKey,
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
    """User model with authentication and profile information."""
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Authentication
    email = Column(String(255), unique=True, nullable=False, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)

    # Profile
    first_name = Column(String(100), nullable=False)
    last_name = Column(String(100), nullable=False, default="")
    affiliation = Column(String(255))
    position = Column(String(100))
    research_areas = Column(Text)
    orcid = Column(String(19))
    bio = Column(Text)
    profile_image_url = Column(String(512))

    # Account status
    email_verified = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    last_login = Column(DateTime(timezone=True))
    role = Column(String(20), default="reader", nullable=False)
    language = Column(String(10), default="es", nullable=False)

    # Lab FK — nullable; set after lab creation
    lab_id = Column(UUID(as_uuid=True), ForeignKey("labs.id"), nullable=True)

    # Preferences (JSON blob)
    preferences = Column(JSON, default=lambda: {"theme": "light", "notifications": True})

    # Relationships
    lab = relationship("Lab", back_populates="members", foreign_keys=[lab_id])
    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")
    activities = relationship("UserActivity", back_populates="user", cascade="all, delete-orphan")
    publications = relationship("Publication", back_populates="created_by",
                                foreign_keys="Publication.created_by_id")

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
            "id": str(self.id),
            "email": self.email,
            "username": self.username,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "full_name": self.full_name,
            "affiliation": self.affiliation,
            "position": self.position,
            "research_areas": self.research_areas_list,
            "orcid": self.orcid,
            "bio": self.bio,
            "role": self.role,
            "language": self.language,
            "lab_id": str(self.lab_id) if self.lab_id else None,
            "email_verified": self.email_verified,
            "is_active": self.is_active,
            "last_login": self.last_login.isoformat() if self.last_login else None,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "preferences": self.preferences,
        }
        if include_sensitive:
            d["password_hash"] = self.password_hash
        return d


class Lab(Base, TimestampMixin):
    """Research lab / group model."""
    __tablename__ = "labs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    institution = Column(String(255), nullable=False, default="")
    department = Column(String(255))
    description = Column(Text)
    website = Column(String(512))
    location = Column(String(255))
    lab_code = Column(String(20), unique=True, nullable=False, index=True)

    # PI is nullable to break circular FK; set after user is created
    pi_user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", use_alter=True, name="fk_lab_pi_user"),
        nullable=True,
    )
    max_members = Column(Integer, default=20)
    is_active = Column(Boolean, default=True, nullable=False)

    # Relationships
    pi = relationship("User", foreign_keys=[pi_user_id])
    members = relationship("User", back_populates="lab", foreign_keys="User.lab_id")
    invitations = relationship("LabInvitation", back_populates="lab",
                               cascade="all, delete-orphan")

    __table_args__ = (
        CheckConstraint("max_members > 0", name="positive_max_members"),
        Index("idx_lab_code_active", lab_code, is_active),
    )

    def to_dict(self):
        return {
            "id": str(self.id),
            "name": self.name,
            "institution": self.institution,
            "department": self.department,
            "description": self.description,
            "website": self.website,
            "location": self.location,
            "lab_code": self.lab_code,
            "pi_user_id": str(self.pi_user_id) if self.pi_user_id else None,
            "max_members": self.max_members,
            "is_active": self.is_active,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "member_count": len(self.members) if self.members else 0,
        }


class LabInvitation(Base, TimestampMixin):
    """Pending lab invitations."""
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
    """Tracks active user sessions for audit purposes."""
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
    """Audit log of user actions."""
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
        Index("idx_activity_created", created_at),
    )


class Publication(Base, TimestampMixin):
    """Research publication — stub for Part 1, expanded in Part 2."""
    __tablename__ = "publications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pub_id = Column(String(50), unique=True, index=True)  # matches CSV pub_id
    title = Column(String(500), nullable=False, default="")
    authors = Column(Text)
    journal = Column(String(255))
    year = Column(Integer)
    doi = Column(String(255), unique=True, nullable=True)
    pmid = Column(String(20))
    abstract = Column(Text)
    keywords = Column(Text)
    pub_type = Column(String(50), default="article")
    is_lab_publication = Column(Boolean, default=False)

    created_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_by = relationship("User", back_populates="publications",
                               foreign_keys=[created_by_id])

    __table_args__ = (Index("idx_pub_year_type", year, pub_type),)
