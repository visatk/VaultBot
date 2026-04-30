import type { InlineKeyboard } from './types';

const BASE = 'https://api.telegram.org/bot';

// ── Core fetch helper ─────────────────────────────────────────

async function call<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${token}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    // Network error — log and return null; caller decides how to proceed
    console.error(`[TG] network error on ${method}:`, err);
    return null;
  }

  let json: { ok: boolean; result: T; description?: string; error_code?: number };
  try {
    json = await res.json() as typeof json;
  } catch {
    console.error(`[TG] non-JSON response on ${method}, HTTP ${res.status}`);
    return null;
  }

  if (!json.ok) {
    // Telegram errors are non-fatal — log with structured context
    console.error(`[TG] ${method} failed (${json.error_code ?? res.status}):`, json.description);
    return null;
  }

  return json.result;
}

// ── Message senders ───────────────────────────────────────────

export function sendMessage(
  token: string,
  chatId: number,
  text: string,
  options: {
    keyboard?:      InlineKeyboard;
    parseMode?:     'HTML' | 'Markdown' | 'MarkdownV2';
    disablePreview?: boolean;
    replyTo?:       number;
    silent?:        boolean;
  } = {},
) {
  return call(token, 'sendMessage', {
    chat_id:                  chatId,
    text,
    parse_mode:               options.parseMode ?? 'HTML',
    disable_web_page_preview: options.disablePreview ?? true,
    disable_notification:     options.silent ?? false,
    ...(options.replyTo ? { reply_to_message_id: options.replyTo } : {}),
    ...(options.keyboard
      ? { reply_markup: { inline_keyboard: options.keyboard } }
      : {}),
  });
}

export function editMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  options: {
    keyboard?:      InlineKeyboard;
    parseMode?:     'HTML' | 'Markdown' | 'MarkdownV2';
    disablePreview?: boolean;
  } = {},
) {
  return call(token, 'editMessageText', {
    chat_id:                  chatId,
    message_id:               messageId,
    text,
    parse_mode:               options.parseMode ?? 'HTML',
    disable_web_page_preview: options.disablePreview ?? true,
    ...(options.keyboard
      ? { reply_markup: { inline_keyboard: options.keyboard } }
      : {}),
  });
}

