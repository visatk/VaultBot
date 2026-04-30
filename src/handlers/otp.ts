import { Env, TgMessage, TgCallbackQuery } from '../types';
import { sendMessage, answerCallback, editMessage } from '../telegram';
import { addTotp, listTotps, getTotp, deleteTotp } from '../db';
import { encrypt, decrypt } from '../crypto';
import { generateTOTP, validateBase32Secret, parseOtpAuthUrl, totpProgressBar } from '../totp';
import { getState, setState, clearState } from '../state';
import { backBtn, ICONS, escHtml } from '../ui';
import { InlineKeyboard } from '../telegram';

function otpListKeyboard(rows: { id: number; label: string }[]): InlineKeyboard {
  const btns = rows.map(r => [
    { text: `${ICONS.key} ${r.label.slice(0, 30)}`, callback_data: `otp:view:${r.id}` },
  ]);
  btns.push([{ text: `${ICONS.add} Add Account`, callback_data: 'otp:add' }]);
  btns.push([{ text: '🏠 Home', callback_data: 'home' }]);
  return btns;
}

export async function handleOtpCallback(cq: TgCallbackQuery, env: Env, action: string, arg?: string): Promise<void> {
  const userId = cq.from.id;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (action === 'list') {
    const rows = await listTotps(env, userId);
    const text = rows.length
      ? `${ICONS.key} <b>2FA Accounts</b> (${rows.length})\n\nTap an account to generate its code:`
      : `${ICONS.key} <b>2FA Accounts</b>\n\nNo accounts yet. Add your first one!`;
    await editMessage(env, chatId, msgId, text, otpListKeyboard(rows));
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'add') {
    await setState(env, userId, { step: 'OTP_ADD_SECRET' });
    await editMessage(env, chatId, msgId,
      `${ICONS.add} <b>Add 2FA Account</b>\n\nSend the <b>TOTP secret</b> (base32) or paste a full <code>otpauth://</code> URL from your QR code scanner.`,
      [[{ text: `${ICONS.back} Cancel`, callback_data: 'otp:list' }]],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'view' && arg) {
    const id = parseInt(arg);
    const row = await getTotp(env, id, userId);
    if (!row) { await answerCallback(env, cq.id, 'Not found'); return; }
    const secret = await decrypt(row.secret, row.iv, env.ENCRYPTION_KEY);
    const { code, remainingSec } = generateTOTP(secret);
    const bar = totpProgressBar(remainingSec);
    await editMessage(env, chatId, msgId,
      `${ICONS.key} <b>${escHtml(row.label)}</b>\n\n<code>${code.slice(0,3)} ${code.slice(3)}</code>\n\n${ICONS.timer} ${bar} ${remainingSec}s remaining\n\n<i>Tap 🔄 to refresh</i>`,
      [
        [{ text: '🔄 Refresh', callback_data: `otp:view:${id}` }],
        [{ text: `${ICONS.del} Delete`, callback_data: `otp:del:${id}` }],
        [{ text: `${ICONS.back} Back`, callback_data: 'otp:list' }],
      ],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'del' && arg) {
    const id = parseInt(arg);
    await deleteTotp(env, id, userId);
    const rows = await listTotps(env, userId);
    await editMessage(env, chatId, msgId,
      `${ICONS.del} Account deleted.\n\n${ICONS.key} <b>2FA Accounts</b>`,
      otpListKeyboard(rows),
    );
    await answerCallback(env, cq.id, 'Deleted');
    return;
  }
}

export async function handleOtpMessage(msg: TgMessage, env: Env): Promise<boolean> {
  const userId = msg.from.id;
  const text = msg.text?.trim() ?? '';
  const state = await getState(env, userId);

  if (state?.step === 'OTP_ADD_SECRET') {
    let secret = text;
    let label = 'Unknown';

    const parsed = parseOtpAuthUrl(text);
    if (parsed) {
      secret = parsed.secret;
      label = parsed.label;
    }

    if (!validateBase32Secret(secret)) {
      await sendMessage(env, msg.chat.id, `${ICONS.cross} Invalid secret. Please send a valid base32 string or otpauth:// URL.`);
      return true;
    }

    await setState(env, userId, { step: 'OTP_ADD_LABEL', data: { secret, label } });
    await sendMessage(env, msg.chat.id,
      `${ICONS.check} Secret valid!\n\nSend a <b>label</b> for this account (e.g. <code>GitHub – john@example.com</code>), or send <code>ok</code> to use: <i>${escHtml(label)}</i>`,
    );
    return true;
  }

  if (state?.step === 'OTP_ADD_LABEL') {
    const secret = state.data?.secret as string;
    const defaultLabel = state.data?.label as string;
    const label = text === 'ok' ? defaultLabel : text;

    const { ciphertext, iv } = await encrypt(secret, env.ENCRYPTION_KEY);
    await addTotp(env, userId, label, ciphertext, iv);
    await clearState(env, userId);

    const { code, remainingSec } = generateTOTP(secret);
    await sendMessage(env, msg.chat.id,
      `${ICONS.check} <b>${escHtml(label)}</b> added!\n\nCurrent code: <code>${code.slice(0,3)} ${code.slice(3)}</code> (${remainingSec}s)\n\nUse /otp to see all accounts.`,
    );
    return true;
  }

  return false;
}
