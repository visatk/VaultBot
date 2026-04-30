import { sendMessage, answerCallback, fmt } from './telegram';
import {
  upsertUser, getUser, getSession, setState, clearState, getUserStats, globalSearch,
} from './db';
import type { Env, TgUpdate, TgMessage, TgCallbackQuery } from './types';

// Feature handlers
import { showTotpMenu, handleTotpCallback, handleTotpInput } from './handlers/totp';
import { showPasswordMenu, handlePasswordCallback, handlePasswordInput } from './handlers/passwords';
import { showNotesMenu, handleNoteCallback, handleNoteInput } from './handlers/notes';
import { showTodoMenu, handleTodoCallback, handleTodoInput } from './handlers/todos';
import { showVaultMenu, handleVaultCallback, handleVaultTextInput, autoSaveMedia } from './handlers/vault';

// ── Authorization ─────────────────────────────────────────────

function isOwner(env: Env, userId: number): boolean {
  return String(userId) === env.OWNER_ID;
}

// ── Main menu ─────────────────────────────────────────────────

async function showMainMenu(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
  greet = false,
) {
  const [user, stats] = await Promise.all([
    getUser(env, chatId),
    getUserStats(env, chatId),
  ]);

  const name = user?.first_name ?? 'there';
  const greeting = greet
    ? `👋 Welcome back, <b>${fmt.escape(name)}</b>!\n\n`
    : '';

  const overdueLine = stats.overdue > 0
    ? `\n🔥 <b>${stats.overdue}</b> overdue task${stats.overdue !== 1 ? 's' : ''}!`
    : '';

  const text =
    `${greeting}🏠 <b>🔒 Your encrypted personal vault</b> — Dev @DrkingBD\n\n` +
    `🔐 2FA Accounts: <b>${stats.totp}</b>\n` +
    `🔑 Passwords:    <b>${stats.passwords}</b>\n` +
    `📝 Notes:        <b>${stats.notes}</b>\n` +
    `✅ Tasks:        <b>${stats.todos_open}</b> open · ${stats.todos_done} done${overdueLine}\n` +
    `🗄 Vault:        <b>${stats.vault}</b> item${stats.vault !== 1 ? 's' : ''}\n\n` +
    `<i>Everything is encrypted and private.</i>`;

  const keyboard = [
    [
      { text: '🔐 2FA',       callback_data: 'totp:menu'   },
      { text: '🔑 Passwords', callback_data: 'pw:menu'     },
    ],
    [
      { text: '📝 Notes',  callback_data: 'note:menu'  },
      { text: '✅ Tasks',  callback_data: 'todo:menu'  },
    ],
    [
      { text: '🗄 Vault',   callback_data: 'vault:menu' },
      { text: '🔍 Search',  callback_data: 'menu:search' },
    ],
    [
      { text: '⚙️ Settings', callback_data: 'menu:settings' },
    ],
  ];

  if (messageId) {
    const { editMessage } = await import('./telegram');
    await editMessage(token, chatId, messageId, text, { keyboard });
  } else {
    await sendMessage(token, chatId, text, { keyboard });
  }
}

// ── Settings menu ─────────────────────────────────────────────

async function showSettingsMenu(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  const text =
    `⚙️ <b>Settings</b>\n\n` +
    `<b>Bot:</b> VaultBot\n` +
    `<b>Owner ID:</b> <code>${env.OWNER_ID}</code>\n\n` +
    `<b>Security</b>\n` +
    `• Encryption: AES-256-GCM\n` +
    `• TOTP: RFC 6238\n` +
    `• Storage: Cloudflare D1 + R2\n\n` +
    `<i>All data is owner-only and end-to-end encrypted.</i>`;

  const keyboard = [
    [{ text: '🔄 Reset Session', callback_data: 'menu:reset_session' }],
    [{ text: '‹ Back to Menu',   callback_data: 'menu:main' }],
  ];

  if (messageId) {
    const { editMessage } = await import('./telegram');
    await editMessage(token, chatId, messageId, text, { keyboard });
  } else {
    await sendMessage(token, chatId, text, { keyboard });
  }
}

// ── Global search ─────────────────────────────────────────────

