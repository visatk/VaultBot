import { Env, TgMessage, TgCallbackQuery } from '../types';
import { sendMessage, answerCallback, editMessage } from '../telegram';
import { addNote, listNotes, getNote, deleteNote } from '../db';
import { encrypt, decrypt } from '../crypto';
import { getState, setState, clearState } from '../state';
import { ICONS, escHtml, fmtDate } from '../ui';
import { InlineKeyboard } from '../telegram';

function noteListKeyboard(rows: { id: number; title: string }[]): InlineKeyboard {
  const btns = rows.map(r => [
    { text: `${ICONS.note} ${r.title.slice(0, 35)}`, callback_data: `note:view:${r.id}` },
  ]);
  btns.push([{ text: `${ICONS.add} New Note`, callback_data: 'note:add' }]);
  btns.push([{ text: '🏠 Home', callback_data: 'home' }]);
  return btns;
}

export async function handleNoteCallback(cq: TgCallbackQuery, env: Env, action: string, arg?: string): Promise<void> {
  const userId = cq.from.id;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (action === 'list') {
    const rows = await listNotes(env, userId);
    const text = rows.length
      ? `${ICONS.note} <b>Notes</b> (${rows.length})\n\nSelect a note:`
      : `${ICONS.note} <b>Notes</b>\n\nNo notes yet. Create one!`;
    await editMessage(env, chatId, msgId, text, noteListKeyboard(rows));
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'add') {
    await setState(env, userId, { step: 'NOTE_ADD_TITLE' });
    await editMessage(env, chatId, msgId,
      `${ICONS.add} <b>New Note</b>\n\nSend the <b>title</b> for your note:`,
      [[{ text: `${ICONS.back} Cancel`, callback_data: 'note:list' }]],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'view' && arg) {
    const id = parseInt(arg);
    const row = await getNote(env, id, userId);
    if (!row) { await answerCallback(env, cq.id, 'Not found'); return; }
    const content = await decrypt(row.content, row.iv, env.ENCRYPTION_KEY);
    const lines = [
      `${ICONS.note} <b>${escHtml(row.title)}</b>`,
      ``,
      escHtml(content),
    ];
    if (row.tags) lines.push(`\n${ICONS.tag} ${escHtml(row.tags)}`);
    lines.push(`\n<i>${fmtDate(row.updated_at)}</i>`);
    await editMessage(env, chatId, msgId, lines.join('\n'),
      [
        [{ text: `${ICONS.del} Delete`, callback_data: `note:del:${id}` }],
        [{ text: `${ICONS.back} Back`, callback_data: 'note:list' }],
      ],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'del' && arg) {
    const id = parseInt(arg);
    await deleteNote(env, id, userId);
    const rows = await listNotes(env, userId);
    await editMessage(env, chatId, msgId, `${ICONS.del} Note deleted.\n\n${ICONS.note} <b>Notes</b>`, noteListKeyboard(rows));
    await answerCallback(env, cq.id, 'Deleted');
    return;
  }
}

export async function handleNoteMessage(msg: TgMessage, env: Env): Promise<boolean> {
  const userId = msg.from.id;
  const text = msg.text?.trim() ?? '';
  const state = await getState(env, userId);

  if (state?.step === 'NOTE_ADD_TITLE') {
    await setState(env, userId, { step: 'NOTE_ADD_CONTENT', data: { title: text } });
    await sendMessage(env, msg.chat.id, `${ICONS.check} Title: <b>${escHtml(text)}</b>\n\nNow send the <b>note content</b>:`);
    return true;
  }

  if (state?.step === 'NOTE_ADD_CONTENT') {
    await setState(env, userId, { step: 'NOTE_ADD_TAGS', data: { ...state.data, content: text } });
    await sendMessage(env, msg.chat.id, `${ICONS.check} Content saved.\n\nSend comma-separated <b>tags</b> (e.g. <code>work, ideas</code>), or <code>skip</code>:`);
    return true;
  }

  if (state?.step === 'NOTE_ADD_TAGS') {
    const tags = text === 'skip' ? undefined : text;
    const { ciphertext, iv } = await encrypt(state.data!.content as string, env.ENCRYPTION_KEY);
    await addNote(env, userId, state.data!.title as string, ciphertext, iv, tags);
    await clearState(env, userId);
    await sendMessage(env, msg.chat.id,
      `${ICONS.check} Note "<b>${escHtml(state.data!.title as string)}</b>" saved!\n\nUse /notes to manage notes.`,
    );
    return true;
  }

  return false;
}
