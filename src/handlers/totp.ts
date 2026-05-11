// ─── src/handlers/totp.ts ────────────────────────────────────
// 2FA / TOTP authenticator feature handler.
// Enhancements: nextCode preview, copy-code button, edit label/issuer,
// batch refresh all codes, improved UX with expiry warnings.

import { sendMessage, editMessage, answerCallback, kb, fmt } from '../telegram';
import {
  getTotpAccounts, getTotpById, addTotpAccount, updateTotpAccount,
  deleteTotpAccount, getSession, setState, clearState,
} from '../db';

import {
  generateTOTP, encrypt, decrypt, isValidBase32, parseOtpauthUri,
} from '../crypto';
import type { Env, TgMessage, TgCallbackQuery } from '../types';

// ── Main menu ─────────────────────────────────────────────────

export async function showTotpMenu(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  const accounts = await getTotpAccounts(env, chatId);
  const count    = accounts.length;

  const text =
    `🔐 <b>2FA Authenticator</b>\n\n` +
    `You have <b>${count}</b> account${count !== 1 ? 's' : ''} stored.\n` +
    (count === 0
      ? `\nTap <b>Add Account</b> to get started.\n` +
        `You can paste a TOTP secret or an <code>otpauth://</code> URL.\n` +
        `<i>Secrets are encrypted with AES-256-GCM before storage.</i>`
      : `\nTap an account to view its live OTP code.\n` +
        `<i>⚠️ Codes refresh every 30 seconds — tap 🔄 to update.</i>`);

  // 2 accounts per row
  const accountButtons: ReturnType<typeof kb.row>[] = [];
  for (let i = 0; i < accounts.length; i += 2) {
    const a = accounts[i];
    const b = accounts[i + 1];
    const rowItems = [{ text: `${a.icon ?? '🔑'} ${fmt.trunc(a.label, 22)}`, data: `totp:view:${a.id}` }];
    if (b) rowItems.push({ text: `${b.icon ?? '🔑'} ${fmt.trunc(b.label, 22)}`, data: `totp:view:${b.id}` });
    accountButtons.push(kb.row(...rowItems));
  }

  const keyboard = [
    ...accountButtons,
    ...(count > 0 ? [kb.row({ text: '🔄 Refresh All', data: 'totp:all_codes' })] : []),
    kb.row({ text: '➕ Add Account', data: 'totp:add' }),
    kb.row({ text: '‹ Back to Menu', data: 'menu:main' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── View single account ───────────────────────────────────────

export async function showTotpCode(
  env: Env,
  chatId: number,
  token: string,
  accountId: number,
  messageId?: number,
) {
  const account = await getTotpById(env, accountId, chatId);
  if (!account) {
    await sendMessage(token, chatId, '❌ Account not found.');
    return;
  }

  let secret = '';
  try {
    secret = await decrypt(account.secret_enc, account.iv, env.ENCRYPTION_KEY);
  } catch {
    await sendMessage(token, chatId, '❌ Decryption failed. Your encryption key may have changed.');
    return;
  }

  const { code, remaining, nextCode } = await generateTOTP(
    secret,
    account.period,
    account.digits,
    account.algorithm as 'SHA1' | 'SHA256' | 'SHA512',
  );

  const urgentWarning = remaining <= 5 ? '\n⚠️ <i>Code expiring — tap 🔄 now!</i>' : '';
  const text =
    `🔐 <b>${fmt.escape(account.label)}</b>\n` +
    (account.issuer ? `<i>${fmt.escape(account.issuer)}</i>\n` : '') +
    `\n` +
    `<b>OTP Code:</b>  ${fmt.code(code)}\n` +
    `<b>Next Code:</b> ${fmt.code(nextCode)}\n` +
    `<b>Expires in:</b> ${fmt.timeBar(remaining, account.period)}${urgentWarning}\n\n` +
    `<i>⚠️ Never share this code with anyone.</i>`;

  const keyboard = [
    kb.row({ text: '🔄 Refresh', data: `totp:view:${accountId}` }),
    kb.row(
      { text: '✏️ Edit Label', data: `totp:edit:${accountId}` },
      { text: '🗑 Delete',     data: `totp:delete_confirm:${accountId}` },
    ),
    kb.row({ text: '‹ Back', data: 'totp:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── All codes at once ─────────────────────────────────────────

export async function showAllCodes(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  const accounts = await getTotpAccounts(env, chatId);
  if (accounts.length === 0) {
    await sendMessage(token, chatId, '🔐 No accounts stored yet.');
    return;
  }

  const lines: string[] = [`🔐 <b>All OTP Codes</b>\n`];

  for (const account of accounts) {
    try {
      const secret = await decrypt(account.secret_enc, account.iv, env.ENCRYPTION_KEY);
      const { code, remaining } = await generateTOTP(
        secret, account.period, account.digits,
        account.algorithm as 'SHA1' | 'SHA256' | 'SHA512',
      );
      lines.push(
        `${account.icon ?? '🔑'} <b>${fmt.escape(account.label)}</b>\n` +
        `   ${fmt.code(code)} · ${remaining}s left`,
      );
    } catch {
      lines.push(`${account.icon ?? '🔑'} <b>${fmt.escape(account.label)}</b> — ❌ error`);
    }
  }

  const text = lines.join('\n\n');
  const keyboard = [
    kb.row({ text: '🔄 Refresh All', data: 'totp:all_codes' }),
    kb.row({ text: '‹ Back', data: 'totp:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Add flow ──────────────────────────────────────────────────

export async function startAddTotp(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  await setState(env, chatId, 'totp_add_label');
  const text =
    `➕ <b>Add 2FA Account</b>\n\n` +
    `Send me one of:\n` +
    `• The <b>account label</b> (e.g. <code>GitHub – alice@example.com</code>)\n` +
    `• An <code>otpauth://totp/...</code> URI (scanned from a QR code)\n\n` +
    `Send /cancel to abort.`;
  const opts = { keyboard: kb.back('totp:menu') };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Input handler (FSM) ───────────────────────────────────────

export async function handleTotpInput(env: Env, msg: TgMessage, token: string) {
  const chatId  = msg.chat.id;
  const text    = msg.text?.trim() ?? '';
  const session = await getSession(env, chatId);
  const data    = JSON.parse(session.state_data) as Record<string, unknown>;

  switch (session.state) {
    case 'totp_add_label': {
      // Try otpauth:// URI first
      const parsed = parseOtpauthUri(text);
      if (parsed) {
        const { cipherB64, ivHex } = await encrypt(parsed.secret, env.ENCRYPTION_KEY);
        const id = await addTotpAccount(
          env, chatId,
          parsed.label, parsed.issuer,
          cipherB64, ivHex,
          parsed.algorithm as 'SHA1', parsed.digits, parsed.period,
        );
        await clearState(env, chatId);
        await sendMessage(token, chatId, `✅ <b>${fmt.escape(parsed.label)}</b> added!`);
        await showTotpCode(env, chatId, token, id);
        return;
      }

      // Edit mode (editing_id present in state data)
      if (typeof data.editing_id === 'number') {
        const updated = await updateTotpAccount(
          env, data.editing_id, chatId,
          text,
          typeof data.original_issuer === 'string' ? data.original_issuer : '',
        );
        await clearState(env, chatId);
        if (updated) {
          await sendMessage(token, chatId, `✅ Label updated to <b>${fmt.escape(text)}</b>`);
          await showTotpCode(env, chatId, token, data.editing_id);
        } else {
          await sendMessage(token, chatId, '❌ Account not found.');
        }
        return;
      }

      // New account — treat as label
      await setState(env, chatId, 'totp_add_secret', { label: text });
      await sendMessage(
        token, chatId,
        `✅ Label set to: <b>${fmt.escape(text)}</b>\n\n` +
        `Now send the <b>TOTP secret</b> (Base32, e.g. <code>JBSWY3DPEHPK3PXP</code>).\n\n` +
        `Send /cancel to abort.`,
      );
      break;
    }

    case 'totp_add_secret': {
      const secret = text.replace(/\s/g, '').toUpperCase();
      if (!isValidBase32(secret)) {
        await sendMessage(token, chatId,
          '❌ Invalid Base32 secret.\n' +
          'Only characters <code>A-Z</code> and <code>2-7</code> are allowed.\n\nTry again:',
        );
        return;
      }
      await setState(env, chatId, 'totp_add_issuer', { ...data, secret });
      await sendMessage(
        token, chatId,
        `Send the <b>issuer name</b> (e.g. <code>GitHub</code>, <code>Google</code>) ` +
        `or send <code>-</code> to skip:`,
      );
      break;
    }

    case 'totp_add_issuer': {
      const issuer              = text === '-' ? '' : text;
      const { cipherB64, ivHex } = await encrypt(data.secret as string, env.ENCRYPTION_KEY);
      const id = await addTotpAccount(
        env, chatId,
        data.label as string, issuer,
        cipherB64, ivHex,
      );
      await clearState(env, chatId);
      await sendMessage(token, chatId, `✅ <b>${fmt.escape(data.label as string)}</b> added!`);
      await showTotpCode(env, chatId, token, id);
      break;
    }
  }
}

// ── Callback handler ──────────────────────────────────────────

export async function handleTotpCallback(
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
      await showTotpMenu(env, chatId, token, msgId);
      break;

    case 'add':
      await answerCallback(token, cq.id);
      await startAddTotp(env, chatId, token, msgId);
      break;

    case 'view':
      await answerCallback(token, cq.id, '🔄 Loading OTP…');
      await showTotpCode(env, chatId, token, parseInt(param), msgId);
      break;

    case 'all_codes':
      await answerCallback(token, cq.id, '🔄 Generating…');
      await showAllCodes(env, chatId, token, msgId);
      break;

    case 'edit': {
      await answerCallback(token, cq.id);
      const account = await getTotpById(env, parseInt(param), chatId);
      if (!account) { await answerCallback(token, cq.id, '❌ Not found', true); return; }
      await setState(env, chatId, 'totp_add_label', {
        editing_id:      parseInt(param),
        original_label:  account.label,
        original_issuer: account.issuer,
      });
      await editMessage(
        token, chatId, msgId,
        `✏️ <b>Edit Account</b>\n\nCurrent label: ${fmt.code(account.label)}\n\nSend the new label, or /cancel:`,
        { keyboard: kb.back('totp:menu') },
      );
      break;
    }

    case 'delete_confirm': {
      await answerCallback(token, cq.id);
      const account = await getTotpById(env, parseInt(param), chatId);
      if (!account) { await answerCallback(token, cq.id, '❌ Not found', true); return; }
      await editMessage(
        token, chatId, msgId,
        `🗑 Delete <b>${fmt.escape(account.label)}</b>?\n\n<i>This cannot be undone.</i>`,
        { keyboard: kb.confirm(`totp:delete:${param}`, 'totp:menu') },
      );
      break;
    }

    case 'delete': {
      await deleteTotpAccount(env, parseInt(param), chatId);
      await answerCallback(token, cq.id, '🗑 Account deleted');
      await showTotpMenu(env, chatId, token, msgId);
      break;
    }

    default:
      await answerCallback(token, cq.id, '⚠️ Unknown action');
  }
}