async function handleGlobalSearch(
  env: Env,
  chatId: number,
  token: string,
  query: string,
) {
  const results = await globalSearch(env, chatId, query);
  const total   =
    results.notes.length + results.todos.length +
    results.vault.length + results.passwords.length;

  if (total === 0) {
    await sendMessage(
      token, chatId,
      `🔍 No results found for "<b>${fmt.escape(query)}</b>".`,
      { keyboard: [[{ text: '‹ Main Menu', callback_data: 'menu:main' }]] },
    );
    return;
  }

  let text = `🔍 <b>Search: "${fmt.escape(query)}"</b>\n<i>${total} result${total !== 1 ? 's' : ''}</i>\n`;

  const buttons: Array<{ text: string; callback_data: string }[]> = [];

  if (results.notes.length) {
    text += `\n📝 <b>Notes (${results.notes.length})</b>`;
    for (const n of results.notes) {
      buttons.push([{ text: `📝 ${fmt.trunc(n.title, 36)}`, callback_data: `note:view:${n.id}` }]);
    }
  }
  if (results.todos.length) {
    text += `\n✅ <b>Tasks (${results.todos.length})</b>`;
    for (const t of results.todos) {
      buttons.push([{ text: `${fmt.priority(t.priority)} ${fmt.trunc(t.title, 36)}`, callback_data: `todo:view:${t.id}` }]);
    }
  }
  if (results.vault.length) {
    text += `\n🗄 <b>Vault (${results.vault.length})</b>`;
    for (const v of results.vault) {
      const tit = v.title || fmt.trunc(v.content, 36);
      buttons.push([{ text: `🗄 ${fmt.trunc(tit, 36)}`, callback_data: `vault:view:${v.id}` }]);
    }
  }
  if (results.passwords.length) {
    text += `\n🔑 <b>Passwords (${results.passwords.length})</b>`;
    for (const p of results.passwords) {
      buttons.push([{ text: `🔑 ${fmt.trunc(p.title, 36)}`, callback_data: `pw:view:${p.id}` }]);
    }
  }

  buttons.push([{ text: '‹ Main Menu', callback_data: 'menu:main' }]);
  await sendMessage(token, chatId, text, { keyboard: buttons });
}

// ── Command handler ───────────────────────────────────────────

async function handleCommand(env: Env, msg: TgMessage, token: string) {
  const chatId = msg.chat.id;
  const cmd    = (msg.text ?? '').split('@')[0].split(' ')[0].toLowerCase();

  switch (cmd) {
    case '/start':
    case '/menu':
      await showMainMenu(env, chatId, token, undefined, cmd === '/start');
      break;

    case '/cancel': {
      const session = await getSession(env, chatId);
      if (session.state !== 'idle') {
        await clearState(env, chatId);
        await sendMessage(token, chatId, '❌ Cancelled.', {
          keyboard: [[{ text: '‹ Main Menu', callback_data: 'menu:main' }]],
        });
      } else {
        await sendMessage(token, chatId, 'No active operation to cancel.');
      }
      break;
    }

    case '/totp':
      await showTotpMenu(env, chatId, token);
      break;

    case '/passwords':
    case '/pw':
      await showPasswordMenu(env, chatId, token);
      break;

    case '/notes':
      await showNotesMenu(env, chatId, token);
      break;

    case '/todos':
    case '/tasks':
      await showTodoMenu(env, chatId, token);
      break;

    case '/vault':
      await showVaultMenu(env, chatId, token);
      break;

    case '/help':
      await sendMessage(token, chatId,
        `🤖 <b>VaultBot Commands</b>\n\n` +
        `/start — Main menu\n` +
        `/totp — 2FA authenticator\n` +
        `/passwords — Password manager\n` +
        `/notes — Personal notes\n` +
        `/tasks — To-do list\n` +
        `/vault — Private media vault\n` +
        `/cancel — Cancel current operation\n` +
        `/help — This message`,
      );
      break;

    default:
      await sendMessage(token, chatId, `❓ Unknown command. Try /help for a list of commands.`);
  }
}

// ── Message router ────────────────────────────────────────────

async function handleMessage(env: Env, msg: TgMessage, token: string) {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim() ?? '';

  // Upsert user on every message
  if (msg.from) {
    await upsertUser(env, msg.from.id, msg.from.first_name, msg.from.username);
  }

  // Commands
  if (text.startsWith('/')) {
    await handleCommand(env, msg, token);
    return;
  }

  // Check session state
  const session = await getSession(env, chatId);

  // Media auto-save (no state required)
  if (msg.photo || msg.video || msg.document) {
    if (session.state === 'idle') {
      await autoSaveMedia(env, msg, token);
      return;
    }
  }

  // Idle state — show help prompt
  if (session.state === 'idle') {
    await sendMessage(
      token, chatId,
      `💡 Use /menu to navigate or tap a feature button.\nSend /help for all commands.`,
      { keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] },
    );
    return;
  }

  // Global search handling
  if (session.state === 'search_query') {
    const data    = JSON.parse(session.state_data) as { context?: string };
    const context = data.context;
    await clearState(env, chatId);

    if (context === 'notes') {
      await handleNoteInput(env, msg, token);
    } else if (context === 'vault') {
      await handleVaultTextInput(env, msg, token);
    } else {
      await handleGlobalSearch(env, chatId, token, text);
    }
    return;
  }

  // Route to appropriate feature handler based on state prefix
  const state = session.state;

  if (state.startsWith('totp_'))    { await handleTotpInput(env, msg, token); return; }
  if (state.startsWith('pw_'))      { await handlePasswordInput(env, msg, token); return; }
  if (state.startsWith('note_'))    { await handleNoteInput(env, msg, token); return; }
  if (state.startsWith('todo_'))    { await handleTodoInput(env, msg, token); return; }
  if (state.startsWith('vault_'))   { await handleVaultTextInput(env, msg, token); return; }

  // Unknown state — reset
  console.warn(`[Bot] unknown state "${state}" for chat ${chatId} — resetting`);
  await clearState(env, chatId);
  await sendMessage(token, chatId, '⚠️ Session reset. Use /menu to start fresh.');
}

