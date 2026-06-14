import type { CompactStackTrace } from "./utils";

// will be replaced to lively domain after deploying stacktrace-viewer
const STACKTRACE_VIEWER_URL = "https://stacktrace.pirogov.dev/";

export interface StateFlowLogEntry {
  // Flow identification
  flowName: string;
  signal: string;
  isAsync: boolean;
  startTime: number;
  duration?: number; // Present for completed async transitions
  /** Monotonic per-page dispatch-START order, shared across ALL flows. Entries are
   * delivered (and recorded) in FINISH order; sort by this to reconstruct the true
   * dispatch timeline, including same-millisecond ties. The engine always sets it on
   * fresh entries; it is optional because hand-built entries (fixtures, replay tooling)
   * and recordings from older builds predate the field. */
  dispatchOrder?: number;
  /** Set when this dispatch STARTED while the flow still had an unresolved async
   * transition: it ran against PRE-commit state variants (a held lock permits this).
   * The classic stale-read race signature — an Ignored/unexpected result here usually
   * means the signal raced the previous transition's commit. */
  duringTransition?: boolean;
  message: string; // Formatted message suitable for logging

  // States
  finalStates: Record<string, string>;

  // State changes or attempts
  stateChanges: Array<{
    newState: string;
    oldState: string;
    stateName: string;
  }>;

  // Handler executions
  handlerResults: Array<{
    type: "enter" | "exit" | "update" | "rollback";
    handlerName: string;
    stateName: string;
    result: string;
  }>;

  observers: Array<{
    observerName: string;
    stateName: string;
    needObserve: boolean;
  }>;

  // Enqueued signal chain
  enqueuedSignals: Array<{
    signal: string;
    fromHandler: string;
  }>;

  stacktrace: CompactStackTrace | null;

  // Final result
  finalResult: string;

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
    l[r.stateName].push(`\tobserved by ${r.observerName}() => ${r.needObserve}`);
    return l;
  }, logs);

  console.groupCollapsed(entry.message);

  for (const [, rows] of Object.entries(logs)) {
    for (const row of rows) {
      console.log(row);
    }
  }

  if (entry.enqueuedSignals.length > 0) {
    console.log("\nEnqueued Signals:");
    for (const enq of entry.enqueuedSignals) {
      console.log(`\t${enq.signal} (from ${enq.fromHandler})`);
    }
  }

  console.log("\nFinal States:");
  Object.entries(entry.finalStates).forEach(([name, state]) => {
    console.debug(`\t${name}: ${state}`);
  });

  if (entry.stacktrace != null) {
    console.log("\nStacktrace:");
    console.log(`${STACKTRACE_VIEWER_URL}#${btoa(JSON.stringify(entry.stacktrace))}`);
  }

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
