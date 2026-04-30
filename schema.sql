PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS users;
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    balance_usd REAL DEFAULT 0.00,
    total_spent_usd REAL DEFAULT 0.00,
    lifetime_cards INTEGER DEFAULT 0,
    referred_by INTEGER,
    referral_earnings_usd REAL DEFAULT 0.00,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- (Keep your existing topups and card_history tables below)
DROP TABLE IF EXISTS topups;
CREATE TABLE topups (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    currency TEXT NOT NULL,
    crypto_amount INTEGER NOT NULL,
    fiat_amount_usd REAL NOT NULL,
    crypto_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

DROP TABLE IF EXISTS card_history;
CREATE TABLE card_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    generation_type TEXT NOT NULL,
    card_count INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    payload TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_topups_status ON topups(status);
CREATE INDEX idx_topups_user ON topups(user_id);
CREATE INDEX idx_history_user ON card_history(user_id);

PRAGMA foreign_keys = ON;
