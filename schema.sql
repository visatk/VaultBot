-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,          -- Telegram user_id
  username TEXT,
  first_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  vault_locked INTEGER NOT NULL DEFAULT 1,   -- 1 = locked, 0 = unlocked
  master_hash TEXT,                           -- PBKDF2 hash of master password
  master_salt TEXT,                           -- hex salt for PBKDF2
  lock_timeout_min INTEGER NOT NULL DEFAULT 15  -- auto-lock after N minutes
);

-- 2FA / TOTP accounts
CREATE TABLE IF NOT EXISTS totp_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,         -- e.g. "GitHub – john@example.com"
  secret TEXT NOT NULL,        -- encrypted TOTP secret (AES-GCM via Web Crypto)
  iv TEXT NOT NULL,            -- hex IV used for encryption
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Password vault entries
CREATE TABLE IF NOT EXISTS passwords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site TEXT NOT NULL,          -- e.g. "github.com"
  username TEXT NOT NULL,
  password TEXT NOT NULL,      -- encrypted
  iv TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Personal notes
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,       -- encrypted
  iv TEXT NOT NULL,
  tags TEXT,                   -- comma-separated
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- To-Do list
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 1,  -- 1=normal 2=high 3=urgent
  due_date TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Bookmarks / Stash (links, images, videos, articles, screenshots)
CREATE TABLE IF NOT EXISTS stash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,          -- link | image | video | article | note | screenshot
  title TEXT,
  url TEXT,
  content TEXT,                -- text content or file_id for media
  tags TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Session tokens for unlock tracking
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  unlocked_at INTEGER NOT NULL,
  timeout_min INTEGER NOT NULL DEFAULT 15
);
