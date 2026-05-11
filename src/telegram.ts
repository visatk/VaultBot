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
  photo: string,
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
  document: string,
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

// ── File Upload via FormData ──────────────────────────────────

export async function sendDocumentUpload(
  token: string,
  chatId: number,
  fileBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string
) {
  const formData = new FormData();
  formData.append('chat_id', chatId.toString());
  
  const blob = new Blob([fileBuffer], { type: mimeType });
  formData.append('document', blob, fileName);

  try {
    const res = await fetch(`${BASE}${token}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[TG] upload failed: HTTP ${res.status}`, errorText);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[TG] upload network error:`, err);
    return null;
  }
}

// ── Bot info ──────────────────────────────────────────────────

export function getMe(token: string) {
  return call<{ id: number; username: string; first_name: string }>(token, 'getMe', {});
}

// ── Keyboard builders ─────────────────────────────────────────

export const kb = {
  row: (...buttons: Array<{ text: string; data?: string; url?: string }>) =>
    buttons.map((b) =>
      b.url
        ? { text: b.text, url: b.url }
        : { text: b.text, callback_data: b.data ?? b.text },
    ),
  back: (data: string) => [[{ text: '‹ Back', callback_data: data }]],
  close: () => [[{ text: '✕ Close', callback_data: 'close' }]],
  confirm: (confirmData: string, cancelData = 'close') => [
    [
      { text: '✓ Confirm', callback_data: confirmData },
      { text: '✕ Cancel',  callback_data: cancelData  },
    ],
  ],
  pager: (base: string, page: number, totalPages: number) => {
    const row = [];
    if (page > 0)              row.push({ text: '◀ Prev', callback_data: `${base}:${page - 1}` });
    if (page < totalPages - 1) row.push({ text: 'Next ▶', callback_data: `${base}:${page + 1}` });
    return row.length ? [row] : [];
  },
};

// ── HTML Formatters ───────────────────────────────────────────

export const fmt = {
  escape: (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  bold:   (s: string) => `<b>${fmt.escape(s)}</b>`,
  italic: (s: string) => `<i>${fmt.escape(s)}</i>`,
  code:   (s: string) => `<code>${fmt.escape(s)}</code>`,
  pre:    (s: string, lang = '') =>
    `<pre${lang ? ` language="${lang}"` : ''}>${fmt.escape(s)}</pre>`,
  link:   (text: string, url: string) => `<a href="${url}">${fmt.escape(text)}</a>`,
  mono:   (s: string) => `<code>${fmt.escape(s)}</code>`,
  date: (ts: number) =>
    new Date(ts * 1000).toLocaleDateString('en-US', {
      year:   'numeric',
      month:  'short',
      day:    'numeric',
      hour:   '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }) + ' UTC',
  relativeTime: (ts: number): string => {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60)      return 'just now';
    if (diff < 3600)    return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)   return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    return fmt.date(ts);
  },
  priority: (p: string) =>
    ({ low: '🟢', normal: '🔵', high: '🟡', urgent: '🔴' }[p] ?? '⚪'),
  timeBar: (remaining: number, period: number): string => {
    const filled = Math.round((remaining / period) * 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    return `[${bar}] ${remaining}s`;
  },
  trunc: (s: string, maxLen = 60): string =>
    s.length > maxLen ? s.slice(0, maxLen) + '…' : s,
  divider: () => '─'.repeat(20),
};
