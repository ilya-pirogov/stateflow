export interface StateFlowLogEntry {
  // Flow identification
  flowName: string;
  signal: string;
  isAsync: boolean;
  startTime: number;
  duration?: number; // Present on the end entry of an asynchronous declared transition
  /** Monotonic per-page order in which steps STARTED, shared across ALL flows: each entry takes the next
   * value when its step starts (a dispatch, a transition's end, an accepted abort). It is not commit
   * order: a handler's dispatch to another target starts after the outer step and commits before it, and
   * an abort's entry is numbered when the abort is accepted and commits once the aborted work settled or
   * its timeout passed. Entries are delivered (and recorded) in FINISH order; sort by this to reconstruct the
   * timeline, including same-millisecond ties. The engine always sets it on fresh entries; it is optional
   * because hand-built entries (fixtures, replay tooling) and recordings from older builds predate the field. */
  dispatchOrder?: number;
  /** Set on the entries of a declared transition, one per step: "temp" on its temp step, also one that changes
   * nothing, and "final" or "failed" on its end. A refused temp step keeps "temp", or, when its failed step commits,
   * is marked "failed". */
  transition?: "temp" | "final" | "failed";
  /** Set on the entry of an accepted abort: the path of the node whose transition it aborted, as `job` or
   * `media.producers[cam]`. */
  aborted?: string;
  message: string; // Formatted message suitable for logging

  // States
  finalStates: Record<string, string>;

  // State changes or attempts. A change's or a handler result's stateName is the node's path: `media` for a
  // top-level state, `media.transport` and `media.producers[cam]` for nested states.
  stateChanges: Array<{
    newState: string;
    oldState: string;
    stateName: string;
  }>;

  // Handler executions
  // A "transition" handler result is that of a transition handler a declared transition ran as its work, in the
  // entry that ends the transition: the Result it settled to, "unsettled at timeout", "unsettled at failure" (another
  // handler of the work refused first), or, in an accepted abort's entry, "dropped after abort: <result>" or "dropped
  // after abort: unsettled". A "commit" handler result is that of a commit handler: "OK" when it returned, the error
  // when it threw; or the error a commit delegate threw (see HandlerResult.onCommit), named by the exit, update, enter
  // or transition handler that returned it.
  handlerResults: Array<{
    type: "enter" | "exit" | "update" | "commit" | "transition";
    handlerName: string;
    stateName: string;
    result: string;
  }>;

  // The observers whose compare asked for their callback on a change of a node, named by its path as in stateChanges
  // (with no compare for a nested node that held no instance of its state before): `needObserve` is true. One whose
  // compare threw is listed too, with `needObserve` false and `error` the string form of the throw. An observer whose
  // compare declined is not listed.
  observers: Array<{
    observerName: string;
    stateName: string;
    needObserve: boolean;
    error?: string;
  }>;

  // Final result
  finalResult: string;

  /** The final result as plain data, for tools: `finalResult` is text, and an Error's text starts with its error's own
   * name ("StateFlowError: ..."), not with its kind. `kind` is the ResultKind's name, `message` an Ignored or Rejected
   * result's message (null when it has none), and `errors` an Error result's errors, at least one for an Error and none
   * for any other kind: each name and message is its string form, a missing (null or undefined) name reads "Error" and
   * a missing message "". Two Errors that merged (see Result.merge) are listed flat, in merge order; any other error,
   * an AggregateError a handler threw included, is one entry. `code` is the result's code (see Result.code), null when it
   * has none, so a tool reads it without parsing a message. The engine sets it on every entry it delivers, unless reading an error's name or
   * message threw while the data was built; it is optional for that and because hand-built entries and recordings
   * from older builds predate it. */
  finalResultData?: {
    kind: string;
    message: string | null;
    code: string | null;
    errors: Array<{ name: string; message: string }>;
  };

  /** Set when the entry was emitted under a labeled `lock(target, label)`. Lets non-console
   * handlers group related signals; the console handler is grouped for you via `emitGrouped`. */
  groupLabel?: string;

  /** The dispatch-context provider's snapshot, captured SYNCHRONOUSLY when the section's
   * `lock(target, label)` was CALLED — i.e. still inside the caller's stack, which for
   * UI-triggered locks is the interaction event's synchronous propagation. When the lock was
   * CONTENDED for >= 5ms, `lock()` appends ` [lock <wait>ms]` to the snapshot before stamping
   * it. Set on every entry of the labeled section at flush. Absent when no provider is
   * registered (the default), for unlabeled locks, and on entries from older builds. */
  dispatchContext?: string;
}

export type StateFlowLogHandler = (entry: StateFlowLogEntry) => void;

// Global dispatch-context provider. Same additive-hook pattern as the global log handlers:
// `lock(target, label)` calls it synchronously in its prologue and stamps the returned string
// onto the section's group + entries. With no provider registered (the default) the cost is a
// null check and behavior is byte-identical — entries gain no field, console output unchanged.
let dispatchContextProvider: (() => string | null) | null = null;

/**
 * Registers the provider whose return value becomes `dispatchContext` on every entry of a
 * labeled lock section, captured synchronously at `lock()` call time. Returns an unsubscribe
 * function. One provider at a time (last registration wins). Debug-tooling hook: a throwing
 * or null-returning provider leaves entries and console output exactly as without one.
 */
