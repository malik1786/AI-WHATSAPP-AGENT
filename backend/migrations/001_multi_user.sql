-- Multi-user auth and data isolation

-- 1. App users (who sign up on the website)
CREATE TABLE IF NOT EXISTS app_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

-- 2. Add user_id to existing tables for isolation
ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES app_users(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES app_users(id);
ALTER TABLE pending_messages ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES app_users(id);
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES app_users(id);
ALTER TABLE away_messages ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES app_users(id);

-- 3. WhatsApp sessions per user
CREATE TABLE IF NOT EXISTS wa_sessions (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES app_users(id) UNIQUE,
  phone TEXT,
  push_name TEXT,
  is_connected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text,
  last_active_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
);

-- Indexes for per-user queries
CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_id);
CREATE INDEX IF NOT EXISTS idx_pending_owner ON pending_messages(owner_id);
