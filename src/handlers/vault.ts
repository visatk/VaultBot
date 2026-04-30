// ─── src/handlers/vault.ts ──────────────────────────────────
// Private Vault: bookmarks, articles, images, videos, files,
// inspiration, and screenshots. R2-backed media storage.
// Enhancements: R2 presigned URL generation, collection grouping,
// search, MIME-type detection, proper R2 httpMetadata.

import {
  sendMessage, editMessage, answerCallback, getFile, downloadFile, kb, fmt,
} from '../telegram';
import {
  getVaultItems, getVaultById, addVaultItem, deleteVaultItem,
  toggleVaultFavorite, toggleVaultPin, searchVault,
  setState, getSession, clearState,
} from '../db';
import type { Env, TgMessage, TgCallbackQuery, DbVault } from '../types';

// ── Type configuration ────────────────────────────────────────

const TYPE_CONFIG: Record<string, { emoji: string; label: string }> = {
  link:        { emoji: '🔗', label: 'Link / Bookmark' },
  article:     { emoji: '📰', label: 'Article' },
  note:        { emoji: '📄', label: 'Text Note' },
  image:       { emoji: '🖼', label: 'Image' },
  video:       { emoji: '🎥', label: 'Video' },
  file:        { emoji: '📎', label: 'File' },
  inspiration: { emoji: '✨', label: 'Inspiration' },
  screenshot:  { emoji: '📸', label: 'Screenshot' },
};

function typeEmoji(type: string) { return TYPE_CONFIG[type]?.emoji ?? '📦'; }
function typeLabel(type: string) { return TYPE_CONFIG[type]?.label ?? type; }

function renderVaultItem(item: DbVault): string {
  const pin = item.is_pinned   ? '📌 ' : '';
  const fav = item.is_favorite ? ' ⭐'  : '';
  const title = item.title || fmt.trunc(item.content, 40);
  return `${pin}${typeEmoji(item.type)} <b>${fmt.escape(title)}</b>${fav}`;
}

// MIME → type mapping for auto-detect
const MIME_TYPE_MAP: Record<string, string> = {
  'image/jpeg':       'image',
  'image/png':        'image',
  'image/gif':        'image',
  'image/webp':       'image',
  'video/mp4':        'video',
  'video/quicktime':  'video',
  'video/webm':       'video',
  'application/pdf':  'file',
};