export function setGlobalDispatchContextProvider(provider: () => string | null): () => void {
  dispatchContextProvider = provider;
  return () => {
    if (dispatchContextProvider === provider) {
      dispatchContextProvider = null;
    }
  };
}

/** @internal The provider's current value, or null (no provider / provider threw). */
export function getGlobalDispatchContext(): string | null {
  if (dispatchContextProvider == null) {
    return null;
  }
  try {
    return dispatchContextProvider();
  } catch {
    return null;
  }
}

// Global log-handler registry. Handlers registered here receive EVERY flow's entries in addition
// to each flow's own `logHandlers`. Purely additive: with no handler registered the delivery path
// is exactly the per-flow handler list. Intended for debug tooling (e.g. the core SDK's StateFlow
// log recorder) so it can observe all flows without touching production `applyFlow` call sites.
const globalLogHandlers = new Set<StateFlowLogHandler>();

/**
 * Registers a handler that receives every log entry from every flow, in addition to the per-flow
 * `logHandlers`. Returns an unsubscribe function. Debug-tooling hook: it does not change console
 * output or any per-flow handler behavior.
 */
export function addGlobalLogHandler(handler: StateFlowLogHandler): () => void {
  globalLogHandlers.add(handler);
  return () => {
    globalLogHandlers.delete(handler);
  };
}

/** @internal Per-flow handlers plus the globally registered taps (the per-flow array when none). */
export function withGlobalLogHandlers(handlers: StateFlowLogHandler[]): StateFlowLogHandler[] {
  if (globalLogHandlers.size === 0) {
    return handlers;
  }
  return [...handlers, ...globalLogHandlers];
}

// StateFlow's built-in console logging is noise during test runs, so it is silenced by default
// under vitest (which sets process.env.VITEST). Structured/custom handlers are unaffected — only
// the console output of `consoleLogHandler` and the `emitGrouped` group wrapper are suppressed.
let consoleSilencedOverride: boolean | null = null;

function isConsoleSilenced(): boolean {
  if (consoleSilencedOverride !== null) {
    return consoleSilencedOverride;
  }
  return typeof process !== "undefined" && process.env?.VITEST != null;
}

/**
 * Force StateFlow's built-in console logging on (`false`) or off (`true`), or pass `null` to
 * restore the default (silenced under vitest, on otherwise). Affects `consoleLogHandler` and the
 * `emitGrouped` console grouping; structured handlers always receive their entries.
 */
export function setConsoleLogSilenced(silenced: boolean | null): void {
  consoleSilencedOverride = silenced;
}

export const consoleLogHandler: StateFlowLogHandler = (entry: StateFlowLogEntry) => {
  if (isConsoleSilenced()) {
    return;
  }

  const logs: Record<string, Array<string>> = {};
  entry.stateChanges.reduce((l, r) => {
    l[r.stateName] ??= [];
    l[r.stateName].push(`State: ${r.oldState} => ${r.newState}`);
    return l;
  }, logs);

  entry.handlerResults.reduce((l, r) => {
    l[r.stateName] ??= [];
    l[r.stateName].push(`\t${r.type} ${r.handlerName}() => ${r.result}`);
    return l;
  }, logs);

  entry.observers.reduce((l, r) => {
    l[r.stateName] ??= [];
    l[r.stateName].push(
      `\tobserved by ${r.observerName}() => ${r.error === undefined ? r.needObserve : `threw ${r.error}`}`,
    );
    return l;
  }, logs);

  console.groupCollapsed(entry.message);

  for (const [, lines] of Object.entries(logs)) {
    for (const line of lines) {
      console.log(line);
    }
  }

  console.log("\nFinal States:");
  Object.entries(entry.finalStates).forEach(([name, state]) => {
    console.debug(`\t${name}: ${state}`);
  });

  console.groupEnd();
};

/**
 * Flushes a labeled lock's buffered entries as one console group.
 *
 * A `lock(target, label)` collects every entry dispatched inside the critical section and emits
 * them here on release, wrapping the per-signal (collapsed) groups in one expanded
 * `console.group(label)` so related signals read as a single unit:
 *
 *     ▼ player play request
 *         ▶ [SF/player] play - OK
 *         ▶ [SF/driver] activate - OK
 *
 * Grouping is a console-presentation concern, so the `console.group`/`console.groupEnd` pair is
 * emitted for the label regardless of the configured handlers (the default sink is the console).
 * Each entry is also tagged with `groupLabel` so non-console handlers can group however they like.
 */
export function emitGrouped(
  handlers: StateFlowLogHandler[],
  label: string,
  entries: StateFlowLogEntry[],
  context: string | null = null,
): void {
  if (entries.length === 0) {
    return;
  }

  if (isConsoleSilenced()) {
    // No console group when silenced (e.g. under vitest), but still deliver every entry to the
    // handlers so structured/custom log sinks keep receiving them.
    for (const entry of entries) {
      entry.groupLabel = label;
      if (context != null) {
        entry.dispatchContext = context;
      }
      for (const handler of handlers) {
        handler(entry);
      }
    }
    return;
  }

  // groupLabel stays the RAW label (consumers assert on it); the interaction context only
  // decorates the console header and rides the entries as the separate dispatchContext field.
  console.group(context != null ? `${label} ⟵ ${context}` : label);
  try {
    for (const entry of entries) {
      entry.groupLabel = label;
      if (context != null) {
        entry.dispatchContext = context;
      }
      for (const handler of handlers) {
        handler(entry);
      }
    }
  } finally {
    console.groupEnd();
  }
}
