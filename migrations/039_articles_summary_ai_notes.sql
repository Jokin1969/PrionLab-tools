-- Migration 039: Add summary_ai_notes column to articles table
-- Stores error messages or quality notes for AI summary generation.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS summary_ai_notes TEXT;
