-- ──────────────────────────────────────────────────────────────────────────────
-- Per-subscription toggle: include the AI summary in the email (PrionVault
-- Picks). Defaults TRUE (mirrors include_pdfs). The email only shows the
-- summary for articles that actually have one.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE prionvault_notification_subscriptions
    ADD COLUMN IF NOT EXISTS include_ai_summary BOOLEAN NOT NULL DEFAULT TRUE;
