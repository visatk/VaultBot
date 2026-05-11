import type {
  Env, DbUser, DbTotp, DbPassword, DbNote, DbTodo, DbVault, DbSession,
} from './types';

// ── KV session cache helpers ──────────────────────────────────
// Sessions are read on every message; KV gives edge-local reads.

const SESSION_TTL = 300; // 5 minutes — matches typical conversation gaps

function kvSessionKey(userId: number): string {
  return `session:${userId}`;
}

async function kvGetSession(env: Env, userId: number): Promise<DbSession | null> {
  try {
    const raw = await env.KV.get(kvSessionKey(userId), 'json');
    return raw as DbSession | null;
  } catch {
    return null;
  }
}

async function kvSetSession(env: Env, session: DbSession): Promise<void> {
  try {
    await env.KV.put(
      kvSessionKey(session.user_id),
      JSON.stringify(session),
      { expirationTtl: SESSION_TTL },
    );
  } catch {
    // KV write failure is non-fatal; D1 remains source of truth
  }
}

async function kvDelSession(env: Env, userId: number): Promise<void> {
  try {
    await env.KV.delete(kvSessionKey(userId));
  } catch { /* non-fatal */ }
}

// ── Rate-limit counter helpers (KV) ──────────────────────────
// Used to throttle writes/operations per user per minute.

export async function getRateCount(env: Env, userId: number, action: string): Promise<number> {
  try {
    const key = `rate:${userId}:${action}`;
    const val = await env.KV.get(key);
    return val ? parseInt(val) : 0;
  } catch {
    return 0;
  }
}

export async function incrementRateCount(env: Env, userId: number, action: string): Promise<void> {
  try {
    const key = `rate:${userId}:${action}`;
    const cur = await env.KV.get(key);
    const next = cur ? parseInt(cur) + 1 : 1;
    // TTL of 60 s — auto-expires each minute window
    await env.KV.put(key, String(next), { expirationTtl: 60 });
  } catch { /* non-fatal */ }
}

// ── Users ─────────────────────────────────────────────────────

export async function upsertUser(
  env: Env,
  id: number,
  firstName: string,
  username?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, first_name, username, last_seen)
     VALUES (?1, ?2, ?3, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       first_name = ?2,
       username   = ?3,
       last_seen  = unixepoch()`,
  )
    .bind(id, firstName, username ?? null)
    .run();
}

export async function getUser(env: Env, id: number): Promise<DbUser | null> {
  return env.DB
    .prepare('SELECT * FROM users WHERE id = ?1')
    .bind(id)
    .first<DbUser>();
}

// ── Sessions (FSM) ────────────────────────────────────────────
// Reads: KV first (fast edge cache), fall-through to D1.
// Writes: D1 primary, KV updated synchronously so next read is warm.

export async function getSession(env: Env, userId: number): Promise<DbSession> {
  // Try KV cache first
  const cached = await kvGetSession(env, userId);
  if (cached) return cached;

  // Fall through to D1
  const row = await env.DB
    .prepare('SELECT * FROM sessions WHERE user_id = ?1')
    .bind(userId)
    .first<DbSession>();

  const session: DbSession = row ?? {
    user_id: userId,
    state: 'idle',
    state_data: '{}',
    updated_at: 0,
  };

  // Warm the cache for future reads this conversation
  await kvSetSession(env, session);
  return session;
}

export async function setState(
  env: Env,
  userId: number,
  state: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions (user_id, state, state_data, updated_at)
     VALUES (?1, ?2, ?3, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET
       state      = ?2,
       state_data = ?3,
       updated_at = unixepoch()`,
  )
    .bind(userId, state, JSON.stringify(data))
    .run();

  // Update KV cache immediately so the next getSession is warm
  await kvSetSession(env, {
    user_id: userId,
    state,
    state_data: JSON.stringify(data),
    updated_at: Math.floor(Date.now() / 1000),
  });
}

export async function clearState(env: Env, userId: number): Promise<void> {
  await setState(env, userId, 'idle');
}

export async function purgeSession(env: Env, userId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId).run();
  await kvDelSession(env, userId);
}

// ── 2FA / TOTP ────────────────────────────────────────────────

