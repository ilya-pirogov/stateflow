/**
 * Contains structs for dispatching signals and controlling states
 *
 * @example ```ts
 * const mediaCtrl = {
 *   audio: { volume: 0.5 },
 *   el: document.createElement('video'),
 * };
 *
 * applyFlow(mediaCtrl, [audio], (sm) => {
 *   sm.addEnterHandler(audio.muted, muteEl);
 *   sm.addExitHandler(audio.muted, unmuteEl);
 *   sm.addUpdateHandler(audio.unmuted, changeVolumeEl);
 * });
 *
 * function muteEl(state: audio): Result {
 *   if (mediaCtrl.el.muted) {
 *     return Result.ignore("already muted");
 *   }
 *
 *   mediaCtrl.el.muted = true;
 *   return Result.ok();
 * }
 *
 * function unmuteEl(state: audio): Result {
 *   if (!mediaCtrl.el.muted) {
 *     return Result.ignore("not muted");
 *   }
 *
 *   mediaCtrl.el.muted = false;
 *   return Result.ok();
 * }
 *
 * function changeVolumeEl(state: audio): Result {
 *   if (state.volume < 0 || state volume > 1) {
 *     return Result.reject("incorrect volume");
 *   }
 *   mediaCtrl.el.volume = state.volume;
 * }
 * ```
 */
import { EventEmitter } from "events";

import {
  consoleLogHandler,
  emitGrouped,
  getGlobalDispatchContext,
  type StateFlowLogEntry,
  type StateFlowLogHandler,
  withGlobalLogHandlers,
} from "./logger";
import { mergeResults, Result, ResultCollector, ResultKind } from "./result";
import type { Signal } from "./signal";
import {
  type ArrayToRecord,
  getInitialState,
  getName,
  handleSignal,
  isStateDef,
  type StateDefinition,
  type StateInstance,
  type StateVariant,
  stateAccepts,
} from "./state";
import { DEF, VARIANT } from "./symbols";
import { buildName, StateFlowError } from "./utils";

const managementStateMap = new WeakMap<object, StateFlowMeta>();
const observersMap = new WeakMap<ObserverHandler<any>, Array<ObserverComparer<any>>>();
const currentRC = {
  ref: null as ResultCollector | null,
  set(rc: ResultCollector) {
    this.ref = rc;
  },
  clear() {
    this.ref = null;
  },
};

//#region Helper Types

type EventKind = "enter" | "update" | "exit" | "rollback";

export type StateFlowMeta = {
  emitter: EventEmitter;
  transitioning: Promise<Result> | true | null;
  lockHolder: symbol | null;
  /** FIFO waiters. Each carries its OWN lock id so dispose() can hand ownership
   * over directly (set lockHolder = next.id) with no null-gap window. */
  lockQueue: Array<{ id: symbol; resolve: () => void }>;
  states: Array<StateDefinition>;
  name: string;
  logHandlers: StateFlowLogHandler[];
  /** Active labeled-lock log group. While set, each dispatched entry is buffered here instead of
   * being emitted immediately, then flushed together (under one console group) when the lock
   * releases. Null when no labeled lock is held. `context` is the dispatch-context provider's
   * snapshot captured at `lock()` CALL time (null without a provider — the default).
   * See `lock(target, label)` and `emitGrouped`. */
  logGroup: { label: string; pending: Array<Promise<StateFlowLogEntry>>; context: string | null } | null;
  /** Observation-only per-flow subscribers (see `subscribeFlow`). Each committed or rolled-back
   * state change is delivered to every subscriber as a `FlowChange`, post-commit, on its own
   * macrotask. Empty by default so a flow with no subscribers pays nothing. */
  flowSubscribers: Set<FlowSubscriber>;
};

/**
 * A single state change delivered to a {@link FlowSubscriber}. Describes one state whose
 * variant/props changed within a dispatch, with the real (readable, frozen) state instances
 * before and after.
 */
export interface FlowChange<T = unknown> {
  /** Name of the flow container (the target's `Symbol.toStringTag` / constructor name). */
  flowName: string;
  /** Name of the state definition that changed (e.g. `"playback"`). */
  stateName: string;
  /** Variant name before the change (e.g. `"off"`). */
  prevVariant: string;
  /** Variant name after the change (e.g. `"on"`). */
  nextVariant: string;
  /** The real state instance before the change — frozen, props readable. */
  prev: T;
  /** The real state instance after the change — frozen, props readable. */
  next: T;
  /** Stringified signal that drove the dispatch. */
  signal: string;
  /** `"commit"` for a forward apply, `"rollback"` for an enqueue-chain rollback restore. */
  kind: "commit" | "rollback";
}

