export interface Env {
  // Cloudflare bindings (declared in wrangler.jsonc)
  DB:  D1Database;      // D1 SQLite — primary data store
  KV:  KVNamespace;     // KV — session cache + rate-limit counters
  R2:  R2Bucket;        // R2 — media/file vault storage

  // Secrets (set via: npx wrangler secret put <NAME>)
  BOT_TOKEN:      string;   // Telegram Bot API token
  ENCRYPTION_KEY: string;   // 32-byte hex key for AES-256-GCM
  OWNER_ID:       string;   // Telegram numeric user ID (string form)

  // Vars (set in wrangler.jsonc [vars])
  BOT_USERNAME: string;
}

// ── Telegram API types ────────────────────────────────────────

export interface TgUser {
  id:         number;
  is_bot?:    boolean;
  first_name: string;
  last_name?: string;
  username?:  string;
  language_code?: string;
}

export interface TgChat {
  id:    number;
  type:  'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TgPhotoSize {
  file_id:   string;
  width:     number;
  height:    number;
  file_size?: number;
}

export interface TgVideo {
  file_id:   string;
  duration:  number;
  file_size?: number;
  mime_type?: string;
  thumbnail?: TgPhotoSize;
}

export interface TgDocument {
  file_id:    string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgAudio {
  file_id:   string;
  duration:  number;
  file_name?: string;
  mime_type?: string;
}

export interface TgVoice {
  file_id:   string;
  duration:  number;
  mime_type?: string;
}

export interface TgMessageEntity {
  type:   string;
  offset: number;
  length: number;
  url?:   string;
}

export interface TgMessage {
  message_id:       number;
  from?:            TgUser;
  chat:             TgChat;
  date:             number;
  text?:            string;
  caption?:         string;
  photo?:           TgPhotoSize[];
  video?:           TgVideo;
  document?:        TgDocument;
  audio?:           TgAudio;
  voice?:           TgVoice;
  entities?:        TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  reply_to_message?: TgMessage;
  forward_from?:    TgUser;
  sticker?:         { file_id: string };
}

export interface TgCallbackQuery {
  id:       string;
  from:     TgUser;
  message?: TgMessage;
  data?:    string;
  chat_instance?: string;
}

export interface TgUpdate {
  update_id:       number;
  message?:        TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ── Keyboard types ────────────────────────────────────────────

export interface InlineKeyboardButton {
  text:           string;
  callback_data?: string;
  url?:           string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

// ── D1 row types (mirrors schema.sql) ────────────────────────

export interface DbUser {
  id:         number;
  username:   string | null;
  first_name: string;
  created_at: number;
  last_seen:  number;
  is_active:  number;
}

export interface DbTotp {
  id:         number;
  user_id:    number;
  label:      string;
  issuer:     string;
  secret_enc: string;
  iv:         string;
  algorithm:  string;
  digits:     number;
  period:     number;
  icon:       string | null;
  tags:       string;    // JSON array string
  created_at: number;
  updated_at: number;
}

export interface DbPassword {
  id:           number;
  user_id:      number;
  title:        string;
  username:     string;
  password_enc: string;
  iv:           string;
  url:          string;
  notes:        string;
  category:     string;
  tags:         string;  // JSON array string
  is_favorite:  number;
  created_at:   number;
  updated_at:   number;
}

export interface DbNote {
  id:          number;
  user_id:     number;
  title:       string;
  content:     string;
  category:    string;
  tags:        string;  // JSON array string
  is_pinned:   number;
  is_favorite: number;
  color:       string;
  created_at:  number;
  updated_at:  number;
}

export interface DbTodo {
  id:          number;
  user_id:     number;
  title:       string;
  description: string;
  is_done:     number;
  priority:    string;   // low | normal | high | urgent
  due_date:    number | null;
  tags:        string;   // JSON array string
  list_name:   string;
  created_at:  number;
  updated_at:  number;
  done_at:     number | null;
}

export interface DbVault {
  id:          number;
  user_id:     number;
  type:        string;   // link | note | image | video | article | file | inspiration | screenshot
  title:       string;
  content:     string;
  description: string;
  source_url:  string;
  r2_key:      string | null;
  r2_url:      string | null;
  collection:  string;
  tags:        string;   // JSON array string
  is_favorite: number;
  is_pinned:   number;
  created_at:  number;
  updated_at:  number;
}

export interface DbSession {
  user_id:    number;
  state:      string;
  state_data: string;    // JSON string
  updated_at: number;
}

// ── FSM state machine ─────────────────────────────────────────

export type BotState =
  | 'idle'
  // ── 2FA TOTP ──
  | 'totp_add_label'
  | 'totp_add_secret'
  | 'totp_add_issuer'
  // ── Passwords ──
  | 'pw_add_title'
  | 'pw_add_username'
  | 'pw_add_password'
  | 'pw_add_url'
  | 'pw_add_notes'
  | 'pw_add_category'
  // ── Notes ──
  | 'note_add_title'
  | 'note_add_content'
  | 'note_edit_title'
  | 'note_edit_content'
  // ── Todo ──
  | 'todo_add_title'
  | 'todo_add_description'
  | 'todo_set_due'
  | 'todo_set_priority'
  // ── Vault ──
  | 'vault_add_url'
  | 'vault_add_title'
  | 'vault_waiting_media'
  // ── Search ──
  | 'search_query';

// ── Priority values ───────────────────────────────────────────

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = typeof PRIORITIES[number];
