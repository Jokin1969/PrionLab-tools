-- PrionBonus tables
-- Run this if the server hasn't restarted since the bonus models were deployed.
-- Sequelize sync({ alter: true }) creates these automatically on startup.

CREATE TABLE IF NOT EXISTS bonus_credits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id     UUID,             -- NULL for non-article credits (e.g. welcome gift)
  pages          INTEGER NOT NULL DEFAULT 0,
  minutes_earned INTEGER NOT NULL,
  note           TEXT,
  notified_at    TIMESTAMP WITH TIME ZONE,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Unique per (user, article) only when article_id is not null
CREATE UNIQUE INDEX IF NOT EXISTS bonus_credits_user_article_uq
  ON bonus_credits (user_id, article_id)
  WHERE article_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bonus_allocations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_type   VARCHAR(50) NOT NULL DEFAULT 'other',
  description TEXT,
  minutes     INTEGER NOT NULL,
  created_by  UUID,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bonus_credits_user_idx       ON bonus_credits (user_id);
CREATE INDEX IF NOT EXISTS bonus_allocations_user_idx   ON bonus_allocations (user_id);
