# Dev

### [Join our Telegram Channal](https://t.me/drkingbd)

Simple, safe and open source 2FA Authenticator bot! with password manager and with personal notes. &amp; To-Do List and private place for all your bookmarks, inspiration, notes, articles, images, videos and screenshots.

# 🔒 VaultBot — Personal Security & Productivity Telegram Bot
 
> A simple, safe and open source Telegram bot that serves as your personal encrypted vault.
 
Built on **Cloudflare Workers + D1 + KV** — serverless, zero-maintenance, runs at the edge.
 
---
 
## ✨ Features
 
| Module | What it does |
|--------|-------------|
| 🔑 **2FA Authenticator** | Store TOTP secrets, generate 6-digit codes with countdown timer |
| 🔐 **Password Manager** | Save site credentials encrypted with AES-256-GCM, auto-generate strong passwords |
| 📝 **Encrypted Notes** | Write private notes with tags, all content encrypted at rest |
| ✅ **To-Do List** | Task manager with priorities (Normal / High / Urgent) and due dates |
| 📌 **Stash** | Save links, images, videos, articles, screenshots — forwarded media auto-saved |
 
---
 
## 🛡️ Security Model
 
- **Master password** hashed with PBKDF2-SHA256 (310,000 iterations) — never stored in plaintext
- All secrets (TOTP keys, passwords, note content) encrypted with **AES-256-GCM** before storage
- Server-side encryption key stored as a Cloudflare **secret** (never in source or config)
- **Timing-safe** master password verification via `crypto.subtle`
- Vault **auto-locks** after configurable inactivity (default 15 min)
- Uses `crypto.getRandomValues()` — never `Math.random()` for security operations
- Open source — audit it yourself