// ── Callback query router ─────────────────────────────────────

async function handleCallback(env: Env, cq: TgCallbackQuery, token: string) {
  const data   = cq.data ?? '';
  const chatId = cq.message?.chat.id ?? cq.from.id;

  // Parse callback data: "feature:action:param" or "feature:action"
  const [feature, action, ...rest] = data.split(':');
  const param = rest.join(':'); // re-join in case param itself contains colons

  switch (feature) {
    case 'menu':
      switch (action) {
        case 'main':
          await answerCallback(token, cq.id);
          await showMainMenu(env, chatId, token, cq.message?.message_id);
          break;

        case 'search':
          await answerCallback(token, cq.id);
          await setState(env, chatId, 'search_query', { context: 'global' });
          if (cq.message) {
            const { editMessage } = await import('./telegram');
            await editMessage(
              token, chatId, cq.message.message_id,
              `🔍 <b>Global Search</b>\n\nSend a keyword to search across all features:`,
              { keyboard: [[{ text: '‹ Cancel', callback_data: 'menu:main' }]] },
            );
          }
          break;

        case 'settings':
          await answerCallback(token, cq.id);
          await showSettingsMenu(env, chatId, token, cq.message?.message_id);
          break;

        case 'reset_session':
          await clearState(env, chatId);
          await answerCallback(token, cq.id, '✅ Session cleared');
          await showMainMenu(env, chatId, token, cq.message?.message_id);
          break;

        default:
          await answerCallback(token, cq.id, '⚠️ Unknown menu action');
      }
      break;

    case 'totp':
      await handleTotpCallback(env, cq, token, action, param);
      break;

    case 'pw':
      await handlePasswordCallback(env, cq, token, action, param);
      break;

    case 'note':
      await handleNoteCallback(env, cq, token, action, param);
      break;

    case 'todo':
      await handleTodoCallback(env, cq, token, action, param);
      break;

    case 'vault':
      await handleVaultCallback(env, cq, token, action, param);
      break;

    case 'close':
      // Universal dismiss button
      await answerCallback(token, cq.id);
      if (cq.message) {
        const { deleteMessage } = await import('./telegram');
        await deleteMessage(token, chatId, cq.message.message_id);
      }
      break;

    default:
      await answerCallback(token, cq.id, '⚠️ Unknown command');
  }
}

// ── Workers fetch handler ─────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url    = new URL(request.url);
    const token  = env.BOT_TOKEN;

    // ── Webhook registration endpoint ──────────────────────────
    if (url.pathname === '/register' && request.method === 'GET') {
      const webhookUrl = `${url.origin}/webhook`;
      const res = await fetch(
        `https://api.telegram.org/bot${token}/setWebhook`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            url:             webhookUrl,
            allowed_updates: ['message', 'callback_query'],
            drop_pending_updates: true,
          }),
        },
      );
      const json = await res.json() as { ok: boolean; description?: string };
      return new Response(
        JSON.stringify({ registered: json.ok, webhook: webhookUrl, detail: json }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // ── Webhook endpoint ───────────────────────────────────────
    if (url.pathname === '/webhook' && request.method === 'POST') {
      // Always return 200 immediately — Telegram needs this within 5s
      // All processing happens in ctx.waitUntil() background task

      let update: TgUpdate;
      try {
        update = await request.json() as TgUpdate;
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      ctx.waitUntil(processUpdate(env, update));
      return new Response('OK', { status: 200 });
    }

    // ── Health check ───────────────────────────────────────────
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ── Update processor ──────────────────────────────────────────

async function processUpdate(env: Env, update: TgUpdate): Promise<void> {
  const token = env.BOT_TOKEN;

  try {
    // ── Message ──────────────────────────────────────────────
    if (update.message) {
      const msg    = update.message;
      const userId = msg.from?.id;

      // Owner-only security gate
      if (!userId || !isOwner(env, userId)) {
        // Silently ignore unauthorized senders
        return;
      }

      await handleMessage(env, msg, token);
      return;
    }

    // ── Edited message (ignore) ───────────────────────────────
    if (update.edited_message) return;

    // ── Callback query ────────────────────────────────────────
    if (update.callback_query) {
      const cq     = update.callback_query;
      const userId = cq.from.id;

      if (!isOwner(env, userId)) {
        await answerCallback(token, cq.id, '⛔ Unauthorized', true);
        return;
      }

      await handleCallback(env, cq, token);
      return;
    }
  } catch (err) {
    // Log the error but don't let it surface to Workers runtime —
    // an unhandled exception here would waste the waitUntil budget
    console.error('[Bot] processUpdate error:', err);

    // Attempt to notify the owner if we have context
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) {
      await sendMessage(token, chatId, '⚠️ An internal error occurred. Please try again.').catch(() => {});
    }
    if (update.callback_query) {
      await answerCallback(token, update.callback_query.id, '⚠️ Error — please retry', true).catch(() => {});
    }
  }
}
