// ─── src/handlers/todos.ts ──────────────────────────────────
// To-Do list handler.
// Enhancements: overdue warnings, list filter, priority picker,
// due-date natural parsing, kb.pager pagination.

import { sendMessage, editMessage, answerCallback, kb, fmt } from '../telegram';
import {
  getTodos, getTodoById, addTodo, toggleTodoDone, deleteTodo,
  updateTodoPriority, setTodoDueDate, getOverdueTodos,
  getSession, setState, clearState,
} from '../db';
import type { Env, TgMessage, TgCallbackQuery, DbTodo } from '../types';

// ── Rendering ─────────────────────────────────────────────────

function renderTodo(todo: DbTodo): string {
  const done   = todo.is_done ? '✅' : fmt.priority(todo.priority);
  const now    = Math.floor(Date.now() / 1000);
  const isOver = !todo.is_done && todo.due_date && todo.due_date < now;
  const due    = todo.due_date
    ? ` · ${isOver ? '🔥' : '⏰'} Due ${fmt.date(todo.due_date)}`
    : '';
  const s = todo.is_done ? '<s>' : '';
  const e = todo.is_done ? '</s>' : '';
  return `${done} ${s}${fmt.escape(todo.title)}${e}${due}`;
}

function listEmoji(list: string): string {
  return ({ inbox: '📥', work: '💼', personal: '👤', shopping: '🛒' }[list] ?? '📋');
}

// ── Main menu ─────────────────────────────────────────────────