/** Observation-only callback invoked once per changed state after commit. See `subscribeFlow`. */
export type FlowSubscriber = (change: FlowChange) => void;

export interface FlowConfig {
  logHandlers?: StateFlowLogHandler[];
}

type ProcessResult = {
  snapshot: Record<string, StateInstance>;
} & {
  //                      [ the state   , description ]
  [K in EventKind]: Array<[StateInstance, string]>;
};

type StateHandler<TProps> = (state: StateInstance<TProps>, context: unknown) => Result;

type ObserverHandler<TProps = unknown> = (state: StateInstance<TProps>) => void;
type ObserverComparer<TProps = unknown> = (a: StateInstance<TProps>, b: StateInstance<TProps>) => void;
type ObserverComparerFn<TProps = unknown> = (a: TProps, b: TProps) => boolean;

type Disposer = {
  [Symbol.dispose](): void;
};

export interface StateManager {
  addEnterHandler<TProps>(state: StateVariant<TProps>, cb: StateHandler<TProps>, context?: unknown): void;

  addExitHandler<TProps>(state: StateVariant<TProps>, cb: StateHandler<TProps>, context?: unknown): void;

  addUpdateHandler<TProps>(state: StateVariant<TProps>, cb: StateHandler<TProps>, context?: unknown): void;

  addRollbackHandler<TProps>(state: StateVariant<TProps>, cb: StateHandler<TProps>, context?: unknown): void;
}

type StateManagerCallback = (sm: StateManager) => void;

export type DispatchFn = ((signal: Signal, mute?: boolean) => Result) & {
  [Symbol.asyncDispose](): Promise<void>;
};

//#endregion

//#region Helper Functions

/**
 * Builds a key for event emitter
 */
function eventKey(kind: EventKind | "observe", state: string): string {
  return `${kind}:${state}`;
}

/**
 * @throws StateFlowError if target is not state flow object
 */
function stateMeta(target: object): StateFlowMeta {
  const meta = managementStateMap.get(target);
  if (meta == null) {
    throw new StateFlowError(`${buildName(target)} doesn't contains state flows`);
  }
  return meta;
}

//#endregion

/**
 * Watches for state changes of the specified group.
 * Returns a function to stop watching.
 */
function addStateHandler(
  emitter: EventEmitter,
  kind: EventKind,
  stateVar: StateVariant,
  cb: StateHandler<any>,
  ctx?: unknown,
): void {
  const wrapper = (
    state: StateInstance,
    snapshot: Record<string, StateInstance>,
    stateUpd: string,
    collector?: ResultCollector,
  ): void => {
    const handlerName = buildName(ctx, cb);
    try {
      const res = cb.apply(ctx, [state, snapshot]);
      if (!(res instanceof Result)) {
        throw new StateFlowError(`Handler '${handlerName}' returned not result`);
      }
      collector?.logHandler(String(stateVar[DEF]), kind, handlerName, res);
      collector?.push(res.withHandlerName(handlerName).withStateUpdating(stateUpd));
    } catch (err) {
      collector?.logHandler(String(stateVar[DEF]), kind, handlerName, err);
      collector?.push(Result.error(err).withHandlerName(handlerName).withStateUpdating(stateUpd));
    }
  };

  emitter.on(eventKey(kind, String(stateVar)), wrapper);
}

/**
 * Initializes a state management system on a target object by applying state definitions
 * and configuring event handlers.
 *
 * @param target - The object that will hold the state values and receive state updates
 * @param states - Array of state definitions that define the possible states and transitions
 * @param initializer - Callback function to set up state change handlers
 * @param config - State Flow configuration
 * @throws StateFlowError if state definitions are invalid or state objects are not found on target
 *
 * @example
 * ```ts
 * const mediaController = {
 *   audioState: { volume: 0.5 },
 *   videoState: { playing: false }
 * };
 *
 * applyFlow(mediaController, [audioState, videoState], (sm) => {
 *   sm.addEnterHandler(audioState.muted, handleMute);
 *   sm.addExitHandler(videoState.playing, handlePause);
 * });
 * ```
 */
