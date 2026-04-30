import { Env, TgMessage, TgCallbackQuery, TodoRow } from '../types';
import { sendMessage, answerCallback, editMessage } from '../telegram';
import { addTodo, listTodos, toggleTodo, deleteTodo, clearDoneTodos } from '../db';
import { getState, setState, clearState } from '../state';
import { ICONS, escHtml, priorityLabel } from '../ui';
import { InlineKeyboard } from '../telegram';

function todoListText(rows: TodoRow[]): string {
  if (!rows.length) return `${ICONS.todo} <b>To-Do List</b>\n\nNo items yet. Add one!`;
  const lines = [`${ICONS.todo} <b>To-Do List</b> (${rows.length} items)\n`];
  for (const r of rows) {
    const done = r.done ? '✅' : '⬜';
    const pri = r.priority >= 2 ? ` ${priorityLabel(r.priority)}` : '';
    lines.push(`${done} ${escHtml(r.text)}${pri}${r.due_date ? ` 📅 ${r.due_date}` : ''}`);
  }
  return lines.join('\n');
}

function todoKeyboard(rows: TodoRow[]): InlineKeyboard {
  const btns: InlineKeyboard = [];
  for (const r of rows) {
    btns.push([
      { text: `${r.done ? '↩️' : '✅'} ${r.text.slice(0, 25)}`, callback_data: `todo:toggle:${r.id}` },
      { text: `${ICONS.del}`, callback_data: `todo:del:${r.id}` },
    ]);
  }
  btns.push([
    { text: `${ICONS.add} Add Task`, callback_data: 'todo:add' },
    { text: `🧹 Clear Done`, callback_data: 'todo:cleardone' },
  ]);
  btns.push([{ text: '🏠 Home', callback_data: 'home' }]);
  return btns;
}

export async function handleTodoCallback(cq: TgCallbackQuery, env: Env, action: string, arg?: string): Promise<void> {
  const userId = cq.from.id;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  const refresh = async () => {
    const rows = await listTodos(env, userId);
    await editMessage(env, chatId, msgId, todoListText(rows), todoKeyboard(rows));
  };

  if (action === 'list') {
    await refresh();
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'add') {
    await setState(env, userId, { step: 'TODO_ADD_TEXT' });
    await editMessage(env, chatId, msgId,
      `${ICONS.add} <b>New Task</b>\n\nSend the task text:\n<i>Optional: start with 🔴 for urgent, 🟡 for high priority</i>`,
      [[{ text: `${ICONS.back} Cancel`, callback_data: 'todo:list' }]],
    );
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'toggle' && arg) {
    await toggleTodo(env, parseInt(arg), userId);
    await refresh();
    await answerCallback(env, cq.id);
    return;
  }

  if (action === 'del' && arg) {
    await deleteTodo(env, parseInt(arg), userId);
    await refresh();
    await answerCallback(env, cq.id, 'Deleted');
    return;
  }

  if (action === 'cleardone') {
    await clearDoneTodos(env, userId);
    await refresh();
    await answerCallback(env, cq.id, '✅ Cleared done tasks');
    return;
  }
}

export async function handleTodoMessage(msg: TgMessage, env: Env): Promise<boolean> {
  const userId = msg.from.id;
  const text = msg.text?.trim() ?? '';
  const state = await getState(env, userId);

  if (state?.step === 'TODO_ADD_TEXT') {
    let priority = 1;
    let taskText = text;
    if (text.startsWith('🔴') || text.toLowerCase().startsWith('urgent:')) { priority = 3; taskText = text.replace(/^🔴\s*|^urgent:\s*/i, ''); }
    else if (text.startsWith('🟡') || text.toLowerCase().startsWith('high:')) { priority = 2; taskText = text.replace(/^🟡\s*|^high:\s*/i, ''); }

    await setState(env, userId, { step: 'TODO_ADD_DUE', data: { text: taskText, priority } });
    await sendMessage(env, msg.chat.id,
      `${ICONS.check} Task: <b>${escHtml(taskText)}</b> (${priorityLabel(priority)})\n\nSend a <b>due date</b> (e.g. <code>2024-12-31</code>), or <code>skip</code>:`,
    );
    return true;
  }

  if (state?.step === 'TODO_ADD_DUE') {
    const dueDate = text === 'skip' ? undefined : text;
    await addTodo(env, userId, state.data!.text as string, state.data!.priority as number, dueDate);
    await clearState(env, userId);
    await sendMessage(env, msg.chat.id,
      `${ICONS.check} Task "<b>${escHtml(state.data!.text as string)}</b>" added!\n\nUse /todos to manage tasks.`,
    );
    return true;
  }

  return false;
}
