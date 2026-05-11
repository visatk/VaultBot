// ─── src/state.ts ─────────────────────────────────────────────
// Shim: FSM state management is handled in db.ts.
// This file is kept for compatibility with any legacy imports.
// Do not use directly — import from './db' instead.

export { getSession, setState, clearState, purgeSession } from './db';
