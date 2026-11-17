/**
 * Module-private reducer-execution flag. Reducer code runs synchronously, in reducers.ts: signal reducers in
 * `reduce`, result reducers in `foldOne`, and a keyed set's key function in `changedKey`. So a boolean
 * save/restore around those calls cannot leak (a reducer cannot `await`).
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
