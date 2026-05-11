import { Env, TgMessage, TgCallbackQuery, StashRow } from '../types';
import { sendMessage, answerCallback, editMessage, deleteMessage } from '../telegram';
import { addStash, listStash, getStash, deleteStash, searchStash } from '../db';
import { getState, setState, clearState } from '../state';
import { ICONS, escHtml, fmtDate, stashTypeIcon } from '../ui';
import { InlineKeyboard } from '../telegram';

const STASH_TYPES = ['link', 'image', 'video', 'article', 'note', 'screenshot'];

function stashText(rows: StashRow[]): string {
  if (!rows.length) return `${ICONS.stash} <b>Stash</b>\n\nEmpty. Save links, images, notes and more!`;
  const lines = [`${ICONS.stash} <b>Stash</b> (${rows.length} items)\n`];
  for (const r of rows) {
    const icon = stashTypeIcon(r.type);
    const title = r.title ? escHtml(r.title.slice(0, 40)) : r.url ? escHtml(r.url.slice(0, 40)) : 'Untitled';
    lines.push(`${icon} ${title}`);
  }
  return lines.join('\n');
}

function stashListKeyboard(rows: StashRow[]): InlineKeyboard {
  const btns = rows.slice(0, 15).map(r => [{
    text: `${stashTypeIcon(r.type)} ${(r.title || r.url || 'Item').slice(0, 30)}`,
    callback_data: `stash:view:${r.id}`,
  }]);
  btns.push([
    { text: `${ICONS.add} Add`, callback_data: 'stash:add' },
    { text: `${ICONS.search} Search`, callback_data: 'stash:search' },
  ]);
  btns.push([
    { text: '🔗 Links', callback_data: 'stash:filter:link' },
    { text: '🖼️ Images', callback_data: 'stash:filter:image' },
    { text: '📰 Articles', callback_data: 'stash:filter:article' },
  ]);
  btns.push([{ text: '🏠 Home', callback_data: 'home' }]);
  return btns;
}

