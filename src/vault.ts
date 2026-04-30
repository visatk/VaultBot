import { Env, TgMessage, TgCallbackQuery } from '../types';
import { sendMessage, answerCallback, editMessage } from '../telegram';
import { getOrCreateUser, getUser, setMasterPassword, lockUser, unlockUser, isUnlocked } from '../db';
import { hashMasterPassword, verifyMasterPassword } from '../crypto';
import { getState, setState, clearState } from '../state';
import { lockedText, homeText, mainMenu, ICONS } from '../ui';

export async function handleVaultSetup(msg: TgMessage, env: Env): Promise<void> {
  const userId = msg.from.id;
  const user = await getOrCreateUser(env, userId, msg.from.first_name, msg.from.username);

  if (!user.master_hash) {
    await setState(env, userId, { step: 'SET_MASTER_1' });
    await sendMessage(env, msg.chat.id,
      `${ICONS.shield} <b>Welcome to VaultBot!</b>\n\nAll your secrets are encrypted with AES-256-GCM before storage.\n\n${ICONS.key} Please send a <b>master password</b> to protect your vault.\n\n<i>Min 8 characters. This cannot be recovered if lost.</i>`,
    );
    return;
  }

  if (await isUnlocked(env, userId)) {
    await sendMessage(env, msg.chat.id, homeText(user.first_name), mainMenu());
    return;
  }

  await sendMessage(env, msg.chat.id, lockedText());
}

export async function handleVaultMessage(msg: TgMessage, env: Env): Promise<boolean> {
  const userId = msg.from.id;
  const text = msg.text?.trim() ?? '';
  const state = await getState(env, userId);

  if (state?.step === 'SET_MASTER_1') {
    if (text.length < 8) {
      await sendMessage(env, msg.chat.id, `${ICONS.warn} Password too short (min 8 chars). Try again:`);
      return true;
    }
    await setState(env, userId, { step: 'SET_MASTER_2', data: { pw: text } });
    await sendMessage(env, msg.chat.id, `${ICONS.check} Good. Send it <b>again</b> to confirm:`);
    return true;
  }

  if (state?.step === 'SET_MASTER_2') {
    const first = state.data?.pw as string;
    if (text !== first) {
      await clearState(env, userId);
      await sendMessage(env, msg.chat.id, `${ICONS.cross} Passwords don't match. Use /start to try again.`);
      return true;
    }
    const { hash, salt } = await hashMasterPassword(text);
    await setMasterPassword(env, userId, hash, salt);
    await unlockUser(env, userId, 15);
    await clearState(env, userId);
    await sendMessage(env, msg.chat.id,
      `${ICONS.unlock} <b>Vault created and unlocked!</b>\n\nAuto-locks after 15 min of inactivity.`,
      mainMenu(),
    );
    return true;
  }

  const user = await getUser(env, userId);
  if (!user?.master_hash) return false;
  if (await isUnlocked(env, userId)) return false;

  const ok = await verifyMasterPassword(text, user.master_hash, user.master_salt!);
  if (ok) {
    await unlockUser(env, userId, user.lock_timeout_min);
    await sendMessage(env, msg.chat.id,
      `${ICONS.unlock} <b>Vault unlocked!</b> Auto-locks in ${user.lock_timeout_min} min.`,
      mainMenu(),
    );
  } else {
    await sendMessage(env, msg.chat.id, `${ICONS.cross} Wrong master password. Try again:`);
  }
  return true;
}

export async function handleVaultCallback(cq: TgCallbackQuery, env: Env, action: string): Promise<void> {
  const userId = cq.from.id;
  if (action === 'lock') {
    await lockUser(env, userId);
    await editMessage(env, cq.message.chat.id, cq.message.message_id, lockedText());
    await answerCallback(env, cq.id, `${ICONS.lock} Vault locked`);
  }
}