export function applyFlow<TStates extends Array<object>>(
  target: ArrayToRecord<TStates>,
  states: TStates,
  initializer: StateManagerCallback,
  config: FlowConfig = {},
): void {
  for (const def of states) {
    if (!isStateDef(def)) {
      throw new StateFlowError("Incorrect state definition");
    }
    const name = getName(def);

    const st = target[name];
    if (st == null) {
      throw new StateFlowError(`State object ${name} not found`);
    }

    Object.defineProperty(target, name, { value: getInitialState(def)(st) });
  }

  const logHandlers = config.logHandlers?.length ? config.logHandlers : [consoleLogHandler];

  const emitter = new EventEmitter();
  managementStateMap.set(target, {
    emitter,
    logHandlers,
    states: states as StateDefinition[],
    transitioning: null,
    lockHolder: null,
    lockQueue: [],
    logGroup: null,
    flowSubscribers: new Set(),
    name: String(Symbol.toStringTag in target ? target[Symbol.toStringTag] : target.constructor.name),
  });

  initializer({
    addEnterHandler: addStateHandler.bind(null, emitter, "enter"),
    addUpdateHandler: addStateHandler.bind(null, emitter, "update"),
    addExitHandler: addStateHandler.bind(null, emitter, "exit"),
    addRollbackHandler: addStateHandler.bind(null, emitter, "rollback"),
  });
}

function prepareSnapshot(target: object): Record<string, StateInstance> {
  const meta = managementStateMap.get(target);
  if (meta == null) {
    return {};
  }

  return Object.fromEntries(
    meta.states.map((s) => [s[Symbol.toStringTag], Reflect.get(target, s[Symbol.toStringTag])]),
  ) as Record<string, StateInstance>;
}

/**
 * Dispatches a signal to trigger state transitions in the target object.
 *
 * @deprecated Prefer `await using send = await lock(target); await send(sig).expect(...).done()`.
 * Bare `dispatch()` throws under a held lock / active transition (see the guards below);
 * only use it for synchronous teardown or pre-lock bootstrap. Every other caller should
 * acquire a lock so signals queue behind any in-flight transition instead of throwing.
 *
 * @param target - Object containing the states to be updated
 * @param signal - Signal object that triggers state transitions
 * @param mute - Do not emit log for that
 * @returns Result object indicating success, failure, or transition status
 * @throws StateFlowError if a lock is held or states are transitioning
 *
 * @example
 * ```ts
 * // Preferred: acquire a lock so dispatches queue instead of throwing.
 * await using send = await lock(player);
 * await send(signals.play()).expect(ResultKind.OK, ResultKind.Ignored).done();
 * await send(signals.seek({ time: 50 })).done();
 * // lock released automatically at scope exit
 *
 * // Escape hatch only — synchronous teardown or pre-lock bootstrap, where an async
 * // lock cannot be awaited (e.g. page-unload, or a constructor before any lock exists):
 * dispatch(player, signals.dispose({ reason: "page unloaded" }));
 * ```
 */
export function dispatch(target: object, signal: Signal, mute = false): Result {
  const meta = stateMeta(target);

  if (meta.lockHolder != null) {
    throw new StateFlowError("Lock is held. Use `await using send = lock(target)` for queued access");
  }
  if (meta.transitioning != null) {
    throw new StateFlowError("States are in transitioning. Use `await sync(obj)` or await a previous result");
  }

  const chainSnapshot = prepareSnapshot(target);
  const result = dispatchCore(target, signal, meta, mute);
  return processEnqueueChain(target, result, meta, chainSnapshot, mute);
}

/**
 * Acquires an exclusive lock on the target for dispatching multiple signals.
 * Use with `await using` for automatic cleanup.
 *
 * @param target - Object containing the states to lock
 * @param label - Optional short label for the critical section. When given, every entry logged
 *   inside the lock is buffered and flushed together under one `console.group(label)` on release,
 *   so a multi-signal operation reads as a single unit (see `emitGrouped`). Because entries are
 *   buffered, a labeled lock's logs appear together at release rather than one-by-one in real time
 *   — that delay is what makes correct nesting possible. Omit the label for unchanged, immediate
 *   per-entry logging.
 * @returns A callable DispatchFn that dispatches signals while holding the lock
 *
 * @example
 * ```ts
 * await using send = await lock(player, "player play request");
 * await send(signals.play()).done();
 * await send(signals.seek({ time: 50 })).done();
 * // lock released automatically at scope exit; the two signals log under one "player play request" group
 * ```
 */
