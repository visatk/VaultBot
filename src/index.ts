/**
 * VaultBot — Personal Security & Productivity Telegram Bot
 * Cloudflare Workers + D1 + KV
 */
import { Env, TgUpdate, TgMessage, TgCallbackQuery } from './types';
import { sendMessage, setMyCommands, answerCallback } from './telegram';
import { getOrCreateUser, isUnlocked } from './db';
import { getState, clearState } from './state';
import { homeText, mainMenu, lockedText, ICONS } from './ui';
import { handleVaultSetup, handleVaultMessage, handleVaultCallback } from './handlers/vault';
import { handleOtpCallback, handleOtpMessage } from './handlers/otp';
import { handlePasswordCallback, handlePasswordMessage } from './handlers/passwords';
import { handleNoteCallback, handleNoteMessage } from './handlers/notes';
import { handleTodoCallback, handleTodoMessage } from './handlers/todos';
import { handleStashCallback, handleStashMessage } from './handlers/stash';

async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? '';

  // Ensure user exists
  await getOrCreateUser(env, userId, msg.from.first_name, msg.from.username);

  // /start and /help commands
  if (text === '/start' || text === '/help') {
    await handleVaultSetup(msg, env);
    return;
  }

  if (text === '/lock') {
    const { lockUser } = await import('./db');
    await lockUser(env, userId);
    await sendMessage(env, chatId, lockedText());
    return;
  }

  // Quick command shortcuts (work if unlocked)
  if (['/otp', '/passwords', '/notes', '/todos', '/stash'].includes(text)) {
    const user = await import('./db').then(m => m.getUser(env, userId));
    if (!user?.master_hash) { await handleVaultSetup(msg, env); return; }
    if (!await isUnlocked(env, userId)) { await sendMessage(env, chatId, lockedText()); return; }
    const map: Record<string, string> = { '/otp': 'otp', '/passwords': 'pwd', '/notes': 'note', '/todos': 'todo', '/stash': 'stash' };
    const section = map[text];
    const labels: Record<string, string> = { otp: '2FA Codes', pwd: 'Passwords', note: 'Notes', todo: 'To-Do', stash: 'Stash' };
    const icons: Record<string, string> = { otp: ICONS.key, pwd: ICONS.password, note: ICONS.note, todo: ICONS.todo, stash: ICONS.stash };
    // Redirect via fake callback data handled inline
    const fakeMsg = { ...msg, message_id: msg.message_id };
    await sendMessage(env, chatId, `${icons[section]} Opening <b>${labels[section]}</b>...`);
    // We'll just show home with keyboard pointing to that section
    await sendMessage(env, chatId, homeText(msg.from.first_name), mainMenu());
    return;
  }

  // Vault unlock / setup flow (intercepts text before other handlers)
  const vaultHandled = await handleVaultMessage(msg, env);
  if (vaultHandled) return;

  // Check if vault is unlocked
  const { getUser } = await import('./db');
  const user = await getUser(env, userId);
  if (!user?.master_hash) { await handleVaultSetup(msg, env); return; }
  if (!await isUnlocked(env, userId)) {
    await sendMessage(env, chatId, lockedText());
    return;
  }

  // Route to feature handlers in priority order
  const state = await getState(env, userId);

  if (state?.step?.startsWith('OTP_')) {
    if (await handleOtpMessage(msg, env)) return;
  }
  if (state?.step?.startsWith('PWD_')) {
    if (await handlePasswordMessage(msg, env)) return;
  }
  if (state?.step?.startsWith('NOTE_')) {
    if (await handleNoteMessage(msg, env)) return;
  }
  if (state?.step?.startsWith('TODO_')) {
    if (await handleTodoMessage(msg, env)) return;
  }
  if (state?.step?.startsWith('STASH_')) {
    if (await handleStashMessage(msg, env)) return;
  }

  // Photo / video auto-stash (no state needed, vault must be unlocked)
  if (msg.photo || msg.video) {
    if (await handleStashMessage(msg, env)) return;
  }

  // Auto-URL stash
  if (!state && text.startsWith('http')) {
    if (await handleStashMessage(msg, env)) return;
  }

  // Fallback
  await sendMessage(env, chatId, homeText(msg.from.first_name), mainMenu());
}

async function handleCallbackQuery(cq: TgCallbackQuery, env: Env): Promise<void> {
  const userId = cq.from.id;
  const data = cq.data;

  // Ensure user exists
  await getOrCreateUser(env, userId, cq.from.first_name, cq.from.username);

  // Home button
  if (data === 'home') {
    const { getUser } = await import('./db');
    const user = await getUser(env, userId);
    await import('./telegram').then(({ editMessage }) =>
      editMessage(env, cq.message.chat.id, cq.message.message_id,
        homeText(cq.from.first_name), mainMenu())
    );
    await answerCallback(env, cq.id);
    return;
  }

  // Check vault unlock for all protected actions
  const { getUser } = await import('./db');
  const user = await getUser(env, userId);
  if (!user?.master_hash) {
    await answerCallback(env, cq.id, `${ICONS.lock} Please set up your vault first`);
    return;
  }
  if (!await isUnlocked(env, userId)) {
    await answerCallback(env, cq.id, `${ICONS.lock} Vault is locked — send your master password`);
    return;
  }

  // Route by prefix
  const [prefix, action, arg] = data.split(':');

  if (prefix === 'vault') { await handleVaultCallback(cq, env, action); return; }
  if (prefix === 'otp') { await handleOtpCallback(cq, env, action, arg); return; }
  if (prefix === 'pwd') { await handlePasswordCallback(cq, env, action, arg); return; }
  if (prefix === 'note') { await handleNoteCallback(cq, env, action, arg); return; }
  if (prefix === 'todo') { await handleTodoCallback(cq, env, action, arg); return; }
  if (prefix === 'stash') { await handleStashCallback(cq, env, action, arg); return; }

  await answerCallback(env, cq.id);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook/telegram') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

      const update = await request.json() as TgUpdate;
      ctx.waitUntil((async () => {
        try {
          if (update.message) await handleMessage(update.message, env);
          else if (update.callback_query) await handleCallbackQuery(update.callback_query, env);
        } catch (e) {
          console.error('Handler error:', e);
        }
      })());
      return new Response('OK');
    }

    if (url.pathname === '/init') {
      await setMyCommands(env);
      const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${env.WEBHOOK_URL}/webhook/telegram`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query'],
        }),
      });
      const result = await resp.json();
      return Response.json({ ok: true, webhook: result });
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', name: 'VaultBot', version: '1.0.0' });
    }

    return new Response('VaultBot — Personal Security Vault', { status: 200 });
  },
};
