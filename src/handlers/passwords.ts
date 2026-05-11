// ─── src/handlers/passwords.ts ──────────────────────────────
// Encrypted password manager handler.
// Enhancements: password strength meter, category filter, search,
// passphrase generator, update category, favourites view.

import { sendMessage, editMessage, answerCallback, kb, fmt } from '../telegram';
import {
  getPasswords, getPasswordById, addPassword, deletePassword,
  togglePasswordFavorite, getFavoritePasswords,
  getSession, setState, clearState,
} from '../db';
import { encrypt, decrypt, generatePassword, generatePassphrase, passwordStrength } from '../crypto';
import type { Env, TgMessage, TgCallbackQuery } from '../types';

const CATEGORIES = ['general', 'social', 'finance', 'work', 'shopping', 'gaming', 'other'];
const CAT_EMOJI: Record<string, string> = {
  general: '🔑', social: '💬', finance: '💳', work: '💼',
  shopping: '🛒', gaming: '🎮', other: '📦',
};
function catEmoji(c: string) { return CAT_EMOJI[c] ?? '🔑'; }

// ── Main menu ─────────────────────────────────────────────────

export async function showPasswordMenu(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  const [all, favs] = await Promise.all([
    getPasswords(env, chatId),
    getFavoritePasswords(env, chatId),
  ]);

  const text =
    `🔑 <b>Password Manager</b>\n\n` +
    `<b>${all.length}</b> credential${all.length !== 1 ? 's' : ''} stored` +
    (favs.length ? ` · ⭐ ${favs.length} favourite${favs.length !== 1 ? 's' : ''}` : '') +
    `.\n\n` +
    (all.length === 0
      ? `Tap <b>Add Password</b> to store your first credential.\n` +
        `<i>All passwords are encrypted with AES-256-GCM before storage.</i>`
      : `Browse by category or search by name.`);

  // Category filter buttons
  const usedCategories = [...new Set(all.map((p) => p.category))];

  const keyboard = [
    ...(favs.length ? [kb.row({ text: '⭐ Favourites', data: 'pw:favourites' })] : []),
    ...(usedCategories.length > 1
      ? [kb.row(...usedCategories.slice(0, 4).map((c) => ({
          text: `${catEmoji(c)} ${c}`,
          data: `pw:category:${c}`,
        })))]
      : []),
    kb.row({ text: '📋 All Passwords', data: 'pw:all:0' }),
    kb.row(
      { text: '➕ Add Password', data: 'pw:add' },
      { text: '⚙️ Generate', data: 'pw:generate' },
    ),
    kb.row({ text: '‹ Back to Menu', data: 'menu:main' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Paginated list ────────────────────────────────────────────

export async function showPasswordList(
  env: Env,
  chatId: number,
  token: string,
  page = 0,
  category?: string,
  favouritesOnly = false,
  messageId?: number,
) {
  const all = favouritesOnly
    ? await getFavoritePasswords(env, chatId)
    : await getPasswords(env, chatId, category);

  const PAGE_SIZE = 8;
  const start       = page * PAGE_SIZE;
  const pageItems   = all.slice(start, start + PAGE_SIZE);
  const totalPages  = Math.ceil(all.length / PAGE_SIZE);

  const title = favouritesOnly
    ? '⭐ Favourites'
    : category ? `${catEmoji(category)} ${category}` : '📋 All Passwords';

  let text = `${title} (${all.length})\n\n`;
  text += pageItems.length
    ? pageItems.map((p) =>
        `${p.is_favorite ? '⭐' : catEmoji(p.category)} <b>${fmt.escape(p.title)}</b>` +
        (p.username ? ` — <code>${fmt.escape(p.username)}</code>` : ''),
      ).join('\n')
    : 'No passwords here.';

  const itemButtons = pageItems.map((p) =>
    kb.row({ text: `${p.is_favorite ? '⭐' : '🔓'} ${fmt.trunc(p.title, 28)}`, data: `pw:view:${p.id}` }),
  );

  const base = favouritesOnly ? 'pw:favourites' : category ? `pw:category:${category}` : 'pw:all';
  const navRows = [
    ...kb.pager(base, page, totalPages),
    kb.row({ text: '‹ Back', data: 'pw:menu' }),
  ];

  const keyboard = [...itemButtons, ...navRows];
  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── View credential ───────────────────────────────────────────

export async function showPasswordDetail(
  env: Env,
  chatId: number,
  token: string,
  pwId: number,
  messageId?: number,
) {
  const pw = await getPasswordById(env, pwId, chatId);
  if (!pw) { await sendMessage(token, chatId, '❌ Not found.'); return; }

  let plainPw = '⚠️ decryption error';
  try {
    plainPw = await decrypt(pw.password_enc, pw.iv, env.ENCRYPTION_KEY);
  } catch { /* intentional */ }

  const { score, label } = passwordStrength(plainPw);
  const strengthBar = '█'.repeat(score + 1) + '░'.repeat(4 - score);
  const strengthLine = `\n🔐 <b>Strength:</b> [${strengthBar}] ${label}`;

  const text =
    `🔑 <b>${fmt.escape(pw.title)}</b>${pw.is_favorite ? ' ⭐' : ''}\n\n` +
    (pw.url ? `🌐 ${fmt.link(pw.url, pw.url)}\n` : '') +
    `👤 <b>Username:</b> ${fmt.code(pw.username || '—')}\n` +
    `🔒 <b>Password:</b> ${fmt.code(plainPw)}` +
    strengthLine + '\n' +
    (pw.notes ? `\n📝 ${fmt.escape(pw.notes)}\n` : '') +
    `\n<i>${catEmoji(pw.category)} ${fmt.escape(pw.category)} · Added ${fmt.date(pw.created_at)}</i>\n` +
    `<i>⚠️ Delete this message or use the bot to view securely.</i>`;

  const keyboard = [
    kb.row(
      { text: pw.is_favorite ? '💔 Unfav' : '⭐ Favourite', data: `pw:fav:${pwId}` },
      { text: '🗑 Delete', data: `pw:delete_confirm:${pwId}` },
    ),
    kb.row({ text: '‹ Back', data: 'pw:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Add flow ──────────────────────────────────────────────────

export async function startAddPassword(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  await setState(env, chatId, 'pw_add_title');
  const text =
    `➕ <b>Add Credential</b>\n\n` +
    `Send the <b>title</b> (e.g. <code>GitHub</code>, <code>Netflix</code>).\n\n` +
    `Send /cancel to abort.`;
  const opts = { keyboard: kb.back('pw:menu') };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

export async function handlePasswordInput(env: Env, msg: TgMessage, token: string) {
  const chatId  = msg.chat.id;
  const text    = msg.text?.trim() ?? '';
  const session = await getSession(env, chatId);
  const data    = JSON.parse(session.state_data) as Record<string, unknown>;

  switch (session.state) {
    case 'pw_add_title':
      await setState(env, chatId, 'pw_add_username', { title: text });
      await sendMessage(token, chatId, `👤 Send the <b>username / email</b> (or <code>-</code> to skip):`);
      break;

    case 'pw_add_username':
      await setState(env, chatId, 'pw_add_password', { ...data, username: text === '-' ? '' : text });
      await sendMessage(
        token, chatId,
        `🔒 Send the <b>password</b>.\n\n` +
        `Or send:\n` +
        `• <code>gen</code> — generate a strong random password\n` +
        `• <code>phrase</code> — generate a memorable passphrase`,
      );
      break;

    case 'pw_add_password': {
      let finalPw: string;
      let preview = '';
      if (text.toLowerCase() === 'gen') {
        finalPw = generatePassword();
        const { score, label } = passwordStrength(finalPw);
        preview = `\n\n🔑 Generated: ${fmt.code(finalPw)}\n🔐 Strength: <b>${label}</b> (${score + 1}/5)`;
      } else if (text.toLowerCase() === 'phrase') {
        finalPw = generatePassphrase(4);
        preview = `\n\n🔑 Passphrase: ${fmt.code(finalPw)}`;
      } else {
        finalPw = text;
        const { score, label } = passwordStrength(finalPw);
        preview = `\n\n🔐 Strength: <b>${label}</b> (${score + 1}/5)`;
      }
      await setState(env, chatId, 'pw_add_url', { ...data, password: finalPw });
      await sendMessage(token, chatId, `🌐 Send the <b>website URL</b> (or <code>-</code> to skip):${preview}`);
      break;
    }

    case 'pw_add_url':
      await setState(env, chatId, 'pw_add_notes', { ...data, url: text === '-' ? '' : text });
      await sendMessage(token, chatId, `📝 Any <b>notes</b>? (or <code>-</code> to skip):`);
      break;

    case 'pw_add_notes': {
      const notes = text === '-' ? '' : text;
      await setState(env, chatId, 'pw_add_category', { ...data, notes });
      const catButtons = CATEGORIES.map((c) => ({ text: `${catEmoji(c)} ${c}`, data: `pw:setcat:${c}` }));
      await sendMessage(
        token, chatId,
        `📁 Choose a <b>category</b>:`,
        {
          keyboard: [
            kb.row(...catButtons.slice(0, 4)),
            kb.row(...catButtons.slice(4)),
          ],
        },
      );
      break;
    }

    case 'pw_add_category': {
      // This state is completed via callback (pw:setcat:*), not text input
      // If user types something here, just treat as 'general'
      await finishAddPassword(env, chatId, token, data, 'general');
      break;
    }
  }
}

async function finishAddPassword(
  env: Env,
  chatId: number,
  token: string,
  data: Record<string, unknown>,
  category: string,
): Promise<void> {
  const { cipherB64, ivHex } = await encrypt(data.password as string, env.ENCRYPTION_KEY);
  const id = await addPassword(
    env, chatId,
    data.title as string,
    data.username as string,
    cipherB64, ivHex,
    data.url as string || '',
    data.notes as string || '',
    category,
  );
  await clearState(env, chatId);
  await sendMessage(token, chatId, `✅ <b>${fmt.escape(data.title as string)}</b> saved!`);
  await showPasswordDetail(env, chatId, token, id);
}

// ── Password generator ────────────────────────────────────────

export async function showPasswordGenerator(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
  mode: 'random' | 'phrase' = 'random',
) {
  const generated = mode === 'phrase' ? generatePassphrase(4) : generatePassword();
  const { score, label } = passwordStrength(generated);
  const strengthBar = '█'.repeat(score + 1) + '░'.repeat(4 - score);

  const text =
    `⚙️ <b>Password Generator</b>\n\n` +
    `${fmt.code(generated)}\n\n` +
    `🔐 Strength: [${strengthBar}] <b>${label}</b>\n` +
    `<i>Tap Regenerate to create a new one.</i>`;

  const keyboard = [
    kb.row(
      { text: '🔄 Random', data: 'pw:gen:random' },
      { text: '📝 Passphrase', data: 'pw:gen:phrase' },
    ),
    kb.row({ text: '‹ Back', data: 'pw:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Callback handler ──────────────────────────────────────────

export async function handlePasswordCallback(
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
      await showPasswordMenu(env, chatId, token, msgId);
      break;

    case 'all': {
      const page = parseInt(param ?? '0');
      await answerCallback(token, cq.id);
      await showPasswordList(env, chatId, token, page, undefined, false, msgId);
      break;
    }

    case 'category': {
      const [cat, pageStr] = param.split(':');
      await answerCallback(token, cq.id);
      await showPasswordList(env, chatId, token, parseInt(pageStr ?? '0'), cat, false, msgId);
      break;
    }

    case 'favourites': {
      const page = parseInt(param ?? '0');
      await answerCallback(token, cq.id);
      await showPasswordList(env, chatId, token, page, undefined, true, msgId);
      break;
    }

    case 'add':
      await answerCallback(token, cq.id);
      await startAddPassword(env, chatId, token, msgId);
      break;

    case 'generate': {
      await answerCallback(token, cq.id);
      await showPasswordGenerator(env, chatId, token, msgId);
      break;
    }

    case 'gen': {
      const mode = param as 'random' | 'phrase';
      await answerCallback(token, cq.id, '🔄 New password…');
      await showPasswordGenerator(env, chatId, token, msgId, mode);
      break;
    }

    case 'view':
      await answerCallback(token, cq.id, '🔓 Decrypting…');
      await showPasswordDetail(env, chatId, token, parseInt(param), msgId);
      break;

    case 'fav':
      await togglePasswordFavorite(env, parseInt(param), chatId);
      await answerCallback(token, cq.id, '⭐ Updated');
      await showPasswordDetail(env, chatId, token, parseInt(param), msgId);
      break;

    case 'setcat': {
      // Called during add flow when user picks category
      const session = await getSession(env, chatId);
      const data = JSON.parse(session.state_data) as Record<string, unknown>;
      await answerCallback(token, cq.id);
      await finishAddPassword(env, chatId, token, data, param);
      break;
    }

    case 'delete_confirm': {
      const pw = await getPasswordById(env, parseInt(param), chatId);
      if (!pw) { await answerCallback(token, cq.id, '❌ Not found', true); return; }
      await answerCallback(token, cq.id);
      await editMessage(
        token, chatId, msgId,
        `🗑 Delete <b>${fmt.escape(pw.title)}</b>?\n<i>This cannot be undone.</i>`,
        { keyboard: kb.confirm(`pw:delete:${param}`, 'pw:menu') },
      );
      break;
    }

    case 'delete':
      await deletePassword(env, parseInt(param), chatId);
      await answerCallback(token, cq.id, '🗑 Deleted');
      await showPasswordMenu(env, chatId, token, msgId);
      break;

    default:
      await answerCallback(token, cq.id, '⚠️ Unknown action');
  }
}