export async function lock(target: object, label?: string): Promise<DispatchFn> {
  const meta = stateMeta(target);
  const id = Symbol("lock");

  // Captured SYNCHRONOUSLY at call time — an async function body runs in the caller's stack
  // up to its first await, so for UI-triggered locks this still executes inside the
  // interaction event's synchronous propagation (the whole point: by the time `send()` runs,
  // microtask hops have long left that stack). Null without a provider — the default.
  const dispatchContext = label != null ? getGlobalDispatchContext() : null;
  const lockRequestedAt = dispatchContext != null ? Date.now() : 0;

  // Claim ownership. If the lock is held OR anyone is already queued, wait our
  // FIFO turn; otherwise take it immediately. This claim is SYNCHRONOUS (no await
  // between the check and the assignment), so two concurrent lock() calls can never
  // both take it. dispose() hands ownership DIRECTLY to the next waiter (sets
  // lockHolder = next.id before resolving), so there is no window where lockHolder
  // is null while a waiter is about to resume — which previously let a racing
  // lock() slip in front of a woken waiter and invalidate its handle
  // ("Lock has been released").
  if (meta.lockHolder != null || meta.lockQueue.length > 0) {
    await new Promise<void>((resolve) => meta.lockQueue.push({ id, resolve }));
    // resumed: dispose() has already set meta.lockHolder = id for us
  } else {
    meta.lockHolder = id;
  }

  // We now hold the lock exclusively; drain any in-flight async transition before
  // the caller dispatches. (The previous holder's dispose already awaited its own
  // transition before handing off, so this is normally a no-op.)
  await sync(target);

  // Start buffering this critical section's log entries so they flush as one labeled group on
  // release. Set AFTER sync() so entries drained from a previous holder don't join this group.
  if (label != null) {
    // The wait between requesting and holding the lock (queue + transition drain) is the
    // window in which a user gesture's transient activation can expire — surface it when
    // it is long enough to matter.
    const lockWaitMs = dispatchContext != null ? Date.now() - lockRequestedAt : 0;
    const context =
      dispatchContext != null && lockWaitMs >= 5 ? `${dispatchContext} [lock ${lockWaitMs}ms]` : dispatchContext;
    meta.logGroup = { label, pending: [], context };
  }

  let chainSnapshot: Record<string, StateInstance> | null = null;

  const dispose = async (): Promise<void> => {
    if (meta.lockHolder !== id) {
      return;
    }

    // wait for any pending async transition before releasing
    if (meta.transitioning instanceof Promise) {
      await meta.transitioning;
    }

    chainSnapshot = null;

    // Flush this lock's buffered entries as one grouped console block before handing off, so a
    // following lock's signals never interleave with ours. We still hold the lock here, so no
    // other dispatch can add to the group. allSettled keeps a rejected finish from dropping the
    // rest of the group.
    const group = meta.logGroup;
    if (group != null) {
      meta.logGroup = null;
      const settled = await Promise.allSettled(group.pending);
      const entries: StateFlowLogEntry[] = [];
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          entries.push(outcome.value);
        }
      }
      emitGrouped(withGlobalLogHandlers(meta.logHandlers), group.label, entries, group.context);
    }

    // Hand ownership directly to the next waiter (no null-gap), else free the lock.
    const next = meta.lockQueue.shift();
    if (next) {
      meta.lockHolder = next.id;
      next.resolve();
    } else {
      meta.lockHolder = null;
    }
  };

  const send: DispatchFn = Object.assign(
    (signal: Signal, mute = false): Result => {
      if (meta.lockHolder !== id) {
        throw new StateFlowError("Lock has been released");
      }

      // capture chain snapshot on first dispatch within this lock
      if (chainSnapshot == null) {
        chainSnapshot = prepareSnapshot(target);
      }

      const result = dispatchCore(target, signal, meta, mute);
      return processEnqueueChain(target, result, meta, chainSnapshot, mute);
    },
    { [Symbol.asyncDispose]: dispose },
  );

  return send;
}

/**
 * Core dispatch logic — processes a single signal through the state machine.
 * Does not check lock or transitioning state — callers must do that.
 */
