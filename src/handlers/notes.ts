// ─── src/handlers/notes.ts ──────────────────────────────────
// Personal notes handler.
// Enhancements: search, colour picker, category filter, favourite toggle,
// full edit title+content, paginated list.

import { sendMessage, editMessage, answerCallback, kb, fmt } from '../telegram';
import {
  getNotes, getNoteById, addNote, updateNote, deleteNote,
  toggleNotePin, toggleNoteFavorite, searchNotes,
  getSession, setState, clearState,
} from '../db';
import type { Env, TgMessage, TgCallbackQuery } from '../types';

const COLORS: Record<string, string> = {
  '#6366f1': '🟣 Indigo',
  '#ec4899': '🩷 Pink',
  '#14b8a6': '🩵 Teal',
  '#f97316': '🟠 Orange',
  '#a855f7': '💜 Purple',
  '#22c55e': '🟢 Green',
};
const COLOR_KEYS = Object.keys(COLORS);

function colorEmoji(color: string) {
  return COLORS[color]?.split(' ')[0] ?? '📝';
}

// ── Main menu ─────────────────────────────────────────────────

export async function showNotesMenu(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  const notes   = await getNotes(env, chatId);
  const pinned  = notes.filter((n) => n.is_pinned);
  const unpinned = notes.filter((n) => !n.is_pinned);
  const favs    = notes.filter((n) => n.is_favorite);

  let text = `📝 <b>Personal Notes</b>\n\n`;
  if (notes.length === 0) {
    text += `No notes yet. Tap <b>New Note</b> to create your first one.`;
  } else {
    text +=
      `<b>${notes.length}</b> note${notes.length !== 1 ? 's' : ''}` +
      (pinned.length ? ` · 📌 ${pinned.length} pinned` : '') +
      (favs.length   ? ` · ⭐ ${favs.length} favourite${favs.length !== 1 ? 's' : ''}` : '') +
      '.';
  }

  // Show pinned first, then latest unpinned — 2 per row
  const display = [...pinned, ...unpinned].slice(0, 16);
  const noteButtons: ReturnType<typeof kb.row>[] = [];
  for (let i = 0; i < display.length; i += 2) {
    const n1 = display[i];
    const n2 = display[i + 1];
    const row = [{ text: `${n1.is_pinned ? '📌' : colorEmoji(n1.color)} ${fmt.trunc(n1.title, 20)}`, data: `note:view:${n1.id}` }];
    if (n2) row.push({ text: `${n2.is_pinned ? '📌' : colorEmoji(n2.color)} ${fmt.trunc(n2.title, 20)}`, data: `note:view:${n2.id}` });
    noteButtons.push(kb.row(...row));
  }
  if (notes.length > 16) {
    noteButtons.push(kb.row({ text: `… ${notes.length - 16} more`, data: 'note:list:0' }));
  }

  const keyboard = [
    ...noteButtons,
    kb.row(
      { text: '➕ New Note', data: 'note:add' },
      { text: '🔍 Search', data: 'note:search' },
    ),
    kb.row({ text: '‹ Back to Menu', data: 'menu:main' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Paginated list ────────────────────────────────────────────

export async function showNotesList(
  env: Env,
  chatId: number,
  token: string,
  page = 0,
  messageId?: number,
) {
  const notes = await getNotes(env, chatId);
  const PAGE  = 8;
  const start = page * PAGE;
  const slice = notes.slice(start, start + PAGE);
  const total = Math.ceil(notes.length / PAGE);

  let text = `📝 <b>All Notes</b> (${notes.length})\n\n`;
  text += slice.map((n) =>
    `${n.is_pinned ? '📌' : colorEmoji(n.color)} <b>${fmt.escape(n.title)}</b> · <i>${fmt.relativeTime(n.updated_at)}</i>`,
  ).join('\n') || 'No notes.';

  const buttons = slice.map((n) =>
    kb.row({ text: `${n.is_pinned ? '📌' : colorEmoji(n.color)} ${fmt.trunc(n.title, 32)}`, data: `note:view:${n.id}` }),
  );

  const keyboard = [
    ...buttons,
    ...kb.pager('note:list', page, total),
    kb.row({ text: '‹ Back', data: 'note:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── View note ─────────────────────────────────────────────────

export async function showNoteDetail(
  env: Env,
  chatId: number,
  token: string,
  noteId: number,
  messageId?: number,
) {
  const note = await getNoteById(env, noteId, chatId);
  if (!note) { await sendMessage(token, chatId, '❌ Note not found.'); return; }

  const preview = note.content.length > 1000
    ? note.content.slice(0, 1000) + '\n<i>…truncated</i>'
    : note.content;

  const text =
    `${note.is_pinned ? '📌 ' : colorEmoji(note.color) + ' '}` +
    `<b>${fmt.escape(note.title)}</b>${note.is_favorite ? ' ⭐' : ''}\n\n` +
    `${fmt.escape(preview)}\n\n` +
    `<i>${fmt.escape(note.category)} · Updated ${fmt.relativeTime(note.updated_at)}</i>`;

  const keyboard = [
    kb.row(
      { text: note.is_pinned ? '📌 Unpin' : '📌 Pin', data: `note:pin:${noteId}` },
      { text: note.is_favorite ? '💔 Unfav' : '⭐ Fav',   data: `note:fav:${noteId}` },
    ),
    kb.row(
      { text: '✏️ Edit Title',   data: `note:edit_title:${noteId}` },
      { text: '✏️ Edit Content', data: `note:edit_content:${noteId}` },
    ),
    kb.row({ text: '🎨 Change Colour', data: `note:colour:${noteId}` }),
    kb.row({ text: '🗑 Delete', data: `note:delete_confirm:${noteId}` }),
    kb.row({ text: '‹ Back', data: 'note:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Add flow ──────────────────────────────────────────────────

export async function startAddNote(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  await setState(env, chatId, 'note_add_title');
  const text =
    `📝 <b>New Note</b>\n\nSend the <b>title</b> for your note.\n\nSend /cancel to abort.`;
  const opts = { keyboard: kb.back('note:menu') };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Input handler (FSM) ───────────────────────────────────────

export async function handleNoteInput(env: Env, msg: TgMessage, token: string) {
  const chatId  = msg.chat.id;
  const text    = msg.text?.trim() ?? '';
  const session = await getSession(env, chatId);
  const data    = JSON.parse(session.state_data) as Record<string, unknown>;

  switch (session.state) {
    case 'note_add_title':
      await setState(env, chatId, 'note_add_content', { title: text });
      await sendMessage(
        token, chatId,
        `✅ Title: <b>${fmt.escape(text)}</b>\n\nNow send the <b>content</b> of your note.\nSend /cancel to abort.`,
      );
      break;

    case 'note_add_content': {
      const id = await addNote(env, chatId, data.title as string, text);
      await clearState(env, chatId);
      await sendMessage(token, chatId, `✅ Note saved!`);
      await showNoteDetail(env, chatId, token, id);
      break;
    }

    case 'note_edit_title': {
      const note = await getNoteById(env, data.id as number, chatId);
      if (!note) { await clearState(env, chatId); return; }
      await updateNote(env, data.id as number, chatId, text, note.content);
      await clearState(env, chatId);
      await sendMessage(token, chatId, `✅ Title updated!`);
      await showNoteDetail(env, chatId, token, data.id as number);
      break;
    }

    case 'note_edit_content': {
      const note = await getNoteById(env, data.id as number, chatId);
      if (!note) { await clearState(env, chatId); return; }
      await updateNote(env, data.id as number, chatId, note.title, text);
      await clearState(env, chatId);
      await sendMessage(token, chatId, `✅ Note updated!`);
      await showNoteDetail(env, chatId, token, data.id as number);
      break;
    }

    case 'search_query': {
      // search_query is shared with global search; handled in index.ts
      // but if routed here specifically for notes:
      const results = await searchNotes(env, chatId, text);
      await clearState(env, chatId);
      if (results.length === 0) {
        await sendMessage(token, chatId, `🔍 No notes found for "<b>${fmt.escape(text)}</b>".`);
        return;
      }
      const buttons = results.map((n) =>
        kb.row({ text: `${colorEmoji(n.color)} ${fmt.trunc(n.title, 34)}`, data: `note:view:${n.id}` }),
      );
      await sendMessage(
        token, chatId,
        `🔍 <b>${results.length}</b> note${results.length !== 1 ? 's' : ''} found:`,
        { keyboard: [...buttons, kb.row({ text: '‹ Back', data: 'note:menu' })] },
      );
      break;
    }
  }
}

// ── Colour picker screen ──────────────────────────────────────

export async function showColourPicker(
  env: Env,
  chatId: number,
  token: string,
  noteId: number,
  messageId?: number,
) {
  const keyboard = [
    kb.row(
      ...COLOR_KEYS.slice(0, 3).map((c) => ({
        text: COLORS[c], data: `note:setcolour:${noteId}:${encodeURIComponent(c)}`,
      })),
    ),
    kb.row(
      ...COLOR_KEYS.slice(3).map((c) => ({
        text: COLORS[c], data: `note:setcolour:${noteId}:${encodeURIComponent(c)}`,
      })),
    ),
    kb.row({ text: '‹ Cancel', data: `note:view:${noteId}` }),
  ];
  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, '🎨 Pick a colour for this note:', opts);
  else           await sendMessage(token, chatId, '🎨 Pick a colour for this note:', opts);
}

// ── Callback handler ──────────────────────────────────────────

export async function handleNoteCallback(
  env: Env,
  cq: TgCallbackQuery,
  token: string,
  action: string,
  param: string,
) {
  const chatId = cq.message!.chat.id;
  const msgId  = cq.message!.message_id;
  const id     = parseInt(param);

  switch (action) {
    case 'menu':
      await answerCallback(token, cq.id);
      await showNotesMenu(env, chatId, token, msgId);
      break;

    case 'list': {
      const page = parseInt(param ?? '0');
      await answerCallback(token, cq.id);
      await showNotesList(env, chatId, token, page, msgId);
      break;
    }

    case 'add':
      await answerCallback(token, cq.id);
      await startAddNote(env, chatId, token, msgId);
      break;

    case 'search':
      await answerCallback(token, cq.id);
      await setState(env, chatId, 'search_query', { context: 'notes' });
      await editMessage(token, chatId, msgId,
        `🔍 <b>Search Notes</b>\n\nSend a keyword to search in titles and content:`,
        { keyboard: kb.back('note:menu') },
      );
      break;

    case 'view':
      await answerCallback(token, cq.id);
      await showNoteDetail(env, chatId, token, id, msgId);
      break;

    case 'pin':
      await toggleNotePin(env, id, chatId);
      await answerCallback(token, cq.id, '📌 Updated');
      await showNoteDetail(env, chatId, token, id, msgId);
      break;

    case 'fav':
      await toggleNoteFavorite(env, id, chatId);
      await answerCallback(token, cq.id, '⭐ Updated');
      await showNoteDetail(env, chatId, token, id, msgId);
      break;

    case 'edit_title': {
      const note = await getNoteById(env, id, chatId);
      if (!note) { await answerCallback(token, cq.id, '❌ Not found', true); return; }
      await setState(env, chatId, 'note_edit_title', { id });
      await answerCallback(token, cq.id);
      await editMessage(
        token, chatId, msgId,
        `✏️ <b>Edit Title</b>\n\nCurrent: ${fmt.code(note.title)}\n\nSend the new title:`,
        { keyboard: kb.back(`note:view:${id}`) },
      );
      break;
    }

    case 'edit_content': {
      const note = await getNoteById(env, id, chatId);
      if (!note) { await answerCallback(token, cq.id, '❌ Not found', true); return; }
      await setState(env, chatId, 'note_edit_content', { id });
      await answerCallback(token, cq.id);
      await editMessage(
        token, chatId, msgId,
        `✏️ <b>Edit Content</b>\n\nSend the new content for "<b>${fmt.escape(note.title)}</b>":`,
        { keyboard: kb.back(`note:view:${id}`) },
      );
      break;
    }

    case 'colour':
      await answerCallback(token, cq.id);
      await showColourPicker(env, chatId, token, id, msgId);
      break;

    case 'setcolour': {
      const [idStr, colorEncoded] = param.split(':');
      const color = decodeURIComponent(colorEncoded);
      await env.DB.prepare(
        'UPDATE notes SET color = ?1, updated_at = unixepoch() WHERE id = ?2 AND user_id = ?3',
      ).bind(color, parseInt(idStr), chatId).run();
      await answerCallback(token, cq.id, '🎨 Colour updated!');
      await showNoteDetail(env, chatId, token, parseInt(idStr), msgId);
      break;
    }

    case 'delete_confirm': {
      const note = await getNoteById(env, id, chatId);
      if (!note) { await answerCallback(token, cq.id, '❌ Not found', true); return; }
      await answerCallback(token, cq.id);
      await editMessage(
        token, chatId, msgId,
        `🗑 Delete <b>${fmt.escape(note.title)}</b>?\n<i>This cannot be undone.</i>`,
        { keyboard: kb.confirm(`note:delete:${id}`, 'note:menu') },
      );
      break;
    }

    case 'delete':
      await deleteNote(env, id, chatId);
      await answerCallback(token, cq.id, '🗑 Deleted');
      await showNotesMenu(env, chatId, token, msgId);
      break;

    default:
      await answerCallback(token, cq.id, '⚠️ Unknown action');
  }
}
