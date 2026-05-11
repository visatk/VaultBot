-- ─────────────────────────────────────────────────────────────────────────────
-- VaultBot D1 Schema
-- Apply: npx wrangler d1 execute vault --file=./schema.sql --remote
-- Migrations: npx wrangler d1 migrations apply vault --remote
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Users ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,            -- Telegram user_id (immutable)
  username    TEXT,                           -- @handle (nullable)
  first_name  TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  is_active   INTEGER NOT NULL DEFAULT 1      -- 0 = banned / blocked
);

-- ── 2FA / TOTP Accounts ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS totp_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,               -- "GitHub – alice@example.com"
  issuer      TEXT    NOT NULL DEFAULT '',    -- "GitHub"
  secret_enc  TEXT    NOT NULL,               -- AES-256-GCM ciphertext (Base64)
  iv          TEXT    NOT NULL,               -- 12-byte IV (hex, 24 chars)
  algorithm   TEXT    NOT NULL DEFAULT 'SHA1',-- SHA1 | SHA256 | SHA512
  digits      INTEGER NOT NULL DEFAULT 6,     -- 6 or 8
  period      INTEGER NOT NULL DEFAULT 30,    -- TOTP period in seconds
  icon        TEXT,                           -- emoji icon (nullable)
  tags        TEXT    NOT NULL DEFAULT '[]',  -- JSON array of tag strings
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_totp_user       ON totp_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_totp_user_label ON totp_accounts(user_id, label);

-- ── Password Manager ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS passwords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  username     TEXT    NOT NULL DEFAULT '',
  password_enc TEXT    NOT NULL,              -- AES-256-GCM ciphertext (Base64)
  iv           TEXT    NOT NULL,              -- 12-byte IV (hex, 24 chars)
  url          TEXT    NOT NULL DEFAULT '',
  notes        TEXT    NOT NULL DEFAULT '',
  category     TEXT    NOT NULL DEFAULT 'general',
  tags         TEXT    NOT NULL DEFAULT '[]',
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_pw_user     ON passwords(user_id);
CREATE INDEX IF NOT EXISTS idx_pw_category ON passwords(user_id, category);
CREATE INDEX IF NOT EXISTS idx_pw_favorite ON passwords(user_id, is_favorite) WHERE is_favorite = 1;
CREATE INDEX IF NOT EXISTS idx_pw_updated  ON passwords(user_id, updated_at DESC);

-- ── Personal Notes ────────────────────────────────────────────────────────────

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
CREATE INDEX IF NOT EXISTS idx_notes_pinned  ON notes(user_id, is_pinned) WHERE is_pinned = 1;
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_fav     ON notes(user_id, is_favorite) WHERE is_favorite = 1;

-- ── To-Do List ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS todos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  is_done     INTEGER NOT NULL DEFAULT 0,
  priority    TEXT    NOT NULL DEFAULT 'normal', -- low | normal | high | urgent
  due_date    INTEGER,                            -- Unix timestamp (nullable)
  tags        TEXT    NOT NULL DEFAULT '[]',
  list_name   TEXT    NOT NULL DEFAULT 'inbox',   -- inbox | work | personal | shopping
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  done_at     INTEGER                             -- Unix timestamp when completed (nullable)
);

CREATE INDEX IF NOT EXISTS idx_todos_user     ON todos(user_id);
CREATE INDEX IF NOT EXISTS idx_todos_open     ON todos(user_id, is_done) WHERE is_done = 0;
CREATE INDEX IF NOT EXISTS idx_todos_done     ON todos(user_id, is_done) WHERE is_done = 1;
CREATE INDEX IF NOT EXISTS idx_todos_due      ON todos(user_id, due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_overdue  ON todos(user_id, due_date) WHERE is_done = 0 AND due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(user_id, priority, is_done);

-- ── Private Vault ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vault (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,               -- link|note|image|video|article|file|inspiration|screenshot
  title       TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL,               -- URL, text body, or R2 key for media
  description TEXT    NOT NULL DEFAULT '',
  source_url  TEXT    NOT NULL DEFAULT '',    -- original source URL for articles/links
  r2_key      TEXT,                           -- R2 object key (nullable)
  r2_url      TEXT,                           -- Deprecated: R2 public URL — serve via Worker instead
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
CREATE INDEX IF NOT EXISTS idx_vault_pinned     ON vault(user_id, is_pinned) WHERE is_pinned = 1;
CREATE INDEX IF NOT EXISTS idx_vault_fav        ON vault(user_id, is_favorite) WHERE is_favorite = 1;
CREATE INDEX IF NOT EXISTS idx_vault_created    ON vault(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_r2         ON vault(r2_key) WHERE r2_key IS NOT NULL;

-- ── Bot Session (FSM State) ───────────────────────────────────────────────────
-- Primary store: D1 (durable). Cache layer: KV (fast reads, 5-min TTL).

CREATE TABLE IF NOT EXISTS sessions (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT    NOT NULL DEFAULT 'idle', -- BotState enum value
  state_data  TEXT    NOT NULL DEFAULT '{}',   -- JSON payload for in-progress flow
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── FTS5 Full-Text Search (enable when search volume grows) ──────────────────
-- Enable with: wrangler d1 execute vault --command="..." --remote
-- Or add to a migration file.
--
-- Notes FTS:
-- CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
--   USING fts5(title, content, content='notes', content_rowid='id');
--
-- Triggers to keep FTS in sync:
-- CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
--   INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
-- END;
-- CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
--   INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
--   INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
-- END;
-- CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
--   INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
-- END;
--
-- Vault FTS:
-- CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts
--   USING fts5(title, content, description, content='vault', content_rowid='id');
--
-- Query: SELECT * FROM notes WHERE id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?);
