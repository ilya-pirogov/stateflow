/**
 * Module-private reducer-execution flag. Reducers run synchronously in exactly one place —
 * the `handler(state, signal, ctx)` call in `handleSignal` — so a boolean save/restore around
 * that call is leak-free against all async interleaving (a reducer cannot `await`).
 */
let inReducer = false;

export const isInReducer = (): boolean => inReducer;

export function runInReducer<T>(fn: () => T): T {
  const prev = inReducer; // save/restore, not bare true/false
  inReducer = true;
  try {
    return fn();
  } finally {
    inReducer = prev;
  }
}