export function editKeyboard(
  token: string,
  chatId: number,
  messageId: number,
  keyboard: InlineKeyboard,
) {
  return call(token, 'editMessageReplyMarkup', {
    chat_id:      chatId,
    message_id:   messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
}

export function answerCallback(
  token: string,
  callbackId: string,
  text?: string,
  showAlert = false,
) {
  return call(token, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
    show_alert: showAlert,
  });
}

export function deleteMessage(token: string, chatId: number, messageId: number) {
  return call(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function sendChatAction(
  token: string,
  chatId: number,
  action:
    | 'typing'
    | 'upload_photo'
    | 'upload_document'
    | 'find_location' = 'typing',
) {
  return call(token, 'sendChatAction', { chat_id: chatId, action });
}

export function sendPhoto(
  token: string,
  chatId: number,
  photo: string,             // file_id or URL
  options: {
    caption?:   string;
    keyboard?:  InlineKeyboard;
    parseMode?: 'HTML' | 'MarkdownV2';
  } = {},
) {
  return call(token, 'sendPhoto', {
    chat_id:    chatId,
    photo,
    ...(options.caption   ? { caption: options.caption, parse_mode: options.parseMode ?? 'HTML' } : {}),
    ...(options.keyboard  ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
  });
}

export function sendDocument(
  token: string,
  chatId: number,
  document: string,          // file_id
  options: {
    caption?:  string;
    keyboard?: InlineKeyboard;
  } = {},
) {
  return call(token, 'sendDocument', {
    chat_id:  chatId,
    document,
    ...(options.caption  ? { caption: options.caption, parse_mode: 'HTML' } : {}),
    ...(options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
  });
}

export function forwardMessage(
  token: string,
  toChatId: number,
  fromChatId: number,
  messageId: number,
) {
  return call(token, 'forwardMessage', {
    chat_id:      toChatId,
    from_chat_id: fromChatId,
    message_id:   messageId,
  });
}

// ── File utilities ────────────────────────────────────────────

export function getFile(token: string, fileId: string) {
  return call<{ file_path?: string; file_size?: number }>(token, 'getFile', { file_id: fileId });
}

export async function downloadFile(token: string, filePath: string): Promise<ArrayBuffer> {
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`[TG] download failed: HTTP ${res.status}`);
  return res.arrayBuffer();
}

// ── Bot info ──────────────────────────────────────────────────

export function getMe(token: string) {
  return call<{ id: number; username: string; first_name: string }>(token, 'getMe', {});
}

// ── Keyboard builders ─────────────────────────────────────────

export const kb = {
  /** Single row of buttons */
  row: (...buttons: Array<{ text: string; data?: string; url?: string }>) =>
    buttons.map((b) =>
      b.url
        ? { text: b.text, url: b.url }
        : { text: b.text, callback_data: b.data ?? b.text },
    ),

  /** Back button shorthand */
  back: (data: string) => [[{ text: '‹ Back', callback_data: data }]],

  /** Close/dismiss button */
  close: () => [[{ text: '✕ Close', callback_data: 'close' }]],

  /** Confirm / Cancel pair */
  confirm: (confirmData: string, cancelData = 'close') => [
    [
      { text: '✓ Confirm', callback_data: confirmData },
      { text: '✕ Cancel',  callback_data: cancelData  },
    ],
  ],

  /** Pagination row — omits buttons that aren't needed */
  pager: (base: string, page: number, totalPages: number) => {
    const row = [];
    if (page > 0)              row.push({ text: '◀ Prev', callback_data: `${base}:${page - 1}` });
    if (page < totalPages - 1) row.push({ text: 'Next ▶', callback_data: `${base}:${page + 1}` });
    return row.length ? [row] : [];
  },
};

// ── HTML Formatters ───────────────────────────────────────────

export const fmt = {
  /** Escape special HTML characters for Telegram HTML parse mode */
  escape: (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),

  bold:   (s: string) => `<b>${fmt.escape(s)}</b>`,
  italic: (s: string) => `<i>${fmt.escape(s)}</i>`,
  code:   (s: string) => `<code>${fmt.escape(s)}</code>`,
  pre:    (s: string, lang = '') =>
    `<pre${lang ? ` language="${lang}"` : ''}>${fmt.escape(s)}</pre>`,
  link:   (text: string, url: string) => `<a href="${url}">${fmt.escape(text)}</a>`,
  mono:   (s: string) => `<code>${fmt.escape(s)}</code>`,

  /** Format Unix timestamp → human-readable UTC date */
  date: (ts: number) =>
    new Date(ts * 1000).toLocaleDateString('en-US', {
      year:   'numeric',
      month:  'short',
      day:    'numeric',
      hour:   '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }) + ' UTC',

  /** Relative time (e.g. "2 hours ago") */
  relativeTime: (ts: number): string => {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60)      return 'just now';
    if (diff < 3600)    return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)   return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    return fmt.date(ts);
  },

  /** Priority badge */
  priority: (p: string) =>
    ({ low: '🟢', normal: '🔵', high: '🟡', urgent: '🔴' }[p] ?? '⚪'),

  /** TOTP progress bar */
  timeBar: (remaining: number, period: number): string => {
    const filled = Math.round((remaining / period) * 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    return `[${bar}] ${remaining}s`;
  },

  /** Truncate a string to maxLen, appending ellipsis */
  trunc: (s: string, maxLen = 60): string =>
    s.length > maxLen ? s.slice(0, maxLen) + '…' : s,

  /** Section divider */
  divider: () => '─'.repeat(20),
};
