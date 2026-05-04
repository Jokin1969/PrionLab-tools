"""PrionVault SQLAlchemy models.

The `Article` model intentionally maps the SAME `articles` table that
PrionRead's Sequelize ORM writes to. We declare only the columns we need
to read or write from Flask; PostgreSQL ignores any columns SQLAlchemy
isn't aware of.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer, BigInteger, Numeric,
    SmallInteger, String, Text, UniqueConstraint, CHAR,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID, TSVECTOR
from sqlalchemy.orm import relationship

from database.config import Base


# ── Article (canonical, shared with PrionRead via the `articles` table) ──────
class Article(Base):
    __tablename__ = "articles"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Existing columns (managed by PrionRead's Sequelize side too)
    title         = Column(String, nullable=False)
    authors       = Column(Text)                   # PrionRead stores comma-separated string
    year          = Column(Integer)
    journal       = Column(String)
    doi           = Column(String, unique=True)
    pubmed_id     = Column(String, unique=True)
    abstract      = Column(Text)
    tags          = Column(ARRAY(String), default=list)   # PrionRead-side tags
    is_milestone  = Column(Boolean, default=False)
    priority      = Column(Integer, default=3)
    dropbox_path  = Column(String)
    dropbox_link  = Column(Text)
    created_at    = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at    = Column(DateTime(timezone=True), default=datetime.utcnow,
                           onupdate=datetime.utcnow, nullable=False)

    # New columns added by migrations/001_prionvault_tables.sql
    pdf_md5            = Column(CHAR(32), unique=True)
    pdf_size_bytes     = Column(BigInteger)
    pdf_pages          = Column(Integer)
    extracted_text     = Column(Text)
    extraction_status  = Column(String(20), default="pending")
    extraction_error   = Column(Text)
    summary_ai         = Column(Text)
    summary_human      = Column(Text)
    indexed_at         = Column(DateTime(timezone=True))
    index_version      = Column(String(40))
    source             = Column(String(40), default="manual")
    source_metadata    = Column(JSONB, default=dict)
    added_by_id        = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    search_vector      = Column(TSVECTOR)           # populated by trigger; read-only from app

    # Relationships
    chunks             = relationship("ArticleChunk", backref="article",
                                      cascade="all, delete-orphan",
                                      passive_deletes=True)
    pv_tags            = relationship("ArticleTag",
                                      secondary="article_tag_link",
                                      backref="articles",
                                      lazy="select")
    annotations        = relationship("ArticleAnnotation",
                                      backref="article",
                                      cascade="all, delete-orphan",
                                      passive_deletes=True)

    # ── Serialisation helpers ───────────────────────────────────────────────
    def to_dict(self, include_text=False, include_extracted=False, viewer_role=None):
        """Frontend-friendly dict.

        - `include_text`: include abstract + summaries (default true except
                          when caller wants only listing snippets).
        - `include_extracted`: include the full extracted_text (large; only
                                when truly needed, e.g. detail view).
        - `viewer_role`: gates admin-only fields out of the response when
                         the caller is not admin.
        """
        is_admin = viewer_role == "admin"
        d = {
            "id":            str(self.id),
            "title":         self.title,
            "authors":       self.authors or "",
            "journal":       self.journal,
            "year":          self.year,
            "doi":           self.doi,
            "pubmed_id":     self.pubmed_id,
            "tags_legacy":   self.tags or [],
            "tags":          [t.to_dict() for t in (self.pv_tags or [])],
            "priority":      self.priority,
            "is_milestone":  self.is_milestone,
            "pdf_pages":     self.pdf_pages,
            "extraction_status": self.extraction_status,
            "indexed_at":    self.indexed_at.isoformat() if self.indexed_at else None,
            "added_at":      self.created_at.isoformat() if self.created_at else None,
            "has_summary_ai":    bool(self.summary_ai),
            "has_summary_human": bool(self.summary_human),
        }
        if include_text:
            d["abstract"]      = self.abstract
            d["summary_ai"]    = self.summary_ai
            d["summary_human"] = self.summary_human
        if include_extracted and is_admin:
            d["extracted_text"] = self.extracted_text
        if is_admin:
            d["pdf_md5"]        = self.pdf_md5
            d["source"]         = self.source
            d["pdf_dropbox_path"] = self.dropbox_path
        return d


# ── ArticleChunk (vector index) ──────────────────────────────────────────────
# pgvector type is registered when the `vector` extension is installed and
# pgvector-python is available. We declare it lazily so import doesn't fail
# in dev environments without the package.
try:
    from pgvector.sqlalchemy import Vector  # type: ignore
    _VECTOR_TYPE = Vector(1024)
except Exception:  # pragma: no cover — pgvector-python not installed yet
    _VECTOR_TYPE = None  # column will be ignored by SQLAlchemy until installed


class ArticleChunk(Base):
    __tablename__ = "article_chunk"

    id           = Column(BigInteger, primary_key=True)
    article_id   = Column(UUID(as_uuid=True),
                          ForeignKey("articles.id", ondelete="CASCADE"),
                          nullable=False)
    chunk_index  = Column(Integer, nullable=False)
    source_field = Column(String(20), default="extracted_text", nullable=False)
    chunk_text   = Column(Text, nullable=False)
    tokens       = Column(Integer)
    page_from    = Column(Integer)
    page_to      = Column(Integer)
    if _VECTOR_TYPE is not None:
        embedding = Column(_VECTOR_TYPE)
    created_at   = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("article_id", "chunk_index", "source_field",
                         name="article_chunk_unique"),
    )


# ── Tags ─────────────────────────────────────────────────────────────────────
class ArticleTag(Base):
    __tablename__ = "article_tag"

    id          = Column(BigInteger, primary_key=True)
    name        = Column(String(100), unique=True, nullable=False)
    color       = Column(String(7))
    created_by  = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at  = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "color": self.color}


class ArticleTagLink(Base):
    __tablename__ = "article_tag_link"

    article_id = Column(UUID(as_uuid=True),
                        ForeignKey("articles.id", ondelete="CASCADE"),
                        primary_key=True)
    tag_id     = Column(BigInteger,
                        ForeignKey("article_tag.id", ondelete="CASCADE"),
                        primary_key=True)
    added_by   = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    added_at   = Column(DateTime(timezone=True), default=datetime.utcnow)


# ── Annotations ──────────────────────────────────────────────────────────────
class ArticleAnnotation(Base):
    __tablename__ = "article_annotation"

    id            = Column(BigInteger, primary_key=True)
    article_id    = Column(UUID(as_uuid=True),
                           ForeignKey("articles.id", ondelete="CASCADE"),
                           nullable=False)
    user_id       = Column(UUID(as_uuid=True),
                           ForeignKey("users.id", ondelete="CASCADE"),
                           nullable=False)
    page          = Column(Integer)
    body          = Column(Text, nullable=False)
    is_published  = Column(Boolean, default=False, nullable=False)
    published_at  = Column(DateTime(timezone=True))
    created_at    = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at    = Column(DateTime(timezone=True), default=datetime.utcnow,
                           onupdate=datetime.utcnow, nullable=False)

    def to_dict(self, viewer_user_id=None):
        return {
            "id":           self.id,
            "article_id":   str(self.article_id),
            "user_id":      str(self.user_id),
            "is_own":       str(self.user_id) == str(viewer_user_id) if viewer_user_id else False,
            "is_published": self.is_published,
            "page":         self.page,
            "body":         self.body,
            "created_at":   self.created_at.isoformat() if self.created_at else None,
        }


# ── Ingest queue ─────────────────────────────────────────────────────────────
class IngestJob(Base):
    __tablename__ = "prionvault_ingest_job"

    id            = Column(BigInteger, primary_key=True)
    article_id    = Column(UUID(as_uuid=True),
                           ForeignKey("articles.id", ondelete="SET NULL"))
    pdf_filename  = Column(Text)
    pdf_md5       = Column(CHAR(32))
    status        = Column(String(20), default="queued", nullable=False)
    step          = Column(String(40))
    error         = Column(Text)
    attempts      = Column(Integer, default=0, nullable=False)
    created_by    = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at    = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    started_at    = Column(DateTime(timezone=True))
    finished_at   = Column(DateTime(timezone=True))

    def to_dict(self):
        return {
            "id":           self.id,
            "article_id":   str(self.article_id) if self.article_id else None,
            "pdf_filename": self.pdf_filename,
            "status":       self.status,
            "step":         self.step,
            "error":        self.error,
            "attempts":     self.attempts,
            "created_at":   self.created_at.isoformat() if self.created_at else None,
            "finished_at":  self.finished_at.isoformat() if self.finished_at else None,
        }


# ── Usage / cost tracking ────────────────────────────────────────────────────
class UsageEvent(Base):
    __tablename__ = "prionvault_usage"

    id          = Column(BigInteger, primary_key=True)
    user_id     = Column(UUID(as_uuid=True),
                         ForeignKey("users.id", ondelete="CASCADE"),
                         nullable=False)
    action      = Column(String(40), nullable=False)
    cost_usd    = Column(Numeric(10, 5))
    tokens_in   = Column(Integer)
    tokens_out  = Column(Integer)
    metadata    = Column(JSONB, default=dict)
    created_at  = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