function dispatchCore(target: object, signal: Signal, meta: StateFlowMeta, mute: boolean): Result {
  const st = new Error().stack;

  // for collecting results from all handlers; an unresolved transition at this
  // point means this dispatch runs against PRE-commit variants (legal under a
  // held lock) — flag it so the log exposes the stale-read window.
  const collector = new ResultCollector(meta.name, signal, meta.transitioning != null);
  let result: Result = Result.ignore("");
  let snapshot = prepareSnapshot(target);

  try {
    // at first, we need to make the flow is not rejecting
    // this signal and get sorted states
    result = prepareStatesAfterSignal(target, signal, meta.states, collector);

    // no need to continue in that case
    if (!result.in(ResultKind.OK) || result.data == null) {
      return result.withSignal(signal).withStacktrace(st ?? null);
    }

    const processResult = result.data as ProcessResult;
    snapshot = processResult.snapshot;

    // handle all event kinds
    // order matters!
    for (const kind of ["exit", "update", "enter"] as const) {
      processHandlers(kind, meta.emitter, processResult[kind], snapshot, collector);

      // getting final result based on all handlers
      result = collector.merge();

      if (result.in(ResultKind.Rejected, ResultKind.Error)) {
        // rollback in case of error
        processHandlers("rollback", meta.emitter, processResult.rollback, prepareSnapshot(target), collector);
        return result.withSignal(signal).withStacktrace(st ?? null);
      }
    }
    // to turn 'ignored' into 'ok'
    result = result.merge(Result.ok());

    // log enqueued signals from handlers
    for (const enqueued of result.enqueuedSignals) {
      collector.logEnqueue(String(enqueued), result.message ?? "handler");
    }

    // DEV warning (warn-only guard): the BLESSED enqueue pattern is the
    // self-terminating same-target record chain — exactly ONE enqueued signal per
    // dispatch cycle (the nested re-loop in processEnqueueChain re-dispatches each
    // signal in its own cycle, so a legitimate chain never accumulates >1 here).
    // More than one enqueued signal in a SINGLE cycle means two DIFFERENT handlers
    // co-enqueued — the genuinely-forbidden case. We do NOT reject it; we only warn
    // so the chain stays intact while the misuse surfaces in the dev console.
    if (result.enqueuedSignals.length > 1) {
      console.warn(
        `[SF/${meta.name}] ${String(signal)}: ${result.enqueuedSignals.length} signals were enqueued in a single ` +
          `dispatch cycle by different handlers (${result.enqueuedSignals.map(String).join(", ")}). ` +
          "Only ONE enqueue per cycle (the self-terminating record chain) is supported; " +
          "co-enqueuing from multiple handlers is unsupported and may not behave as expected.",
      );
    }

    if (result.kind !== ResultKind.InTransition) {
      meta.transitioning = true;
      // sync result — apply state immediately
      applyState(target, snapshot, collector);
    } else {
      // async — defer state application until transition completes.
      // meta.transitioning is the FULL processing chain: await executors → apply state
      // → process enqueued signals. This ensures .done() returns the final result
      // including any rejections from enqueued signals.
      meta.transitioning = result
        .withMeta(meta)
        .waitAll()
        .then((res) => {
          meta.transitioning = null;

          if (res.kind === ResultKind.OK) {
            // Capture pre-apply snapshot for rollback if enqueued signals fail.
            const preTransitionSnap = res.enqueuedSignals.length > 0 ? prepareSnapshot(target) : null;

            applyState(target, snapshot, collector);

            // Process enqueued signals from the resolved transition.
            // This enables Result.enqueue() inside Result.transition() callbacks.
            if (preTransitionSnap && res.enqueuedSignals.length > 0) {
              const enqResult = processEnqueueChain(target, res, meta, preTransitionSnap, mute);
              if (enqResult.in(ResultKind.Rejected, ResultKind.Error)) {
                return enqResult;
              }
            }
          } else if (res.in(ResultKind.Rejected, ResultKind.Error)) {
            processHandlers("rollback", meta.emitter, processResult.rollback, prepareSnapshot(target), collector);
          }
          return res;
        });
    }

    return result
      .withMeta(meta)
      .withSignal(signal)
      .withStacktrace(st ?? null);
  } finally {
    if (meta.transitioning === true) {
      meta.transitioning = null;
    }

    if (!mute) {
      const finished = collector.finish(snapshot, result);
      const group = meta.logGroup;
      if (group != null) {
        // Under a labeled lock: buffer the entry; lock dispose() flushes the whole group.
        group.pending.push(finished);
      } else {
        finished
          .then((entry) => {
            withGlobalLogHandlers(meta.logHandlers).forEach((handler) => {
              handler(entry);
            });
          })
          .catch(() => {});
      }
    }
  }
}