export async function showTodoMenu(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  const [todos, overdue] = await Promise.all([
    getTodos(env, chatId),
    getOverdueTodos(env, chatId),
  ]);

  const open = todos.filter((t) => !t.is_done);
  const done = todos.filter((t) => t.is_done);

  let text = `✅ <b>To-Do List</b>\n\n`;

  if (todos.length === 0) {
    text += `All clear! Tap <b>Add Task</b> to create your first task.`;
  } else {
    text +=
      `<b>${open.length}</b> open · <b>${done.length}</b> done` +
      (overdue.length ? ` · 🔥 <b>${overdue.length} overdue!</b>` : '') +
      `\n\n`;

    // Show pinned/urgent first, up to 12 open tasks
    const urgent = open.filter((t) => t.priority === 'urgent' || t.priority === 'high');
    const normal = open.filter((t) => t.priority !== 'urgent' && t.priority !== 'high');
    const display = [...urgent, ...normal].slice(0, 12);

    text += display.map(renderTodo).join('\n');
    if (open.length > 12) text += `\n<i>… and ${open.length - 12} more open tasks</i>`;
  }

  const keyboard = [
    kb.row({ text: '➕ Add Task', data: 'todo:add' }),
    kb.row(
      { text: '📋 Open',   data: 'todo:list:open:0' },
      { text: '✅ Done',   data: 'todo:list:done:0' },
      { text: '📊 All',    data: 'todo:list:all:0'  },
    ),
    ...(overdue.length ? [kb.row({ text: `🔥 Overdue (${overdue.length})`, data: 'todo:overdue' })] : []),
    kb.row({ text: '‹ Back to Menu', data: 'menu:main' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Paginated list ────────────────────────────────────────────

export async function showTodoList(
  env: Env,
  chatId: number,
  token: string,
  filter: 'open' | 'done' | 'all',
  page = 0,
  messageId?: number,
) {
  const isDone  = filter === 'open' ? false : filter === 'done' ? true : undefined;
  const todos   = await getTodos(env, chatId, isDone);
  const PAGE    = 8;
  const start   = page * PAGE;
  const slice   = todos.slice(start, start + PAGE);
  const total   = Math.ceil(todos.length / PAGE);

  const titles  = { open: '📋 Open', done: '✅ Done', all: '📊 All' };
  let text = `${titles[filter]} Tasks (${todos.length})\n\n`;
  text += slice.map(renderTodo).join('\n') || 'No tasks here.';

  // Per-task action buttons
  const taskButtons = slice.map((t) =>
    kb.row(
      { text: t.is_done ? '↩️ Reopen' : '✅ Done', data: `todo:toggle:${t.id}` },
      { text: `🗑 ${fmt.trunc(t.title, 12)}`,        data: `todo:delete_confirm:${t.id}` },
    ),
  );

  const keyboard = [
    ...taskButtons,
    ...kb.pager(`todo:list:${filter}`, page, total),
    kb.row({ text: '‹ Back', data: 'todo:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Overdue view ──────────────────────────────────────────────

export async function showOverdueTodos(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  const todos = await getOverdueTodos(env, chatId);
  if (todos.length === 0) {
    const text   = '🎉 No overdue tasks!';
    const opts   = { keyboard: [kb.row({ text: '‹ Back', data: 'todo:menu' })] };
    if (messageId) await editMessage(token, chatId, messageId, text, opts);
    else           await sendMessage(token, chatId, text, opts);
    return;
  }

  const text =
    `🔥 <b>Overdue Tasks</b> (${todos.length})\n\n` +
    todos.map(renderTodo).join('\n');

  const taskButtons = todos.map((t) =>
    kb.row(
      { text: '✅ Done', data: `todo:toggle:${t.id}` },
      { text: `🗑 ${fmt.trunc(t.title, 12)}`, data: `todo:delete_confirm:${t.id}` },
    ),
  );

  const keyboard = [
    ...taskButtons,
    kb.row({ text: '‹ Back', data: 'todo:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── View single task ──────────────────────────────────────────

export async function showTodoDetail(
  env: Env,
  chatId: number,
  token: string,
  todoId: number,
  messageId?: number,
) {
  const t = await getTodoById(env, todoId, chatId);
  if (!t) { await sendMessage(token, chatId, '❌ Task not found.'); return; }

  const now    = Math.floor(Date.now() / 1000);
  const isOver = !t.is_done && t.due_date && t.due_date < now;

  const text =
    `${t.is_done ? '✅' : fmt.priority(t.priority)} <b>${fmt.escape(t.title)}</b>\n\n` +
    (t.description ? `📄 ${fmt.escape(t.description)}\n\n` : '') +
    `📁 List: <b>${listEmoji(t.list_name)} ${t.list_name}</b>\n` +
    `🔢 Priority: <b>${t.priority}</b>\n` +
    (t.due_date
      ? `${isOver ? '🔥' : '⏰'} Due: <b>${fmt.date(t.due_date)}</b>\n`
      : '') +
    `⏱ Added: ${fmt.relativeTime(t.created_at)}\n` +
    (t.done_at ? `✅ Completed: ${fmt.relativeTime(t.done_at)}\n` : '');

  const keyboard = [
    kb.row(
      { text: t.is_done ? '↩️ Reopen' : '✅ Mark Done', data: `todo:toggle:${todoId}` },
    ),
    kb.row(
      { text: '🔴 Urgent', data: `todo:priority:${todoId}:urgent` },
      { text: '🟡 High',   data: `todo:priority:${todoId}:high` },
    ),
    kb.row(
      { text: '🔵 Normal', data: `todo:priority:${todoId}:normal` },
      { text: '🟢 Low',    data: `todo:priority:${todoId}:low` },
    ),
    kb.row({ text: '🗑 Delete', data: `todo:delete_confirm:${todoId}` }),
    kb.row({ text: '‹ Back', data: 'todo:menu' }),
  ];

  const opts = { keyboard };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Add flow ──────────────────────────────────────────────────

export async function startAddTodo(
  env: Env,
  chatId: number,
  token: string,
  messageId?: number,
) {
  await setState(env, chatId, 'todo_add_title');
  const text =
    `➕ <b>New Task</b>\n\nSend the <b>task title</b>.\n\nSend /cancel to abort.`;
  const opts = { keyboard: kb.back('todo:menu') };
  if (messageId) await editMessage(token, chatId, messageId, text, opts);
  else           await sendMessage(token, chatId, text, opts);
}

// ── Input handler (FSM) ───────────────────────────────────────

export async function handleTodoInput(env: Env, msg: TgMessage, token: string) {
  const chatId  = msg.chat.id;
  const text    = msg.text?.trim() ?? '';
  const session = await getSession(env, chatId);
  const data    = JSON.parse(session.state_data) as Record<string, unknown>;

  switch (session.state) {
    case 'todo_add_title':
      await setState(env, chatId, 'todo_add_description', { title: text });
      await sendMessage(
        token, chatId,
        `✅ Title: <b>${fmt.escape(text)}</b>\n\n📝 Add a <b>description</b> (or <code>-</code> to skip):`,
        { keyboard: [kb.row({ text: '⏭ Skip', data: 'todo:skip_desc' })] },
      );
      break;

    case 'todo_add_description': {
      const desc = text === '-' ? '' : text;
      await setState(env, chatId, 'todo_set_due', { ...data, description: desc });
      await sendMessage(
        token, chatId,
        `⏰ Set a <b>due date</b>?\n` +
        `Send in format <code>YYYY-MM-DD</code> or <code>-</code> to skip:`,
        { keyboard: [kb.row({ text: '⏭ Skip', data: 'todo:skip_due' })] },
      );
      break;
    }

    case 'todo_set_due': {
      if (text === '-') {
        await completeTodoAdd(env, chatId, token, data, undefined);
        return;
      }
      const d = new Date(text);
      if (isNaN(d.getTime())) {
        await sendMessage(token, chatId,
          '❌ Invalid date. Use <code>YYYY-MM-DD</code> format or send <code>-</code> to skip:',
        );
        return;
      }
      await completeTodoAdd(env, chatId, token, data, Math.floor(d.getTime() / 1000));
      break;
    }
  }
}

async function completeTodoAdd(
  env: Env,
  chatId: number,
  token: string,
  data: Record<string, unknown>,
  dueDate?: number,
) {
  const id = await addTodo(
    env, chatId,
    data.title as string,
    (data.description as string) || '',
    'normal', 'inbox', dueDate,
  );
  await clearState(env, chatId);

  const task = await getTodoById(env, id, chatId);
  await sendMessage(
    token, chatId,
    `✅ <b>Task added!</b>\n${renderTodo(task!)}\n\n<b>Set priority:</b>`,
    {
      keyboard: [
        kb.row(
          { text: '🔴 Urgent', data: `todo:priority:${id}:urgent` },
          { text: '🟡 High',   data: `todo:priority:${id}:high`   },
        ),
        kb.row(
          { text: '🔵 Normal', data: `todo:priority:${id}:normal` },
          { text: '🟢 Low',    data: `todo:priority:${id}:low`    },
        ),
        kb.row({ text: '‹ Back to Todos', data: 'todo:menu' }),
      ],
    },
  );
}

// ── Callback handler ──────────────────────────────────────────

export async function handleTodoCallback(
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
      await showTodoMenu(env, chatId, token, msgId);
      break;

    case 'add':
      await answerCallback(token, cq.id);
      await startAddTodo(env, chatId, token, msgId);
      break;

    case 'list': {
      const parts  = param.split(':');
      const filter = parts[0] as 'open' | 'done' | 'all';
      const page   = parseInt(parts[1] ?? '0');
      await answerCallback(token, cq.id);
      await showTodoList(env, chatId, token, filter, page, msgId);
      break;
    }

    case 'overdue':
      await answerCallback(token, cq.id);
      await showOverdueTodos(env, chatId, token, msgId);
      break;

    case 'view': {
      await answerCallback(token, cq.id);
      await showTodoDetail(env, chatId, token, parseInt(param), msgId);
      break;
    }

    case 'toggle': {
      const todo = await toggleTodoDone(env, parseInt(param), chatId);
      await answerCallback(token, cq.id, todo?.is_done ? '✅ Done!' : '↩️ Reopened');
      await showTodoMenu(env, chatId, token, msgId);
      break;
    }

    case 'skip_desc': {
      const session = await getSession(env, chatId);
      const data    = JSON.parse(session.state_data) as Record<string, unknown>;
      await setState(env, chatId, 'todo_set_due', { ...data, description: '' });
      await answerCallback(token, cq.id);
      await editMessage(
        token, chatId, msgId,
        `⏰ Set a <b>due date</b>? (<code>YYYY-MM-DD</code> or <code>-</code>):`,
        { keyboard: [kb.row({ text: '⏭ Skip', data: 'todo:skip_due' })] },
      );
      break;
    }

    case 'skip_due': {
      const session = await getSession(env, chatId);
      const data    = JSON.parse(session.state_data) as Record<string, unknown>;
      await answerCallback(token, cq.id);
      await completeTodoAdd(env, chatId, token, data, undefined);
      break;
    }

    case 'priority': {
      const [idStr, priority] = param.split(':');
      await updateTodoPriority(env, parseInt(idStr), chatId, priority);
      await answerCallback(token, cq.id, `${fmt.priority(priority)} Priority set to ${priority}`);
      await showTodoMenu(env, chatId, token, msgId);
      break;
    }

    case 'delete_confirm': {
      const todo = await getTodoById(env, parseInt(param), chatId);
      if (!todo) { await answerCallback(token, cq.id, '❌ Not found', true); return; }
      await answerCallback(token, cq.id);
      await editMessage(
        token, chatId, msgId,
        `🗑 Delete "<b>${fmt.escape(todo.title)}</b>"?\n<i>This cannot be undone.</i>`,
        { keyboard: kb.confirm(`todo:delete:${param}`, 'todo:menu') },
      );
      break;
    }

    case 'delete':
      await deleteTodo(env, parseInt(param), chatId);
      await answerCallback(token, cq.id, '🗑 Task deleted');
      await showTodoMenu(env, chatId, token, msgId);
      break;

    default:
      await answerCallback(token, cq.id, '⚠️ Unknown action');
  }
}
