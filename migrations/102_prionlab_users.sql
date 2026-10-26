-- PrionLab's own user accounts (previously users.csv synced to Dropbox).
-- Deliberately NOT the `users` table: that one belongs to PrionRead
-- (Sequelize schema) and drives its own login.
-- Every field is TEXT with the exact string conventions users.csv used
-- ("true"/"false", ISO dates…), so core/users.py hands callers the same
-- dicts as before. users.csv is still written as a backup snapshot.
CREATE TABLE IF NOT EXISTS prionlab_users (
  username            TEXT NOT NULL,
  password_hash       TEXT NOT NULL DEFAULT '',
  full_name           TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL DEFAULT '',
  role                TEXT NOT NULL DEFAULT 'reader',
  language            TEXT NOT NULL DEFAULT 'es',
  active              TEXT NOT NULL DEFAULT 'true',
  created_at          TEXT NOT NULL DEFAULT '',
  last_login          TEXT NOT NULL DEFAULT '',
  affiliation         TEXT NOT NULL DEFAULT '',
  position            TEXT NOT NULL DEFAULT '',
  research_areas      TEXT NOT NULL DEFAULT '',
  orcid               TEXT NOT NULL DEFAULT '',
  bio                 TEXT NOT NULL DEFAULT '',
  lab_id              TEXT NOT NULL DEFAULT '',
  must_change_pw      TEXT NOT NULL DEFAULT '',
  reset_token         TEXT NOT NULL DEFAULT '',
  reset_token_expires TEXT NOT NULL DEFAULT '',
  api_token_hash      TEXT NOT NULL DEFAULT '',
  is_jc_responsible   TEXT NOT NULL DEFAULT '',
  is_prionvault_admin TEXT NOT NULL DEFAULT '',
  seq                 BIGSERIAL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS prionlab_users_username_uniq ON prionlab_users (lower(username));
CREATE INDEX IF NOT EXISTS prionlab_users_email_idx ON prionlab_users (lower(email));