/**
 * Processes enqueued signals from a dispatch result.
 * Each enqueued signal is dispatched in sequence within the same lock.
 * If any enqueued dispatch fails, rolls back all state to the chain snapshot.
 */
function processEnqueueChain(
  target: object,
  result: Result,
  meta: StateFlowMeta,
  chainSnapshot: Record<string, StateInstance>,
  mute: boolean,
): Result {
  let current = result;

  while (current.enqueuedSignals.length > 0) {
    const signals = [...current.enqueuedSignals];

    for (const signal of signals) {
      const enqResult = dispatchCore(target, signal as Signal, meta, mute);

      if (enqResult.in(ResultKind.Rejected, ResultKind.Error)) {
        // full rollback to pre-chain state
        rollbackToSnapshot(target, chainSnapshot, meta, String(signal));
        return enqResult;
      }

      current = enqResult;
    }
  }

  return current;
}

/**
 * Restores all states on target from a snapshot.
 * Emits a `"rollback"` FlowChange for every state actually restored (only when subscribers exist).
 */
function rollbackToSnapshot(
  target: object,
  snapshot: Record<string, StateInstance>,
  meta: StateFlowMeta,
  signal: string,
): void {
  const changes: FlowChange[] | null = meta.flowSubscribers.size > 0 ? [] : null;
  for (const [key, value] of Object.entries(snapshot)) {
    const prev = Reflect.get(target, key);
    if (changes != null && prev !== value) {
      changes.push(buildFlowChange(meta, key, prev, value, signal, "rollback"));
    }
    Reflect.set(target, key, value);
  }
  if (changes != null) {
    emitFlowChanges(meta, changes);
  }
}

/**
 * Collect new states after the signal flow
 * If noting was handled the signal then it returns "ignored" result
 * If at least one handler was failed, it returns "error" or "rejected" result
 * Otherwise, it returns snapshot with new states and lists of sorted states
 * for further handling
 */
function prepareStatesAfterSignal(
  target: object,
  signal: Signal,
  states: Array<StateDefinition>,
  collector: ResultCollector,
): Result<ProcessResult> {
  const processResult: ProcessResult = {
    snapshot: Object.fromEntries(states.map((s) => [s[Symbol.toStringTag], s(target)])),
    enter: [],
    update: [],
    exit: [],
    rollback: [],
  };

  const results: Result[] = [];
  // Variants that declare NO handler for this signal — kept so a full-miss
  // dispatch can report WHICH states were active instead of a bare "Ignored".
  const unhandled: string[] = [];

  // collect new states after signal flow
  for (const def of states) {
    const name = getName(def);
    const oldState = def(target);

    if (!stateAccepts(oldState, signal[Symbol.toStringTag])) {
      unhandled.push(String(oldState[Symbol.toStringTag]));
    }

    const result = handleSignal(oldState, signal, processResult.snapshot);
    switch (result.kind) {
      // state was successfully changed
      case ResultKind.OK: {
        const newState = result.data as StateInstance;
        const desc = `'${oldState}->${newState}'`;
        processResult.snapshot[name] = newState;
        collector.logStateChange(def[Symbol.toStringTag], oldState, newState);

        if (newState[VARIANT] === oldState[VARIANT]) {
          processResult.update.push([newState, `update ${desc}`]);
        } else {
          processResult.enter.push([newState, `enter to ${desc}`]);
          processResult.exit.push([oldState, `exit from ${desc}`]);
        }
        processResult.rollback.push([oldState, `rollback ${desc}`]);

        break;
      }

      // the signal was ignored completely
      case ResultKind.Ignored:
        processResult.snapshot[name] = oldState;
        break;

      // got incorrect result
      case ResultKind.InTransition:
        // stop handling the signal immediately
        // because there is no point to continue with an error
        return Result.error<ProcessResult>(new StateFlowError("Transition is not allowed in flow handlers")).withSignal(
          signal,
        );

      // Error or Rejected are left
      default:
        // stop handling the signal immediately either
        // by the same reason
        return result as Result<any>;
    }

    results.push(result);
  }

  const final = mergeResults(results);
  if (final.kind !== ResultKind.OK) {
    // A signal that NO active variant handles dies as Ignored with an empty
    // message — historically the hardest log entry to interpret (is the state
    // wrong, or the signal?). Name the active variants so the log answers it.
    if (final.kind === ResultKind.Ignored && final.message == null && unhandled.length === states.length) {
      return Result.ignore(`no handler in ${unhandled.join(", ")}`) as Result<ProcessResult>;
    }
    return final as Result<ProcessResult>;
  }
  return Result.ok(processResult);
}

