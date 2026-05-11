# 🔒 VaultBot

A private, encrypted Telegram bot running on **Cloudflare Workers** that acts as your personal data vault. All sensitive data is encrypted with **AES-256-GCM** before storage.

## Features

| Feature | Details |
|---------|---------|
| 🔐 2FA Authenticator | TOTP (RFC 6238) with SHA1/256/512, nextCode preview, otpauth:// URI import |
| 🔑 Password Manager | AES-256-GCM encrypted, categories, strength meter, passphrase generator |
| 📝 Notes | Pinned, colored, searchable, inline edit |
| ✅ To-Do List | Priorities, due dates, overdue alerts, list filters |
| 🗄 Private Vault | Links, articles, images, videos, files — R2-backed media storage |
| 🔍 Global Search | Cross-feature search in one D1 `batch()` round-trip |

## Stack

- **Runtime**: [Cloudflare Workers](https://developers.cloudflare.com/workers/) (Node.js compat)
- **Database**: [D1](https://developers.cloudflare.com/d1/) (SQLite at the edge)
- **Cache**: [KV](https://developers.cloudflare.com/kv/) (session caching, 5-min TTL)
- **Storage**: [R2](https://developers.cloudflare.com/r2/) (media files)
- **Crypto**: Web Crypto API — AES-256-GCM, HMAC-SHA1/256/512

## Setup

### 1. Prerequisites

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
# D1 database
npx wrangler d1 create vault

# KV namespace
npx wrangler kv namespace create KV

# R2 bucket
npx wrangler r2 bucket create vault
```

Update the IDs in `wrangler.jsonc` with the values from the output above.

### 3. Apply database schema

```bash
npx wrangler d1 execute vault --file=./schema.sql --remote
```

### 4. Set secrets

```bash
# Your Telegram Bot Token (from @BotFather)
npx wrangler secret put BOT_TOKEN

# 64 hex chars = 32 bytes for AES-256-GCM
# Generate: openssl rand -hex 32
npx wrangler secret put ENCRYPTION_KEY

# Your Telegram numeric user ID (from @userinfobot)
npx wrangler secret put OWNER_ID

# Optional: Webhook security token
# Generate: openssl rand -hex 32
npx wrangler secret put WEBHOOK_SECRET
```

### 5. Update vars

In `wrangler.jsonc`, set `BOT_USERNAME` to your bot's username (without `@`).

### 6. Deploy

```bash
npm run deploy
```

### 7. Register webhook

```
GET https://your-worker.workers.dev/register
```

This sets up the Telegram webhook with your Worker URL and the `WEBHOOK_SECRET` (if configured).

## Development

```bash
npm run dev       # Local Wrangler dev server
npm test          # Run Vitest tests
npm run deploy    # Type-check + deploy
```

## Security

- **Owner-only**: All messages and callbacks are rejected unless `from.id == OWNER_ID`
- **Encrypted storage**: Passwords and TOTP secrets use AES-256-GCM with a random 12-byte IV per operation
- **Webhook secret**: Optional `X-Telegram-Bot-Api-Secret-Token` header validation
- **No plaintext secrets**: All sensitive config is via `wrangler secret put`, never in source

## Architecture

```
Telegram API
     │ POST /webhook
     ▼
Cloudflare Worker (src/index.ts)
     │ ctx.waitUntil(processUpdate)
     ▼
processUpdate
  ├── isOwner() gate
  ├── handleMessage()  ─── FSM state dispatch
  │     ├── handlers/totp.ts
  │     ├── handlers/passwords.ts
  │     ├── handlers/notes.ts
  │     ├── handlers/todos.ts
  │     └── handlers/vault.ts
  └── handleCallback()
        └── (same handlers)

Storage
  ├── D1  — all persistent data (users, totp, passwords, notes, todos, vault, sessions)
  ├── KV  — session cache (5-min TTL), rate counters (1-min TTL)
  └── R2  — media files (images, videos, documents, voice)
```
