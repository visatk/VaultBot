-- ============================================================
-- VaultBot: 2FA + Password Manager + Notes + Todo + Vault
-- D1 Database Schema v2
-- Apply via: npx wrangler d1 execute <DB_NAME> --file=schema.sql
-- ============================================================

PRAGMA journal_mode = WAL;      -- Write-Ahead Logging for read concurrency
PRAGMA foreign_keys = ON;       -- Enforce referential integrity

-- ── Users ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,            -- Telegram user_id (immutable)
  username    TEXT,                           -- @handle (nullable)
  first_name  TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  is_active   INTEGER NOT NULL DEFAULT 1      -- 0 = banned/blocked
);

-- ── 2FA / TOTP Accounts ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS totp_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,               -- "GitHub – alice@example.com"
  issuer      TEXT    NOT NULL DEFAULT '',    -- "GitHub"
  secret_enc  TEXT    NOT NULL,               -- AES-256-GCM ciphertext (Base64)
  iv          TEXT    NOT NULL,               -- 12-byte IV (hex)
  algorithm   TEXT    NOT NULL DEFAULT 'SHA1',-- SHA1 | SHA256 | SHA512
  digits      INTEGER NOT NULL DEFAULT 6,     -- 6 or 8
  period      INTEGER NOT NULL DEFAULT 30,    -- seconds
  icon        TEXT,                           -- emoji icon
  tags        TEXT    NOT NULL DEFAULT '[]',  -- JSON array of tag strings
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_totp_user       ON totp_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_totp_user_label ON totp_accounts(user_id, label);

-- ── Password Manager ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS passwords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  username     TEXT    NOT NULL DEFAULT '',
  password_enc TEXT    NOT NULL,              -- AES-256-GCM ciphertext (Base64)
  iv           TEXT    NOT NULL,              -- 12-byte IV (hex)
  url          TEXT    NOT NULL DEFAULT '',
  notes        TEXT    NOT NULL DEFAULT '',
  category     TEXT    NOT NULL DEFAULT 'general', -- general | social | finance | work | shopping | gaming | other
  tags         TEXT    NOT NULL DEFAULT '[]',
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_pw_user     ON passwords(user_id);
CREATE INDEX IF NOT EXISTS idx_pw_category ON passwords(user_id, category);
CREATE INDEX IF NOT EXISTS idx_pw_favorite ON passwords(user_id, is_favorite);

-- ── Personal Notes ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL DEFAULT 'Untitled',
  content     TEXT    NOT NULL,
  category    TEXT    NOT NULL DEFAULT 'general',
  tags        TEXT    NOT NULL DEFAULT '[]',
  is_pinned   INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  color       TEXT    NOT NULL DEFAULT '#6366f1',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notes_user    ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_pinned  ON notes(user_id, is_pinned);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(user_id, updated_at DESC);

-- ── To-Do List ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS todos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  is_done     INTEGER NOT NULL DEFAULT 0,
  priority    TEXT    NOT NULL DEFAULT 'normal', -- low | normal | high | urgent
  due_date    INTEGER,                            -- unix timestamp (nullable)
  tags        TEXT    NOT NULL DEFAULT '[]',
  list_name   TEXT    NOT NULL DEFAULT 'inbox',   -- inbox | work | personal | shopping
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  done_at     INTEGER                             -- unix timestamp when completed (nullable)
);

CREATE INDEX IF NOT EXISTS idx_todos_user     ON todos(user_id);
CREATE INDEX IF NOT EXISTS idx_todos_done     ON todos(user_id, is_done);
CREATE INDEX IF NOT EXISTS idx_todos_due      ON todos(user_id, due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(user_id, priority, is_done);

-- ── Private Vault ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vault (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,               -- link | note | image | video | article | file | inspiration | screenshot
  title       TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL,               -- URL or text body (or R2 key for media)
  description TEXT    NOT NULL DEFAULT '',
  source_url  TEXT    NOT NULL DEFAULT '',    -- original source URL for articles/links
  r2_key      TEXT,                           -- R2 object key (nullable)
  r2_url      TEXT,                           -- R2 public/presigned URL (nullable)
  collection  TEXT    NOT NULL DEFAULT 'unsorted',
  tags        TEXT    NOT NULL DEFAULT '[]',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_pinned   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_vault_user       ON vault(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_type       ON vault(user_id, type);
CREATE INDEX IF NOT EXISTS idx_vault_collection ON vault(user_id, collection);
CREATE INDEX IF NOT EXISTS idx_vault_pinned     ON vault(user_id, is_pinned);
CREATE INDEX IF NOT EXISTS idx_vault_created    ON vault(user_id, created_at DESC);

-- ── Bot Session (FSM State) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT    NOT NULL DEFAULT 'idle', -- BotState enum value
  state_data  TEXT    NOT NULL DEFAULT '{}',   -- JSON payload for in-progress flow
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── FTS (optional, add when search volume grows) ─────────────
-- CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content, content='notes', content_rowid='id');
-- CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(title, content, description, content='vault', content_rowid='id');