function applyState(target: object, snapshot: Record<string, StateInstance>, rc: ResultCollector): void {
  const meta = stateMeta(target);
  // Only allocate/collect when someone is listening — zero-cost otherwise.
  const changes: FlowChange[] | null = meta.flowSubscribers.size > 0 ? [] : null;

  currentRC.set(rc);
  for (const [key, value] of Object.entries(snapshot)) {
    const prev = Reflect.get(target, key);
    if (value !== prev) {
      meta.emitter.emit(eventKey("observe", String(value[VARIANT])), prev, value);
      if (changes != null) {
        changes.push(buildFlowChange(meta, key, prev, value, rc.signal, "commit"));
      }
      Reflect.set(target, key, value);
    }
  }
  currentRC.clear();

  if (changes != null) {
    emitFlowChanges(meta, changes);
  }
}

/**
 * Builds one observation-only change record from the pre/post state instances.
 */
function buildFlowChange(
  meta: StateFlowMeta,
  stateName: string,
  prev: StateInstance,
  next: StateInstance,
  signal: string,
  kind: "commit" | "rollback",
): FlowChange {
  return {
    flowName: meta.name,
    stateName,
    prevVariant: String(prev[VARIANT][Symbol.toStringTag]),
    nextVariant: String(next[VARIANT][Symbol.toStringTag]),
    prev,
    next,
    signal,
    kind,
  };
}

/**
 * Delivers each change to every current subscriber on its OWN post-commit macrotask.
 * Subscribers are observation-only: a throwing subscriber is swallowed so it can never
 * affect the dispatch or the other subscribers, and delivery is re-checked against the
 * live set so a subscriber disposed after scheduling stops receiving.
 */
function emitFlowChanges(meta: StateFlowMeta, changes: FlowChange[]): void {
  if (changes.length === 0 || meta.flowSubscribers.size === 0) {
    return;
  }
  const subscribers = [...meta.flowSubscribers];
  for (const change of changes) {
    for (const subscriber of subscribers) {
      setTimeout(() => {
        if (!meta.flowSubscribers.has(subscriber)) {
          return;
        }
        try {
          subscriber(change);
        } catch {
          /* observation-only: never affect dispatch or other subscribers */
        }
      }, 0);
    }
  }
}

function processHandlers(
  kind: EventKind,
  emitter: EventEmitter,
  states: Array<[StateInstance, string]>,
  snapshot: Record<string, StateInstance>,
  collector?: ResultCollector,
): void {
  // handle states
  for (const [state, desc] of states) {
    const key = eventKey(kind, String(state[VARIANT]));
    emitter.emit(key, snapshot[state[VARIANT][DEF][Symbol.toStringTag]], snapshot, desc, collector);
  }
}

/**
 * Waits for all pending state transitions to complete on the target object.
 *
 * @param target - Object containing states that may be transitioning
 * @returns Promise that resolves when all transitions are complete
 * @throws StateFlowError if target object is not initialized with applyFlow
 *
 * @example
 * ```ts
 * async function play() {
 *   await sync(player);
 *
 *   dispatch(player, signals.play()); // Now safe to dispatch new signals
 * }
 * ```
 */
export async function sync(target: object): Promise<void> {
  const meta = stateMeta(target);
  const transitioning = meta.transitioning;
  if (transitioning instanceof Promise) {
    return new Promise((r) => {
      const wait = () => {
        if (meta.transitioning == null) {
          r();
          return;
        }

        transitioning.finally(() => setTimeout(wait, 0)).catch(() => {});
      };

      wait();
    });
  }
}

