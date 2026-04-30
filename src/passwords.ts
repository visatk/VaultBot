import { Env, TgMessage, TgCallbackQuery } from '../types';
import { sendMessage, answerCallback, editMessage } from '../telegram';
import { addPassword, listPasswords, getPassword, deletePassword } from '../db';
import { encrypt, decrypt, generatePassword } from '../crypto';
import { getState, setState, clearState } from '../state';
import { ICONS, escHtml } from '../ui';
import { InlineKeyboard } from '../telegram';

function pwdListKeyboard(rows: { id: number; site: string; username: string }[]): InlineKeyboard {
  const btns = rows.map(r => [
    { text: `${ICONS.password} ${r.site.slice(0, 22)} · ${r.username.slice(0, 12)}`, callback_data: `pwd:view:${r.id}` },
  ]);
  btns.push([{ text: `${ICONS.add} Add Entry`, callback_data: 'pwd:add' }]);
  btns.push([{ text: '🏠 Home', callback_data: 'home' }]);
  return btns;
}

export async function handlePasswordCallback(cq: TgCallbackQuery, env: Env, action: string, arg?: string): Promise<void> {
  const userId = cq.from.id;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (action === 'list') {
    const rows = await listPasswords(env, userId);
    const text = rows.length
      ? `${ICONS.password} <b>Password Vault</b> (${rows.length} entries)\n\nSelect an entry to reveal:`
      : `${ICONS.password} <b>Password Vault</b>\n\nEmpty. Add your first entry!`;
    await editMessage(env, chatId, msgId, text, pwdListKeyboard(rows));
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'add') {
    await setState(env, userId, { step: 'PWD_ADD_SITE' });
    await editMessage(env, chatId, msgId,
      `${ICONS.add} <b>Add Password Entry</b>\n\nSend the <b>website / service name</b> (e.g. <code>github.com</code>):`,
      [[{ text: `${ICONS.back} Cancel`, callback_data: 'pwd:list' }]],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'view' && arg) {
    const id = parseInt(arg);
    const row = await getPassword(env, id, userId);
    if (!row) { await answerCallback(env, cq.id, 'Not found'); return; }
    const password = await decrypt(row.password, row.iv, env.ENCRYPTION_KEY);
    const lines = [
      `${ICONS.password} <b>${escHtml(row.site)}</b>`,
      ``,
      `👤 <b>Username:</b> <code>${escHtml(row.username)}</code>`,
      `🔑 <b>Password:</b> <code>${escHtml(password)}</code>`,
    ];
    if (row.notes) lines.push(`${ICONS.note} <b>Notes:</b> ${escHtml(row.notes)}`);
    await editMessage(env, chatId, msgId, lines.join('\n'),
      [
        [{ text: `${ICONS.del} Delete`, callback_data: `pwd:del:${id}` }],
        [{ text: `${ICONS.back} Back`, callback_data: 'pwd:list' }],
      ],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'del' && arg) {
    const id = parseInt(arg);
    await deletePassword(env, id, userId);
    const rows = await listPasswords(env, userId);
    await editMessage(env, chatId, msgId, `${ICONS.del} Entry deleted.\n\n${ICONS.password} <b>Password Vault</b>`, pwdListKeyboard(rows));
    await answerCallback(env, cq.id, 'Deleted');
    return;
  }

  if (action === 'gen') {
    const pw = generatePassword(20);
    await editMessage(env, chatId, msgId,
      `${ICONS.gear} <b>Generated Password</b>\n\n<code>${escHtml(pw)}</code>\n\nSend <code>save</code> to continue saving, or send your own password instead.`,
      [[{ text: `${ICONS.back} Cancel`, callback_data: 'pwd:list' }]],
    );
    await setState(env, userId, { ...(await getState(env, userId))!, data: { ...(await getState(env, userId))?.data, gen: pw } });
    await answerCallback(env, cq.id);
    return;
  }
}

export async function handlePasswordMessage(msg: TgMessage, env: Env): Promise<boolean> {
  const userId = msg.from.id;
  const text = msg.text?.trim() ?? '';
  const state = await getState(env, userId);

  if (state?.step === 'PWD_ADD_SITE') {
    await setState(env, userId, { step: 'PWD_ADD_USERNAME', data: { site: text } });
    await sendMessage(env, msg.chat.id, `${ICONS.check} Site: <b>${escHtml(text)}</b>\n\nSend the <b>username / email</b>:`);
    return true;
  }

  if (state?.step === 'PWD_ADD_USERNAME') {
    await setState(env, userId, { step: 'PWD_ADD_PASSWORD', data: { ...state.data, username: text } });
    const pw = generatePassword(20);
    await sendMessage(env, msg.chat.id,
      `${ICONS.check} Username: <b>${escHtml(text)}</b>\n\nSend the <b>password</b>, or use this generated one:\n<code>${escHtml(pw)}</code>`,
      [[{ text: `${ICONS.gear} Use generated`, callback_data: 'pwd:usegen' }]],
    );
    await setState(env, userId, { step: 'PWD_ADD_PASSWORD', data: { ...state.data, username: text, gen: pw } });
    return true;
  }

  if (state?.step === 'PWD_ADD_PASSWORD') {
    const pw = text === 'save' ? (state.data?.gen as string ?? text) : text;
    await setState(env, userId, { step: 'PWD_ADD_NOTES', data: { ...state.data, password: pw } });
    await sendMessage(env, msg.chat.id, `${ICONS.check} Password saved.\n\nSend any <b>notes</b> (optional), or send <code>skip</code>:`);
    return true;
  }

  if (state?.step === 'PWD_ADD_NOTES') {
    const notes = text === 'skip' ? undefined : text;
    const { ciphertext, iv } = await encrypt(state.data!.password as string, env.ENCRYPTION_KEY);
    await addPassword(env, userId, state.data!.site as string, state.data!.username as string, ciphertext, iv, notes);
    await clearState(env, userId);
    await sendMessage(env, msg.chat.id,
      `${ICONS.check} <b>${escHtml(state.data!.site as string)}</b> saved to vault!\n\nUse /passwords to manage entries.`,
    );
    return true;
  }

  if (state?.step === 'PWD_ADD_PASSWORD' && text === 'save') {
    const pw = state.data?.gen as string;
    await setState(env, userId, { step: 'PWD_ADD_NOTES', data: { ...state.data, password: pw } });
    await sendMessage(env, msg.chat.id, `${ICONS.check} Generated password selected.\n\nSend any <b>notes</b> (optional), or <code>skip</code>:`);
    return true;
  }

  return false;
}