export async function handleStashCallback(cq: TgCallbackQuery, env: Env, action: string, arg?: string): Promise<void> {
  const userId = cq.from.id;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (action === 'list') {
    const rows = await listStash(env, userId);
    await editMessage(env, chatId, msgId, stashText(rows), stashListKeyboard(rows));
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'filter' && arg) {
    const rows = await listStash(env, userId, arg);
    const icon = stashTypeIcon(arg);
    const text = rows.length
      ? `${icon} <b>${arg.charAt(0).toUpperCase() + arg.slice(1)}s</b> (${rows.length})`
      : `${icon} No ${arg}s saved yet.`;
    const btns: InlineKeyboard = rows.slice(0, 15).map(r => [{
      text: `${(r.title || r.url || 'Item').slice(0, 32)}`,
      callback_data: `stash:view:${r.id}`,
    }]);
    btns.push([{ text: `${ICONS.back} Back`, callback_data: 'stash:list' }]);
    await editMessage(env, chatId, msgId, text, btns);
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'add') {
    await setState(env, userId, { step: 'STASH_ADD_TYPE' });
    await editMessage(env, chatId, msgId,
      `${ICONS.add} <b>Add to Stash</b>\n\nYou can also just forward/send any message, link, photo or video and I'll save it automatically!\n\nOr choose a type:`,
      [
        [{ text: '🔗 Link', callback_data: 'stash:type:link' }, { text: '📰 Article', callback_data: 'stash:type:article' }],
        [{ text: '📝 Note', callback_data: 'stash:type:note' }, { text: '📦 Other', callback_data: 'stash:type:note' }],
        [{ text: `${ICONS.back} Cancel`, callback_data: 'stash:list' }],
      ],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'type' && arg) {
    await setState(env, userId, { step: 'STASH_ADD_CONTENT', data: { type: arg } });
    const prompt = arg === 'link' || arg === 'article' ? 'the URL' : 'the content text';
    await editMessage(env, chatId, msgId,
      `${stashTypeIcon(arg)} Send ${prompt}:`,
      [[{ text: `${ICONS.back} Cancel`, callback_data: 'stash:list' }]],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'view' && arg) {
    const id = parseInt(arg);
    const row = await getStash(env, id, userId);
    if (!row) { await answerCallback(env, cq.id, 'Not found'); return; }
    const icon = stashTypeIcon(row.type);
    const lines = [`${icon} <b>${escHtml(row.title || row.type)}</b>\n`];
    if (row.url) lines.push(`🔗 <a href="${escHtml(row.url)}">${escHtml(row.url.slice(0, 60))}</a>`);
    if (row.content && row.type !== 'image' && row.type !== 'video' && row.type !== 'screenshot') {
      lines.push(escHtml(row.content.slice(0, 500)));
    }
    if (row.tags) lines.push(`\n${ICONS.tag} ${escHtml(row.tags)}`);
    lines.push(`\n<i>${fmtDate(row.created_at)}</i>`);
    await editMessage(env, chatId, msgId, lines.join('\n'),
      [
        [{ text: `${ICONS.del} Delete`, callback_data: `stash:del:${id}` }],
        [{ text: `${ICONS.back} Back`, callback_data: 'stash:list' }],
      ],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'del' && arg) {
    await deleteStash(env, parseInt(arg), userId);
    const rows = await listStash(env, userId);
    await editMessage(env, chatId, msgId, `${ICONS.del} Deleted.\n\n${stashText(rows)}`, stashListKeyboard(rows));
    await answerCallback(env, cq.id, 'Deleted');
    return;
  }

  if (action === 'search') {
    await setState(env, userId, { step: 'STASH_SEARCH' });
    await editMessage(env, chatId, msgId,
      `${ICONS.search} <b>Search Stash</b>\n\nSend a search term:`,
      [[{ text: `${ICONS.back} Cancel`, callback_data: 'stash:list' }]],
    );
    await answerCallback(env, cq.id);
    return;
  }
}

export async function handleStashMessage(msg: TgMessage, env: Env): Promise<boolean> {
  const userId = msg.from.id;
  const state = await getState(env, userId);

  // Auto-detect forwarded photos
  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const title = msg.caption || 'Photo';
    await addStash(env, userId, 'image', title, null, fileId);
    await sendMessage(env, msg.chat.id, `${ICONS.image} Saved to stash: <b>${escHtml(title)}</b>`);
    return true;
  }

  if (msg.video) {
    const title = msg.caption || 'Video';
    await addStash(env, userId, 'video', title, null, msg.video.file_id);
    await sendMessage(env, msg.chat.id, `${ICONS.video} Saved to stash: <b>${escHtml(title)}</b>`);
    return true;
  }

  const text = msg.text?.trim() ?? '';

  if (state?.step === 'STASH_SEARCH') {
    await clearState(env, userId);
    const rows = await searchStash(env, userId, text);
    if (!rows.length) {
      await sendMessage(env, msg.chat.id, `${ICONS.search} No results for "<b>${escHtml(text)}</b>".`);
      return true;
    }
    const lines = [`${ICONS.search} <b>Results for "${escHtml(text)}"</b>\n`];
    for (const r of rows) {
      lines.push(`${stashTypeIcon(r.type)} ${escHtml((r.title || r.url || 'Item').slice(0, 50))}`);
    }
    await sendMessage(env, msg.chat.id, lines.join('\n'));
    return true;
  }

  if (state?.step === 'STASH_ADD_CONTENT') {
    const type = state.data?.type as string || 'note';
    const isUrl = text.startsWith('http://') || text.startsWith('https://');
    const finalType = isUrl && type === 'note' ? 'link' : type;
    await addStash(env, userId, finalType, isUrl ? null : text.slice(0, 100), isUrl ? text : null, isUrl ? null : text);
    await clearState(env, userId);
    await sendMessage(env, msg.chat.id, `${stashTypeIcon(finalType)} Saved to stash! Use /stash to browse.`);
    return true;
  }

  // Auto-save URLs from any message
  if (!state && text.startsWith('http')) {
    const isVideo = text.includes('youtube') || text.includes('youtu.be') || text.includes('vimeo');
    const type = isVideo ? 'video' : 'link';
    await addStash(env, userId, type, null, text, null);
    await sendMessage(env, msg.chat.id, `${stashTypeIcon(type)} Link saved to stash!\n\n<a href="${escHtml(text)}">${escHtml(text.slice(0, 60))}</a>`);
    return true;
  }

  return false;
}