/**
 * Creates an observer that watches for changes in specific state variants.
 * The observer is automatically cleaned up when the returned Disposer is disposed.
 *
 * @param target - Object containing the states to observe
 * @param stateVariants - Array of state variants to watch for changes
 * @param handlerFn - Callback function executed when observed states change
 * @param compareFn - Optional function to determine if states are different
 * @param ctx
 * @returns Disposer object that cleans up the observer when disposed
 *
 * @example
 * ```ts
 * using observer = observe(
 *   player,
 *   [audioState.muted, audioState.playing],
 *   (state) => console.log(`Audio state changed: ${state}`),
 *   (prev, curr) => prev.volume !== curr.volume
 * );
 * ```
 */
export function observe<T>(
  target: object,
  stateVariants: StateVariant<T>[],
  handlerFn: ObserverHandler<T>,
  compareFn: ObserverComparerFn<T> = (a, b) => a !== b,
  ctx?: object,
): Disposer {
  const meta = stateMeta(target);

  for (const stateVar of stateVariants) {
    subscribe(meta.emitter, stateVar, compareFn, handlerFn, ctx);
  }

  return {
    [Symbol.dispose]: () => {
      for (const stateVar of stateVariants) {
        unsubscribe(meta.emitter, stateVar, handlerFn);
      }
    },
  };
}

/**
 * Subscribes to committed state changes of a flow, observation-only.
 *
 * Unlike {@link observe}, a `subscribeFlow` subscriber cannot influence the flow at all: it
 * receives a plain {@link FlowChange} value (with the real, frozen `prev`/`next` state instances)
 * and has no handle to dispatch, enqueue, or mutate flow state. It runs strictly AFTER the state
 * has committed, each change on its own macrotask, so nothing it does can reorder or block the
 * dispatch. A throwing subscriber is isolated — it never affects the dispatch or other subscribers.
 *
 * One {@link FlowChange} is delivered per state that actually changed in a dispatch: `kind` is
 * `"commit"` on a forward apply and `"rollback"` when an enqueue-chain failure restores prior
 * state. With no subscribers registered, dispatch is entirely unaffected and pays nothing.
 *
 * @param target - Object initialized with {@link applyFlow}
 * @param subscriber - Observation-only callback invoked once per changed state, post-commit
 * @returns A {@link Disposer} — dispose it (e.g. via `using`) to stop delivery
 * @throws StateFlowError if `target` was not initialized with {@link applyFlow}
 *
 * @example
 * ```ts
 * using sub = subscribeFlow(player, (change) => {
 *   console.log(`${change.flowName}.${change.stateName}: ${change.prevVariant} -> ${change.nextVariant}`);
 *   // change.prev / change.next are the real, readable state instances
 * });
 * ```
 */
export function subscribeFlow(target: object, subscriber: FlowSubscriber): Disposer {
  const meta = stateMeta(target);
  meta.flowSubscribers.add(subscriber);
  return {
    [Symbol.dispose]: () => {
      meta.flowSubscribers.delete(subscriber);
    },
  };
}

function subscribe<T>(
  emitter: EventEmitter,
  stateVar: StateVariant,
  cmpFn: ObserverComparerFn<T>,
  hdlFn: ObserverHandler<T>,
  ctx?: object,
) {
  const key = eventKey("observe", String(stateVar));
  const cb: ObserverComparer<T> = (a, b) => {
    const needObserve = cmpFn(a, b);
    currentRC.ref?.logObserver(String(stateVar[DEF]), buildName(ctx, hdlFn), needObserve);
    if (needObserve) {
      setTimeout(() => hdlFn(b), 0);
    }
  };
  emitter.on(key, cb);
  observersMap.set(hdlFn, [...(observersMap.get(hdlFn) ?? []), cb]);
}

function unsubscribe<T>(emitter: EventEmitter, stateVar: StateVariant, hdlFn: ObserverHandler<T>) {
  const key = eventKey("observe", String(stateVar));
  const cbs = observersMap.get(hdlFn);
  cbs?.forEach((cb) => {
    emitter.off(key, cb);
  });
}

export function disposeFlow(target: object): void {
  const meta = stateMeta(target);
  meta.emitter.removeAllListeners();
  Reflect.deleteProperty(meta, "emitter");
  for (const state of meta.states) {
    Reflect.deleteProperty(target, state[Symbol.toStringTag]);
  }
}