export async function getTotpAccounts(env: Env, userId: number): Promise<DbTotp[]> {
  const { results } = await env.DB
    .prepare('SELECT * FROM totp_accounts WHERE user_id = ?1 ORDER BY label ASC')
    .bind(userId)
    .all<DbTotp>();
  return results;
}

export async function getTotpById(env: Env, id: number, userId: number): Promise<DbTotp | null> {
  return env.DB
    .prepare('SELECT * FROM totp_accounts WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<DbTotp>();
}

export async function addTotpAccount(
  env: Env,
  userId: number,
  label: string,
  issuer: string,
  secretEnc: string,
  iv: string,
  algorithm = 'SHA1',
  digits = 6,
  period = 30,
  icon?: string,
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO totp_accounts
       (user_id, label, issuer, secret_enc, iv, algorithm, digits, period, icon)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(userId, label, issuer, secretEnc, iv, algorithm, digits, period, icon ?? null)
    .run();
  return result.meta.last_row_id as number;
}

export async function updateTotpAccount(
  env: Env,
  id: number,
  userId: number,
  label: string,
  issuer: string,
  icon?: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE totp_accounts
        SET label = ?3, issuer = ?4, icon = ?5, updated_at = unixepoch()
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId, label, issuer, icon ?? null)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteTotpAccount(env: Env, id: number, userId: number): Promise<boolean> {
  const result = await env.DB
    .prepare('DELETE FROM totp_accounts WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ── Passwords ─────────────────────────────────────────────────

export async function getPasswords(
  env: Env,
  userId: number,
  category?: string,
): Promise<DbPassword[]> {
  if (category) {
    const { results } = await env.DB
      .prepare(
        'SELECT * FROM passwords WHERE user_id = ?1 AND category = ?2 ORDER BY title ASC',
      )
      .bind(userId, category)
      .all<DbPassword>();
    return results;
  }
  const { results } = await env.DB
    .prepare('SELECT * FROM passwords WHERE user_id = ?1 ORDER BY title ASC')
    .bind(userId)
    .all<DbPassword>();
  return results;
}

export async function getPasswordById(
  env: Env,
  id: number,
  userId: number,
): Promise<DbPassword | null> {
  return env.DB
    .prepare('SELECT * FROM passwords WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<DbPassword>();
}

export async function addPassword(
  env: Env,
  userId: number,
  title: string,
  username: string,
  passwordEnc: string,
  iv: string,
  url = '',
  notes = '',
  category = 'general',
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO passwords
       (user_id, title, username, password_enc, iv, url, notes, category)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(userId, title, username, passwordEnc, iv, url, notes, category)
    .run();
  return result.meta.last_row_id as number;
}

export async function updatePassword(
  env: Env,
  id: number,
  userId: number,
  fields: {
    title?: string;
    username?: string;
    passwordEnc?: string;
    iv?: string;
    url?: string;
    notes?: string;
    category?: string;
  },
): Promise<boolean> {
  const sets: string[] = ['updated_at = unixepoch()'];
  const bindings: unknown[] = [id, userId];
  let idx = 3;

  if (fields.title !== undefined)    { sets.push(`title = ?${idx++}`);    bindings.push(fields.title); }
  if (fields.username !== undefined) { sets.push(`username = ?${idx++}`); bindings.push(fields.username); }
  if (fields.passwordEnc !== undefined && fields.iv !== undefined) {
    sets.push(`password_enc = ?${idx++}`); bindings.push(fields.passwordEnc);
    sets.push(`iv = ?${idx++}`);           bindings.push(fields.iv);
  }
  if (fields.url !== undefined)      { sets.push(`url = ?${idx++}`);      bindings.push(fields.url); }
  if (fields.notes !== undefined)    { sets.push(`notes = ?${idx++}`);    bindings.push(fields.notes); }
  if (fields.category !== undefined) { sets.push(`category = ?${idx++}`); bindings.push(fields.category); }

  if (sets.length === 1) return false; // nothing to update

  const sql = `UPDATE passwords SET ${sets.join(', ')} WHERE id = ?1 AND user_id = ?2`;
  const result = await env.DB.prepare(sql).bind(...bindings).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deletePassword(env: Env, id: number, userId: number): Promise<boolean> {
  const result = await env.DB
    .prepare('DELETE FROM passwords WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function togglePasswordFavorite(
  env: Env,
  id: number,
  userId: number,
): Promise<void> {
  await env.DB
    .prepare(
      'UPDATE passwords SET is_favorite = 1 - is_favorite, updated_at = unixepoch() WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId)
    .run();
}

export async function getFavoritePasswords(env: Env, userId: number): Promise<DbPassword[]> {
  const { results } = await env.DB
    .prepare('SELECT * FROM passwords WHERE user_id = ?1 AND is_favorite = 1 ORDER BY title ASC')
    .bind(userId)
    .all<DbPassword>();
  return results;
}

export async function searchPasswords(
  env: Env,
  userId: number,
  query: string,
): Promise<Array<{ id: number; title: string; username: string; category: string }>> {
  const like = `%${query}%`;
  const { results } = await env.DB
    .prepare(
      `SELECT id, title, username, category FROM passwords
        WHERE user_id = ?1 AND (title LIKE ?2 OR username LIKE ?2)
        ORDER BY title ASC LIMIT 20`,
    )
    .bind(userId, like)
    .all<{ id: number; title: string; username: string; category: string }>();
  return results;
}

// ── Notes ─────────────────────────────────────────────────────

export async function getNotes(env: Env, userId: number, category?: string): Promise<DbNote[]> {
  if (category) {
    const { results } = await env.DB
      .prepare(
        'SELECT * FROM notes WHERE user_id = ?1 AND category = ?2 ORDER BY is_pinned DESC, updated_at DESC',
      )
      .bind(userId, category)
      .all<DbNote>();
    return results;
  }
  const { results } = await env.DB
    .prepare(
      'SELECT * FROM notes WHERE user_id = ?1 ORDER BY is_pinned DESC, updated_at DESC',
    )
    .bind(userId)
    .all<DbNote>();
  return results;
}

export async function getNoteById(env: Env, id: number, userId: number): Promise<DbNote | null> {
  return env.DB
    .prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<DbNote>();
}

export async function addNote(
  env: Env,
  userId: number,
  title: string,
  content: string,
  category = 'general',
  color = '#6366f1',
): Promise<number> {
  const result = await env.DB.prepare(
    'INSERT INTO notes (user_id, title, content, category, color) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(userId, title, content, category, color)
    .run();
  return result.meta.last_row_id as number;
}

export async function updateNote(
  env: Env,
  id: number,
  userId: number,
  title: string,
  content: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE notes
        SET title = ?3, content = ?4, updated_at = unixepoch()
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId, title, content)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteNote(env: Env, id: number, userId: number): Promise<boolean> {
  const result = await env.DB
    .prepare('DELETE FROM notes WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function toggleNotePin(env: Env, id: number, userId: number): Promise<void> {
  await env.DB
    .prepare(
      'UPDATE notes SET is_pinned = 1 - is_pinned, updated_at = unixepoch() WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId)
    .run();
}

export async function toggleNoteFavorite(env: Env, id: number, userId: number): Promise<void> {
  await env.DB
    .prepare(
      'UPDATE notes SET is_favorite = 1 - is_favorite, updated_at = unixepoch() WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId)
    .run();
}

export async function searchNotes(env: Env, userId: number, query: string): Promise<DbNote[]> {
  const like = `%${query}%`;
  const { results } = await env.DB
    .prepare(
      `SELECT * FROM notes
        WHERE user_id = ?1 AND (title LIKE ?2 OR content LIKE ?2)
        ORDER BY is_pinned DESC, updated_at DESC
        LIMIT 20`,
    )
    .bind(userId, like)
    .all<DbNote>();
  return results;
}

// ── Todos ─────────────────────────────────────────────────────

export async function getTodos(
  env: Env,
  userId: number,
  done?: boolean,
  listName?: string,
): Promise<DbTodo[]> {
  let sql = 'SELECT * FROM todos WHERE user_id = ?1';
  const binds: unknown[] = [userId];
  let p = 2;

  if (done !== undefined) {
    sql += ` AND is_done = ?${p++}`;
    binds.push(done ? 1 : 0);
  }
  if (listName) {
    sql += ` AND list_name = ?${p++}`;
    binds.push(listName);
  }

  sql += ' ORDER BY is_done ASC, priority DESC, created_at ASC';

  const { results } = await env.DB.prepare(sql).bind(...binds).all<DbTodo>();
  return results;
}

export async function getTodoById(env: Env, id: number, userId: number): Promise<DbTodo | null> {
  return env.DB
    .prepare('SELECT * FROM todos WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<DbTodo>();
}

export async function addTodo(
  env: Env,
  userId: number,
  title: string,
  description = '',
  priority = 'normal',
  listName = 'inbox',
  dueDate?: number,
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO todos (user_id, title, description, priority, list_name, due_date)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(userId, title, description, priority, listName, dueDate ?? null)
    .run();
  return result.meta.last_row_id as number;
}

export async function updateTodo(
  env: Env,
  id: number,
  userId: number,
  title: string,
  description: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE todos
        SET title = ?3, description = ?4, updated_at = unixepoch()
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId, title, description)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function toggleTodoDone(env: Env, id: number, userId: number): Promise<DbTodo | null> {
  await env.DB.prepare(
    `UPDATE todos
        SET is_done    = 1 - is_done,
            done_at    = CASE WHEN is_done = 0 THEN unixepoch() ELSE NULL END,
            updated_at = unixepoch()
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId)
    .run();
  return getTodoById(env, id, userId);
}

export async function updateTodoPriority(
  env: Env,
  id: number,
  userId: number,
  priority: string,
): Promise<boolean> {
  const result = await env.DB
    .prepare(
      'UPDATE todos SET priority = ?3, updated_at = unixepoch() WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId, priority)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setTodoDueDate(
  env: Env,
  id: number,
  userId: number,
  dueDate: number | null,
): Promise<boolean> {
  const result = await env.DB
    .prepare(
      'UPDATE todos SET due_date = ?3, updated_at = unixepoch() WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId, dueDate)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteTodo(env: Env, id: number, userId: number): Promise<boolean> {
  const result = await env.DB
    .prepare('DELETE FROM todos WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getOverdueTodos(env: Env, userId: number): Promise<DbTodo[]> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB
    .prepare(
      `SELECT * FROM todos
        WHERE user_id = ?1 AND is_done = 0 AND due_date IS NOT NULL AND due_date < ?2
        ORDER BY due_date ASC`,
    )
    .bind(userId, now)
    .all<DbTodo>();
  return results;
}

// ── Vault ─────────────────────────────────────────────────────

export async function getVaultItems(
  env: Env,
  userId: number,
  type?: string,
  collection?: string,
): Promise<DbVault[]> {
  let sql = 'SELECT * FROM vault WHERE user_id = ?1';
  const binds: unknown[] = [userId];
  let p = 2;

  if (type)       { sql += ` AND type = ?${p++}`;       binds.push(type); }
  if (collection) { sql += ` AND collection = ?${p++}`; binds.push(collection); }

  sql += ' ORDER BY is_pinned DESC, created_at DESC';

  const { results } = await env.DB.prepare(sql).bind(...binds).all<DbVault>();
  return results;
}

export async function getVaultById(env: Env, id: number, userId: number): Promise<DbVault | null> {
  return env.DB
    .prepare('SELECT * FROM vault WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<DbVault>();
}

export async function addVaultItem(
  env: Env,
  userId: number,
  type: string,
  title: string,
  content: string,
  description = '',
  sourceUrl = '',
  collection = 'unsorted',
  r2Key?: string,
  r2Url?: string,
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO vault
       (user_id, type, title, content, description, source_url, collection, r2_key, r2_url)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(userId, type, title, content, description, sourceUrl, collection, r2Key ?? null, r2Url ?? null)
    .run();
  return result.meta.last_row_id as number;
}

export async function deleteVaultItem(
  env: Env,
  id: number,
  userId: number,
): Promise<DbVault | null> {
  const item = await getVaultById(env, id, userId);
  if (!item) return null;
  await env.DB
    .prepare('DELETE FROM vault WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run();
  return item;
}

export async function toggleVaultFavorite(env: Env, id: number, userId: number): Promise<void> {
  await env.DB
    .prepare(
      'UPDATE vault SET is_favorite = 1 - is_favorite, updated_at = unixepoch() WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId)
    .run();
}

export async function toggleVaultPin(env: Env, id: number, userId: number): Promise<void> {
  await env.DB
    .prepare(
      'UPDATE vault SET is_pinned = 1 - is_pinned, updated_at = unixepoch() WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId)
    .run();
}

export async function searchVault(env: Env, userId: number, query: string): Promise<DbVault[]> {
  const like = `%${query}%`;
  const { results } = await env.DB
    .prepare(
      `SELECT * FROM vault
        WHERE user_id = ?1 AND (title LIKE ?2 OR content LIKE ?2 OR description LIKE ?2)
        ORDER BY is_pinned DESC, created_at DESC
        LIMIT 20`,
    )
    .bind(userId, like)
    .all<DbVault>();
  return results;
}

// ── Stats — single batch() round-trip ─────────────────────────
// D1 batch() executes all statements in ONE network call to D1,
// dramatically reducing latency vs. 6 sequential round-trips.

export interface UserStats {
  totp: number;
  passwords: number;
  notes: number;
  todos_open: number;
  todos_done: number;
  vault: number;
  overdue: number;
}

export async function getUserStats(env: Env, userId: number): Promise<UserStats> {
  const now = Math.floor(Date.now() / 1000);

  const [t, p, n, to, td, v, od] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) as c FROM totp_accounts WHERE user_id = ?1').bind(userId),
    env.DB.prepare('SELECT COUNT(*) as c FROM passwords    WHERE user_id = ?1').bind(userId),
    env.DB.prepare('SELECT COUNT(*) as c FROM notes        WHERE user_id = ?1').bind(userId),
    env.DB.prepare('SELECT COUNT(*) as c FROM todos        WHERE user_id = ?1 AND is_done = 0').bind(userId),
    env.DB.prepare('SELECT COUNT(*) as c FROM todos        WHERE user_id = ?1 AND is_done = 1').bind(userId),
    env.DB.prepare('SELECT COUNT(*) as c FROM vault        WHERE user_id = ?1').bind(userId),
    env.DB.prepare(
      'SELECT COUNT(*) as c FROM todos WHERE user_id = ?1 AND is_done = 0 AND due_date IS NOT NULL AND due_date < ?2',
    ).bind(userId, now),
  ]);

  return {
    totp:       (t.results[0] as { c: number })?.c ?? 0,
    passwords:  (p.results[0] as { c: number })?.c ?? 0,
    notes:      (n.results[0] as { c: number })?.c ?? 0,
    todos_open: (to.results[0] as { c: number })?.c ?? 0,
    todos_done: (td.results[0] as { c: number })?.c ?? 0,
    vault:      (v.results[0] as { c: number })?.c ?? 0,
    overdue:    (od.results[0] as { c: number })?.c ?? 0,
  };
}

// ── Search across all features ────────────────────────────────

export interface SearchResults {
  notes: DbNote[];
  todos: DbTodo[];
  vault: DbVault[];
  passwords: Array<{ id: number; title: string; username: string; category: string }>;
}

export async function globalSearch(
  env: Env,
  userId: number,
  query: string,
): Promise<SearchResults> {
  const like = `%${query}%`;

  const [nr, tr, vr, pr] = await env.DB.batch([
    env.DB.prepare(
      'SELECT * FROM notes WHERE user_id = ?1 AND (title LIKE ?2 OR content LIKE ?2) LIMIT 5',
    ).bind(userId, like),
    env.DB.prepare(
      'SELECT * FROM todos WHERE user_id = ?1 AND title LIKE ?2 LIMIT 5',
    ).bind(userId, like),
    env.DB.prepare(
      'SELECT * FROM vault WHERE user_id = ?1 AND (title LIKE ?2 OR description LIKE ?2) LIMIT 5',
    ).bind(userId, like),
    env.DB.prepare(
      'SELECT id, title, username, category FROM passwords WHERE user_id = ?1 AND title LIKE ?2 LIMIT 5',
    ).bind(userId, like),
  ]);

  return {
    notes:     nr.results as DbNote[],
    todos:     tr.results as DbTodo[],
    vault:     vr.results as DbVault[],
    passwords: pr.results as Array<{ id: number; title: string; username: string; category: string }>,
  };
}
