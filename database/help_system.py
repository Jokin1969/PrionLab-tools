from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, ForeignKey, Table
from sqlalchemy.orm import relationship
from database.config import Base
from datetime import datetime, timezone

# Association table
help_article_tags = Table(
    'help_article_tags', Base.metadata,
    Column('article_id', Integer, ForeignKey('help_articles.id'), primary_key=True),
    Column('tag_id', Integer, ForeignKey('help_tags.id'), primary_key=True)
)


class HelpCategory(Base):
    __tablename__ = 'help_categories'
    id = Column(Integer, primary_key=True)
    name_es = Column(String(100), nullable=False)
    name_en = Column(String(100), nullable=False)
    description_es = Column(Text)
    description_en = Column(Text)
    icon = Column(String(50))
    order_priority = Column(Integer, default=0)
    parent_id = Column(Integer, ForeignKey('help_categories.id'), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    articles = relationship("HelpArticle", back_populates="category")
    children = relationship("HelpCategory", foreign_keys=[parent_id])


class HelpArticle(Base):
    __tablename__ = 'help_articles'
    id = Column(Integer, primary_key=True)
    title_es = Column(String(200), nullable=False)
    title_en = Column(String(200), nullable=False)
    content_es = Column(Text, nullable=False)
    content_en = Column(Text, nullable=False)
    excerpt_es = Column(String(300))
    excerpt_en = Column(String(300))
    slug = Column(String(100), unique=True, nullable=False)
    category_id = Column(Integer, ForeignKey('help_categories.id'))
    page_context = Column(String(100))
    feature_context = Column(String(100))
    difficulty_level = Column(String(20), default='beginner')
    view_count = Column(Integer, default=0)
    is_featured = Column(Boolean, default=False)
    is_published = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    category = relationship("HelpCategory", back_populates="articles")
    tags = relationship("HelpTag", secondary=help_article_tags, back_populates="articles")


class HelpTag(Base):
    __tablename__ = 'help_tags'
    id = Column(Integer, primary_key=True)
    name_es = Column(String(50), nullable=False)
    name_en = Column(String(50), nullable=False)
    color = Column(String(7), default='#3B82F6')
    articles = relationship("HelpArticle", secondary=help_article_tags, back_populates="tags")


class HelpUserProgress(Base):
    __tablename__ = 'help_user_progress'
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False)
    tutorial_id = Column(String(100), nullable=False)
    step_completed = Column(Integer, default=0)
    total_steps = Column(Integer, nullable=False)
    completed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class HelpFeedback(Base):
    __tablename__ = 'help_feedback'
    id = Column(Integer, primary_key=True)
    article_id = Column(Integer, ForeignKey('help_articles.id'), nullable=True)
    user_id = Column(Integer, nullable=True)
    rating = Column(Integer, nullable=False)
    feedback_text = Column(Text)
    is_helpful = Column(Boolean)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