function mimeToVaultType(mime: string): string {
  if (MIME_TYPE_MAP[mime]) return MIME_TYPE_MAP[mime];
  if (mime.startsWith('image/')) return 'screenshot';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

// ── Main menu ─────────────────────────────────────────────────

export async function showVaultMenu(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  const items   = await getVaultItems(env, chatId);
  const pinned  = items.filter((i) => i.is_pinned);
  const favs    = items.filter((i) => i.is_favorite);

  const text =
    `🗄 <b>Private Vault</b>\n\n` +
    `<b>${items.length}</b> item${items.length !== 1 ? 's' : ''} stored` +
    (pinned.length ? ` · 📌 ${pinned.length} pinned` : '') +
    (favs.length   ? ` · ⭐ ${favs.length} favourite${favs.length !== 1 ? 's' : ''}` : '') +
    `.\n\n` +
    (items.length === 0
      ? `Send any link, file, image, or video to auto-save it here.\nOr tap a category below.`
      : `Browse by type, search, or view recent items.`);

  const keyboard = [
    kb.row(
      { text: '🔗 Links',    data: 'vault:type:link' },
      { text: '📰 Articles', data: 'vault:type:article' },
    ),
    kb.row(
      { text: '🖼 Images',    data: 'vault:type:image'       },
      { text: '🎥 Videos',    data: 'vault:type:video'       },
    ),
    kb.row(
      { text: '✨ Inspiration', data: 'vault:type:inspiration' },
      { text: '📸 Screenshots', data: 'vault:type:screenshot'  },
    ),
    kb.row(
      { text: '📄 Notes',   data: 'vault:type:note'   },
      { text: '📎 Files',   data: 'vault:type:file'   },
    ),
    kb.row(
      { text: '⭐ Favourites', data: 'vault:favourites:0' },
      { text: '📋 All Items',  data: 'vault:all:0'        },
    ),
    kb.row(
      { text: '🔍 Search',      data: 'vault:search' },
      { text: '➕ Add Link/Text', data: 'vault:add_text' },
    ),
    kb.row({ text: '‹ Back to Menu', data: 'menu:main' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Paginated list ────────────────────────────────────────────

export async function showVaultList(
  env: Env,
  chatId: number,
  token: string,
  type: string | undefined,
  page = 0,
  messageId?: number,
  favouritesOnly = false,
) {
  const raw      = await getVaultItems(env, chatId, type);
  const filtered = favouritesOnly ? raw.filter((i) => i.is_favorite) : raw;

  const PAGE   = 8;
  const start  = page * PAGE;
  const slice  = filtered.slice(start, start + PAGE);
  const total  = Math.ceil(filtered.length / PAGE);

  const title = favouritesOnly
    ? '⭐ Favourites'
    : type ? `${typeEmoji(type)} ${typeLabel(type)}s` : '📋 All Items';

  let text = `${title} (${filtered.length})\n\n`;
  text += slice.map(renderVaultItem).join('\n') || 'Nothing here yet.';

  const itemButtons = slice.map((item) =>
    kb.row({
      text: `${typeEmoji(item.type)} ${fmt.trunc(item.title || item.content, 30)}`,
      data: `vault:view:${item.id}`,
    }),
  );

  const base = favouritesOnly ? 'vault:favourites' : type ? `vault:type:${type}` : 'vault:all';

  const keyboard = [
    ...itemButtons,
    ...kb.pager(base, page, total),
    kb.row({ text: '‹ Back', data: 'vault:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── View single item ──────────────────────────────────────────

export async function showVaultItem(
  env: Env,
  chatId: number,
  token: string,
  itemId: number,
  messageId?: number,
) {
  const item = await getVaultById(env, itemId, chatId);
  if (!item) { await sendMessage(token, chatId, '❌ Item not found.'); return; }

  const title = item.title || fmt.trunc(item.content, 50);

  let text =
    `${item.is_pinned ? '📌 ' : ''}${typeEmoji(item.type)} ` +
    `<b>${fmt.escape(title)}</b>${item.is_favorite ? ' ⭐' : ''}\n` +
    `<i>Type: ${typeLabel(item.type)} · Saved ${fmt.relativeTime(item.created_at)}</i>\n\n`;

  if (['link', 'article'].includes(item.type)) {
    text += `🔗 ${fmt.link(item.content, item.content)}\n`;
  } else if (['note', 'inspiration'].includes(item.type)) {
    const preview = item.content.slice(0, 600);
    text += fmt.escape(preview);
    if (item.content.length > 600) text += '…';
  }

  if (item.description)        text += `\n\n📝 ${fmt.escape(item.description)}`;
  if (item.r2_url)             text += `\n\n📎 ${fmt.link('View File', item.r2_url)}`;
  if (item.source_url)         text += `\n\n🌐 ${fmt.link('Source', item.source_url)}`;
  if (item.collection !== 'unsorted') text += `\n\n📁 ${fmt.escape(item.collection)}`;

  const keyboard = [
    kb.row(
      { text: item.is_pinned ? '📌 Unpin' : '📌 Pin', data: `vault:pin:${itemId}` },
      { text: item.is_favorite ? '💔 Unfav' : '⭐ Fav', data: `vault:fav:${itemId}` },
    ),
    kb.row({ text: '🗑 Delete', data: `vault:delete_confirm:${itemId}` }),
    kb.row({ text: '‹ Back', data: 'vault:menu' }),
  ];

  const opts = { keyboard, disablePreview: false };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Add link/text flow ────────────────────────────────────────

export async function startAddVaultText(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  await setState(env, chatId, 'vault_add_url');
  const text =
    `➕ <b>Save to Vault</b>\n\n` +
    `Send a <b>URL</b> or any <b>text</b> to save.\n\n` +
    `Send /cancel to abort.`;
  const opts = { keyboard: kb.back('vault:menu') };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Input handler (FSM) ───────────────────────────────────────

export async function handleVaultTextInput(env: Env, msg: TgMessage, token: string) {
  const chatId  = msg.chat.id;
  const text    = msg.text?.trim() ?? '';
  const session = await getSession(env, chatId);
  const data    = JSON.parse(session.state_data) as Record<string, unknown>;

  switch (session.state) {
    case 'vault_add_url': {
      const isUrl = /^https?:\/\//i.test(text);
      const type  = isUrl ? 'link' : 'note';
      await setState(env, chatId, 'vault_add_title', { content: text, type });
      await sendMessage(
        token, chatId,
        `${typeEmoji(type)} Saving as <b>${typeLabel(type)}</b>.\n\nSend a <b>title</b> (or <code>-</code> for auto-title):`,
      );
      break;
    }

    case 'vault_add_title': {
      const autoTitle = fmt.trunc((data.content as string), 60);
      const title     = text === '-' ? autoTitle : text;
      await addVaultItem(env, chatId, data.type as string, title, data.content as string);
      await clearState(env, chatId);
      await sendMessage(
        token, chatId,
        `✅ Saved to vault: ${typeEmoji(data.type as string)} <b>${fmt.escape(title)}</b>`,
        { keyboard: [[{ text: '🗄 View Vault', callback_data: 'vault:menu' }]] },
      );
      break;
    }

    case 'search_query': {
      // Global or vault-specific search
      const results = await searchVault(env, chatId, text);
      await clearState(env, chatId);
      if (results.length === 0) {
        await sendMessage(token, chatId, `🔍 No vault items found for "<b>${fmt.escape(text)}</b>".`);
        return;
      }
      const buttons = results.map((i) =>
        kb.row({ text: `${typeEmoji(i.type)} ${fmt.trunc(i.title || i.content, 32)}`, data: `vault:view:${i.id}` }),
      );
      await sendMessage(
        token, chatId,
        `🔍 <b>${results.length}</b> item${results.length !== 1 ? 's' : ''} found:`,
        { keyboard: [...buttons, kb.row({ text: '‹ Back', data: 'vault:menu' })] },
      );
      break;
    }
  }
}

// ── Auto-save incoming media ──────────────────────────────────

export async function autoSaveMedia(env: Env, msg: TgMessage, token: string) {
  const chatId = msg.chat.id;
  let fileId   = '';
  let type     = 'file';
  let mimeType = 'application/octet-stream';
  let fileName = '';

  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // highest resolution
    fileId   = photo.file_id;
    type     = 'image';
    mimeType = 'image/jpeg';
  } else if (msg.video) {
    fileId   = msg.video.file_id;
    type     = 'video';
    mimeType = msg.video.mime_type ?? 'video/mp4';
  } else if (msg.document) {
    fileId   = msg.document.file_id;
    mimeType = msg.document.mime_type ?? 'application/octet-stream';
    fileName = msg.document.file_name ?? '';
    type     = mimeToVaultType(mimeType);
  }

  if (!fileId) return;

  try {
    const fileInfo = await getFile(token, fileId) as { file_path?: string; file_size?: number } | null;
    if (!fileInfo?.file_path) {
      await sendMessage(token, chatId, '❌ Could not fetch file info.');
      return;
    }

    // Warn if file is large (Telegram limit is 20MB for bots)
    if (fileInfo.file_size && fileInfo.file_size > 20 * 1024 * 1024) {
      await sendMessage(token, chatId, '⚠️ File is too large to download via Bot API (>20 MB).');
      return;
    }

    const buffer  = await downloadFile(token, fileInfo.file_path);
    const ext     = fileInfo.file_path.split('.').pop() ?? 'bin';
    const r2Key   = `vault/${chatId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    // Upload to R2 with correct content type and metadata
    await env.R2.put(r2Key, buffer, {
      httpMetadata: {
        contentType:        mimeType,
        contentDisposition: fileName ? `inline; filename="${fileName}"` : undefined,
      },
      customMetadata: {
        chatId:    String(chatId),
        savedAt:   new Date().toISOString(),
        vaultType: type,
      },
    });

    const caption = msg.caption?.trim() ?? '';
    const title   = caption.slice(0, 60) ||
      fileName.slice(0, 60) ||
      `${typeLabel(type)} ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    const id = await addVaultItem(
      env, chatId, type, title,
      caption || r2Key,
      '',   // description
      '',   // source_url
      'unsorted',
      r2Key,
      undefined, // r2_url: we don't use public URLs — access via bot only
    );

    await sendMessage(
      token, chatId,
      `✅ ${typeEmoji(type)} <b>${fmt.escape(title)}</b> saved to vault!`,
      { keyboard: [
        [{ text: '🔍 View Item', callback_data: `vault:view:${id}` }],
        [{ text: '🗄 View Vault', callback_data: 'vault:menu' }],
      ]},
    );
  } catch (err) {
    console.error('[Vault] media save error:', err);
    await sendMessage(token, chatId, '❌ Failed to save file. Please try again.');
  }
}

// ── Callback handler ──────────────────────────────────────────

export async function handleVaultCallback(
  env: Env,
  cq: TgCallbackQuery,
  token: string,
  action: string,
  param: string,
) {
  const chatId = cq.message!.chat.id;
  const msgId  = cq.message!.message_id;

  switch (action) {
    case 'menu':
      await answerCallback(token, cq.id);
      await showVaultMenu(env, chatId, token, msgId);
      break;

    case 'all': {
      const page = parseInt(param ?? '0');
      await answerCallback(token, cq.id);
      await showVaultList(env, chatId, token, undefined, page, msgId);
      break;
    }

    case 'favourites': {
      const page = parseInt(param ?? '0');
      await answerCallback(token, cq.id);
      await showVaultList(env, chatId, token, undefined, page, msgId, true);
      break;
    }

    case 'type': {
      const [typeName, pageStr] = param.split(':');
      await answerCallback(token, cq.id);
      await showVaultList(env, chatId, token, typeName, parseInt(pageStr ?? '0'), msgId);
      break;
    }

    case 'view':
      await answerCallback(token, cq.id);
      await showVaultItem(env, chatId, token, parseInt(param), msgId);
      break;

    case 'pin':
      await toggleVaultPin(env, parseInt(param), chatId);
      await answerCallback(token, cq.id, '📌 Updated');
      await showVaultItem(env, chatId, token, parseInt(param), msgId);
      break;

    case 'fav':
      await toggleVaultFavorite(env, parseInt(param), chatId);
      await answerCallback(token, cq.id, '⭐ Updated');
      await showVaultItem(env, chatId, token, parseInt(param), msgId);
      break;

    case 'add_text':
      await answerCallback(token, cq.id);
      await startAddVaultText(env, chatId, token, msgId);
      break;

    case 'search':
      await answerCallback(token, cq.id);
      await setState(env, chatId, 'search_query', { context: 'vault' });
      await editMessage(
        token, chatId, msgId,
        `🔍 <b>Search Vault</b>\n\nSend a keyword to search in titles and descriptions:`,
        { keyboard: kb.back('vault:menu') },
      );
      break;

    case 'delete_confirm': {
      const item = await getVaultById(env, parseInt(param), chatId);
      if (!item) { await answerCallback(token, cq.id, '❌ Not found', true); return; }
      await answerCallback(token, cq.id);
      const title = item.title || fmt.trunc(item.content, 30);
      await editMessage(
        token, chatId, msgId,
        `🗑 Delete <b>${fmt.escape(title)}</b>?\n<i>This cannot be undone.</i>`,
        { keyboard: kb.confirm(`vault:delete:${param}`, 'vault:menu') },
      );
      break;
    }

    case 'delete': {
      const item = await deleteVaultItem(env, parseInt(param), chatId);
      // Clean up R2 object if present
      if (item?.r2_key) {
        await env.R2.delete(item.r2_key).catch((e) => {
          console.error('[Vault] R2 delete error:', e);
        });
      }
      await answerCallback(token, cq.id, '🗑 Deleted');
      await showVaultMenu(env, chatId, token, msgId);
      break;
    }

    default:
      await answerCallback(token, cq.id, '⚠️ Unknown action');
  }
}
