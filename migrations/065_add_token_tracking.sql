-- SUPERSEDED by 067_add_token_tracking_to_summary_improvement_log.sql
-- This migration attempted to add token/cost tracking columns to summary_improvement_log
-- but had invalid SQL syntax (IF NOT EXISTS doesn't work with multiple columns in ALTER TABLE).
--
-- Migration 067 correctly implements the same functionality with proper idempotency.
-- This file is kept as a no-op for compatibility—systems that already attempted this
-- migration need to mark it as executed without duplicating the work of 067.

SELECT 1;
