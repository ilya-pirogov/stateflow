/**
 * Applies flows to targets and dispatches signals to them: applyFlow, lock and its send, the abort of a pending
 * transition, observers, subscribers and disposeFlow.
 *
 * @example ```ts
 * const mediaCtrl = {
 *   audio: { volume: 0.5 }, // applyFlow builds the initial instance from these props
 *   el: document.createElement("video"),
 * };
 *
 * applyFlow(mediaCtrl, [audio], (sm) => {
 *   sm.addEnterHandler(audio.muted, muteEl);
 *   sm.addExitHandler(audio.muted, unmuteEl);
 *   sm.addUpdateHandler(audio.unmuted, changeVolumeEl);
 * });
 *
 * type Audio = InstanceOf<typeof audio>;
 *
 * function muteEl(state: Audio): HandlerResult {
 *   if (mediaCtrl.el.muted) {
 *     return HandlerResult.ignored("already muted");
 *   }
 *
 *   mediaCtrl.el.muted = true;
 *   return HandlerResult.ok();
 * }
 *
 * function unmuteEl(state: Audio): HandlerResult {
 *   if (!mediaCtrl.el.muted) {
 *     return HandlerResult.ignored("not muted");
 *   }
 *
 *   mediaCtrl.el.muted = false;
 *   return HandlerResult.ok();
 * }
 *
 * // Every handler gets the instance it is about, the frozen snapshot and the previous instance.
 * function changeVolumeEl(state: Audio, snapshot: FlowSnapshot, prev: Audio): HandlerResult {
 *   if (state.volume === prev.volume) {
 *     return HandlerResult.ignored("same volume");
 *   }
 *   mediaCtrl.el.volume = state.volume;
 *   return HandlerResult.ok();
 * }
 *
 * await using send = await lock(mediaCtrl);
 * send(signals.mute()).expect(ResultKind.OK);
 * ```
 */
import { EventEmitter } from "events";

import { DisposableBox, madeDisposableBoxes } from "./box";
import {
  type ChangePredicate,
  type HandlerRegistry,
  handlersFor,
  type Registered,
  type StateManager,
  stateManager,
  stepResult,
  transitionResult,
} from "./handlers";
import {
  consoleLogHandler,
  emitGrouped,
  getGlobalDispatchContext,
  type StateFlowLogEntry,
  type StateFlowLogHandler,
  withGlobalLogHandlers,
} from "./logger";
import { isInReducer } from "./reducer-scope";
import {
  type DeclaredAnswer,
  fold,
  type NamedResult,
  type Reduction,
  type ResultToFold,
  reduce,
  reduceResult,
  type TreeReducers,
} from "./reducers";
import { HandlerResult, mergeResults, Result, ResultCollector, ResultKind, Verdict } from "./result";
import type { Signal } from "./signal";
import {
  type AnyDefinition,
  type AnyVariant,
  type ArrayToRecord,
  type FailureData,
  type FlowSnapshot,
  getInitialState,
  getName,
  type InstanceOfVariant,
  isState,
  isStateDef,
  type StateDefinition,
  type StateInstance,
  type StateVariant,
} from "./state";
import { DEF, FAILURE, RESULT_REDUCERS, VARIANT } from "./symbols";
import {
  type AsynchronousEntry,
  addHeldDefinitions,
  addPlaces,
  adopt,
  compose,
  diffNode,
  face,
  findAsynchronousEntry,
  findAsynchronousEntryIn,
  findLostAnswer,
  findLostChange,
  findTransitional,
  findTransitionalIn,
  type HandlerCall,
  heldAt,
  instanceAt,
  type Path,
  type Place,
  pathName,
  placesIn,
  replaceAt,
  type StateChange,
  samePath,
  type TreeDiff,
  topLevel,
} from "./tree";
import { buildName, type Infer, isThenable, StateFlowError, TransitionAborted } from "./utils";

const managementStateMap = new WeakMap<object, StateFlowMeta>();

/** The values of the DisposableBoxes the engine disposed, each once (see disposeCarried); a WeakSet, so it holds none
 * of them alive. A plan that places one again is refused (see findBoxError). */
const disposedValues = new WeakSet<object>();

/**
 * What a tap is told: each dispatch's signal, each handler's result, and each step's end. A recorder keeps them to run
 * a session again with every handler off (see {@link addFlowTap}). `dispatched` and `handled` are told inside the
 * step, before it commits, except a late answer (see `handled`); `ended` after it. While a tap is told, its dispatch
 * to the target and its disposeFlow throw, as a handler's do, and the throw is reported as any throw of a tap is.
 *
 * Every `dispatched` whose dispatch returns is followed by exactly one `ended` with the same signal object, for a step
 * its reducers refuse or ignore and a refused abort too; a declared transition's end adds one more `ended`, marked
 * final or failed, with no `dispatched`. A tool pairs them by the signal's identity, as it pairs a late answer with
 * the call an `ended` listed as unsettled. An accepted abort drops that end, and the abort's own `ended` lists the
 * works it dropped unsettled. A transition pending when its flow is disposed gets no end. A dispatch that throws is
 * outside this: once it was told `dispatched`, only a string form, an Error's getter or a flow timer that throws
 * makes it throw, and it is then told its `ended`, with the Error, only when the throw came from its step. A tap added
 * or removed between a step's `dispatched` and its `ended` gets only the one told while it was there.
 * The order of the tellings, for one target:
 * - a plain step, one its reducers refuse or ignore, and one a handler refuses whose failed step commits:
 *   `dispatched`, then `handled` for each handler of the step and of its failed step, then `ended`;
 * - a declared transition: `dispatched`, the temp step's `handled`, `ended` marked temp; then, as its work settles,
 *   each work's `handled`, the end step's, and `ended` marked final or failed; with no work, all of it inside the send;
 * - a timeout, or a work's refusal while another work is unsettled: `ended` marked failed lists the unsettled works,
 *   and their answers, if they come, are told to `handled` after it;
 * - an accepted abort: its `dispatched` when it is sent; a work that answers the abort is told to `handled`; once the
 *   work settled or the wait ended, the abort's step's `handled` and its `ended`, marked abort;
 * - a refused abort: `dispatched`, then `ended` marked abort; the transition goes on;
 * - a send queued behind a transition: its `dispatched` and the rest at its turn, after that transition's `ended`;
 * - a muted dispatch: as any other, though it writes no entry;
 * - a dispatch a handler makes to another target: that target's tellings inside the handler's call, so before the
 *   handler's own `handled`, but for the end of a transition it declares with work, which comes as its work settles;
 * - disposeFlow with a transition pending: nothing more of it but the late answers.
 */
export type FlowTap = {
  /** `signal` is dispatched to `target`, before its reducers run: a send, a bare dispatch, a queued send at its turn,
   * an abort when it is sent; a muted dispatch too, and one its reducers refuse or ignore. */
  dispatched(target: object, signal: Signal): void;
  /**
   * A handler of `kind` gave `result` in `call`, one call of a step on one node: what an exit, update or enter handler
   * returned, or what a transition handler's promise settled to, a throw as its Error, told when it settles: before the
   * transition's end commits, or, for a late answer that settles once the transition ended (its timeout, another
   * work's refusal, an abort, disposeFlow), after that end committed. A named result's name and data are in
   * `result.named`, the data a refusal carries in `result.data`. `call.name` is the node's path as the log names it,
   * `call.instance` the instance the handler got; every handler of one call is told with the same `call` object, and
   * another call has another.
   * A commit handler is not told: it runs after the commit, and what it gives changes no state.
   */
  handled(
    target: object,
    kind: "exit" | "update" | "enter" | "transition",
    call: { readonly name: string; readonly instance: StateInstance },
    result: Result,
  ): void;
  /**
   * One step of `target` ended: told once for every log entry its dispatch writes, or would write when it is muted;
   * after the step committed, or was refused, and its commit handlers ran: inside the dispatch, but for a transition's
   * end and an accepted abort's step, told when the work settles or the wait ends. `step` tells the step only; it gives
   * no way into the engine, and every tap gets the same object, which the engine does not freeze.
   */
  ended(target: object, step: FlowTapStep): void;
};

/**
 * One step as `ended` tells it: values the engine hands out elsewhere too, for a tool that reads no log entry. It holds
 * instances where the entry holds their texts, and none of the entry's timings, handler results or final states.
 */
export type FlowTapStep = {
  /** The dispatch's signal, the object `dispatched` was told; a transition's end carries its dispatch's. */
  signal: Signal;
  /** That dispatch was sent as an abort of a pending transition, accepted or refused; a transition's end carries
   * its dispatch's. False for an abort sent with nothing pending, which is dispatched as usual. */
  abort: boolean;
  /** The step's Result: what the dispatch returns (for a temp step, a Pending of the same end), or what the
   * transition's done() resolves to. A timeout's is an Error whose `code` is SF035. */
  result: Result;
  /** The log entry's mark: "temp" on a declared transition's temp step, "final" or "failed" on its end. */
  transition: "temp" | "final" | "failed" | undefined;
  /** What the step committed, node by node in the engine's pre-order (the states in the flow's order), with
   * `stateName` the node's path as the log names it; a side is undefined where the position was or becomes empty.
   * Empty when nothing committed. */
  changes: ReadonlyArray<{ stateName: string; old: StateInstance | undefined; next: StateInstance | undefined }>;
  /** Each observer, event and watch whose decision asked for its callback in this step, named as the log entry
   * names it: `stateName` the node's path, or the changed states of an event or a watch, and `observerName` its
   * name. The objects are the log entry's own, so each also carries its `needObserve`, true for all of these; a tap
   * reads the two keys typed here. */
  fired: ReadonlyArray<{ stateName: string; observerName: string }>;
  /** The calls of the works that had not settled when this step ended their transition, by its timeout or another
   * work's refusal, or dropped it, in an accepted abort: the call objects their late answers are told to `handled`
   * with. Empty for any other step. */
  unsettled: ReadonlyArray<{ readonly name: string; readonly instance: StateInstance }>;
};

/** The taps every flow of the page tells; see addFlowTap. */
const taps = new Set<FlowTap>();

/** Adds a tap that every flow of the page tells from now on. Returns the function that removes it. */
export function addFlowTap(tap: FlowTap): () => void {
  taps.add(tap);
  return () => {
    taps.delete(tap);
  };
}

/**
 * The handlers registered on `target`, as plain data JSON.stringify writes as it is: one entry per registration, with
 * its variant as "<state>.<variant>", its kind (enter, exit, update, transition or commit) and the name its handler
 * results carry in the log. Grouped by variant in the order each was first registered on, then by kind in the order
 * each kind was first registered on that variant, then in registration order. Two definitions that share a name give
 * one variant string.
 *
 * The name of a handler registered without one, an anonymous function given inline, is "", or "<context>." when it
 * was given a context. It lists every registration made so far, through applyFlow's initializer or a StateManager
 * kept from it: a mock (see mockHandlers) in force is not listed and hides none, and the handlers-off switch
 * (setHandlersDisabled) changes nothing here.
 *
 * @throws StateFlowError when `target` was never applied, or its flow was disposed
 */
export function listHandlers(target: object) {
  const perKind = [...stateMeta(target).handlers].flatMap(([variant, kinds]) =>
    Object.entries(kinds).map(([kind, registered]) => ({ variant: String(variant), kind, registered })),
  );
  return perKind.flatMap(({ variant, kind, registered }) => registered.map(({ name }) => ({ variant, kind, name })));
}

/**
 * Calls `tell` with each tap there is when the telling starts, so a tap added or removed meanwhile changes the next
 * telling only. A tap only observes, so its throw goes to console.error, as an observer's does, and the step and the
 * other taps go on. The taps are told inside the step guard, which refuses a dispatch to the target and its dispose as
 * it does a handler's; the guard is put back as it was, since the handlers' results are told from inside a step.
 */
function tellTaps(meta: StateFlowMeta, tell: (tap: FlowTap) => void): void {
  const inStep = meta.inStep;
  meta.inStep = true;
  try {
    for (const tap of [...taps]) {
      try {
        tell(tap);
      } catch (err) {
        console.error(`[SF/${meta.name}] a tap threw:`, err);
      }
    }
  } finally {
    meta.inStep = inStep;
  }
}

//#region Helper Types

type StateFlowMeta = {
  /** Delivers commits to the observers of `observe()`; handlers are in `handlers`. */
  emitter: EventEmitter;
  /** Every timer of the flow goes through these (see {@link FlowConfig}). */
  timers: NonNullable<FlowConfig["timers"]>;
  /** Whether a reducer's next equal by value to its node's instance counts as that instance (FlowConfig.equalAnswers
   * "value"). */
  byValue: boolean;
  /** The handlers the initializer of applyFlow registered (see {@link StateManager}). */
  handlers: HandlerRegistry;
  /** The declared transition that has started and not ended yet; null otherwise. */
  pending: PendingTransition | null;
  /** True while a step runs its handlers and its commit, or a transition's work its handlers' synchronous parts.
   * A dispatch to this target, or its disposeFlow, throws meanwhile: the step would overwrite the one, and still
   * needs the handlers and observers the other removes. */
  inStep: boolean;
  /** The lock holder's sends made while a transition is pending; reduced in order after it ends. */
  queue: QueuedSend[];
  lockHolder: symbol | null;
  /** FIFO waiters. Each carries its OWN lock id so dispose() can hand ownership
   * over directly (set lockHolder = next.id) with no null-gap window. disposeFlow resolves every waiter and hands
   * nothing over: lock() finds the flow disposed (see lock). */
  lockQueue: Array<{ id: symbol; resolve: () => void }>;
  states: Array<StateDefinition>;
  /** The signal reducers of each state's tree, by state name, kept from one dispatch to the next (see reduce). An entry
   * holds its tree alive, so applyState drops it when the state commits another instance, and disposeFlow drops all. */
  reducers: Map<string, TreeReducers>;
  name: string;
  logHandlers: StateFlowLogHandler[];
  /** Active labeled-lock log group. While set, each dispatched entry is buffered here instead of
   * being emitted immediately, then flushed together (under one console group) when the lock
   * releases. Null when no labeled lock is held. `context` is the dispatch-context provider's
   * snapshot captured at `lock()` CALL time (null without a provider — the default).
   * See `lock(target, label)` and `emitGrouped`. */
  logGroup: { label: string; pending: Array<Promise<StateFlowLogEntry>>; context: string | null } | null;
  /** Observation-only per-flow subscribers (see `subscribeFlow`). Each committed change of a node, top-level or
   * nested, is delivered to every subscriber as a `FlowChange`, post-commit, on its own turn of `timers`. Empty by
   * default so a flow with no subscribers pays nothing. */
  flowSubscribers: Set<FlowSubscriber>;
  /** The flow's events (defineEvent) and watches (watch), in registration order, each with the states as of the
   * commit it last saw; evaluated after every commit (see notifyWatchers). */
  watchers: Watcher[];
  /** The deliveries set on `timers` that have not run yet: the callbacks of observers, events and watches, and the
   * changes of subscribers. Each one takes itself off as it starts; settled waits until none is left. */
  deliveries: number;
  /** Set by disposeFlow: from then on every call on the target throws (see stateMeta), except disposeFlow itself,
   * which does nothing, every send, which answers Rejected whatever its lock, lock(), which resolves to such a sender
   * (see lock), and settled, which waits for the deliveries set before. */
  disposed: boolean;
};

/** An event or a watch: named as the entry shows it, with what it decides on and what it does when it fires. */
type Watcher = {
  name: string;
  changed: ChangePredicate<FlowSnapshot>;
  act: (cur: FlowSnapshot, prev: FlowSnapshot) => void;
  prev: FlowSnapshot;
};

/**
 * A single change delivered to a {@link FlowSubscriber}. Describes one node of the flow's tree, a top-level state or a
 * nested state inside one, whose instance changed within a dispatch, with the real (readable, frozen) state instances
 * before and after. A nested node's position may be empty on one side: that side is undefined, its variant "(none)".
 */
export interface FlowChange<T = unknown> {
  /** Name of the flow container (the target's `Symbol.toStringTag` / constructor name). */
  flowName: string;
  /** Name of the state definition that changed (e.g. `"playback"`); for a nested node, the definition of its instance
   * after the change, or before it when the node left. */
  stateName: string;
  /** A nested node's path, as the log names it (e.g. `"media.producers[cam]"`); absent on a top-level state's change. */
  path?: string;
  /** Variant name before the change (e.g. `"off"`); `"(none)"` where a nested node's position was empty. */
  prevVariant: string;
  /** Variant name after the change (e.g. `"on"`); `"(none)"` where a nested node's position empties. */
  nextVariant: string;
  /** The real state instance before the change — frozen, props readable; undefined where a nested node's position
   * was empty, and another state's instance where it held another state. */
  prev: T;
  /** The real state instance after the change — frozen, props readable; undefined where a nested node's position
   * empties. */
  next: T;
  /** Stringified signal that drove the dispatch. */
  signal: string;
  /** The `dispatchOrder` of the log entry of the step that committed the change. */
  dispatchOrder: number;
}

/** Observation-only callback invoked once per changed node, top-level or nested, after commit. See `subscribeFlow`. */
export type FlowSubscriber = (change: FlowChange) => void;

/** The fourth argument of {@link applyFlow}. */
export interface FlowConfig {
  /** The flow's log handlers; absent or empty means {@link consoleLogHandler}. */
  logHandlers?: StateFlowLogHandler[];
  /**
   * What every timer of the flow goes through: a declared transition's timeout, an accepted abort's wait for the
   * work, the deliveries of observers, events, watches and subscribers, and settled's wait for them. Absent means the
   * global setTimeout and clearTimeout, looked up at each call, so fake timers installed after applyFlow still apply.
   * The engine calls them as methods of this object: for the global functions, pass `globalThis` or functions bound to
   * it, since browsers throw when they are called on another object. A callback must run after setTimeout returns, and
   * clearTimeout must ignore a handle whose timer already ran or was cleared. Neither may throw: a throw stops the engine
   * where it called them, which can leave a transition with no end, no entry and no tap told.
   * A simulation passes its own to control time without faking globals.
   */
  timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /**
   * When a reducer's answer counts as no change. "identity", the default: only the instance the reducer was given.
   * "value": also a next of that instance's variant with equal props, which then counts as that instance, so no
   * handler runs and nothing commits there. Props are equal when they have the same own enumerable keys and, under
   * each, equal values: the same value (===), Boxes that wrap the same value, FrozenSets of one size whose elements
   * the other has, FrozenMaps of one size whose keys the other has with equal values, and arrays and plain records
   * whose elements are equal. Nothing else compares by value: a nested state and an Items only by ===. A temp and a
   * failed compare by === in either mode, so a failed with equal props still takes FAILURE. "value" costs one walk of
   * the props for each answer whose next is another instance of its node's variant.
   */
  equalAnswers?: "identity" | "value";
  /**
   * States to start from, for tests and tools that begin in the middle of a session: under a state's name, an instance
   * taken as that state's committed one in place of the initial variant built from the target's props (the target
   * still needs props under that name; a state not named starts from them as usual). Nothing runs for the start: no
   * handler, no log entry, and no variant is entered, so the instance may be in an asynchronous one. Events and watches
   * compare the first commit with it. No transition is pending, so a variant marked transitional is refused, as in an
   * initial instance, and a temp without that mark is an ordinary state. The other checks an initial instance gets
   * (result names) run on it too. Nothing else is checked: a name that matches no state is ignored, and an instance of
   * another definition is taken as it is. Its DisposableBoxes follow the rules of DisposableBox: a box given to two
   * flows is disposed by the first to drop it.
   */
  // `any`, as in StateResult.ok: an instance typed by its state's props is not assignable to the bare StateInstance.
  start?: Readonly<Partial<Record<string, StateInstance<any, any, any, any>>>>;
}

/** Options of {@link dispatch} and of a lock's `send`. */
export interface DispatchOptions {
  /** Abort the target's pending declared transition with this signal. Every reducer the signal reaches runs on the
   * committed snapshot, which holds the transition's temp. The abort is accepted when its reducers commit something
   * and leave no node in a transitional variant: the work's signal aborts, the engine waits for the work no longer
   * than what is left of its timeout, and the abort's own step commits; the transition's result is Rejected
   * "aborted by <signal>". Otherwise the abort's
   * result is Rejected or Error and the transition continues; so is a second abort during the first. With nothing
   * pending, the signal is dispatched as usual (a bare `dispatch` under a held lock returns Rejected instead of
   * throwing). */
  abort?: boolean;
  /** Write no log entry for this dispatch (none of a transition it declares). */
  mute?: boolean;
}

/**
 * A step prepared from one snapshot to another without touching the world: the handler calls it makes on the
 * nodes of every state's tree, and the nodes it changes.
 */
type Step = {
  from: FlowSnapshot;
  /** The snapshot the step prepared, frozen: the second argument of its exit, update and enter handlers. It
   * commits with the named results its update and enter handlers return folded in, and the other states' answers to
   * them (see {@link runStep}). */
  to: FlowSnapshot;
  exit: HandlerCall[];
  update: HandlerCall[];
  /** Also the calls of the commit handlers, which are keyed like enter handlers. */
  enter: HandlerCall[];
  changes: StateChange[];
};

/** What the reducers of a dispatch decided, prepared without touching the world: the committed snapshot `C` they ran
 * on, their reduction, and the first step: to next, or for a declared transition to its temp face. */
type Plan = { C: FlowSnapshot; reduction: Reduction; first: Step };

/**
 * What a failed step follows, as it takes it over: the refusal of the step before it, or what ended the transition,
 * and what that step carried, the named results its handlers returned and the snapshots it planned, whose
 * DisposableBoxes the failed step disposes with its own (see runFailedStep); none where no step ran, or where the step
 * threw and disposed them itself.
 */
type Refused = { refusal: Result; named: readonly NamedResult[]; planned: readonly FlowSnapshot[] };

/** What a step did: committed the snapshot it returns, with any refusal of a floor step; or refused, committing
 * nothing. */
type StepOutcome = { committed: FlowSnapshot; refusal: Result | null } | ({ committed: null } & Refused);

/**
 * One dispatch, from its reducers to its last commit, a transition's end included: where it goes, and what its entry
 * records.
 */
type DispatchRun = {
  target: object;
  meta: StateFlowMeta;
  signal: Signal;
  /** Writes no entry; see {@link DispatchOptions}. */
  mute: boolean;
  /** The entry its steps write. */
  collector: ResultCollector;
  /** The transition it aborts: set on an abort's dispatch, accepted or refused, and kept by the end of a transition
   * that dispatch declares; null on any other. */
  aborted: PendingTransition | null;
  /** The works of the transition whose end, or whose drop by an accepted abort, this run's entry writes; absent on
   * any other run. finish tells the taps those still unsettled. */
  works?: readonly WorkCall[];
  /** The changes the run's step committed, as the engine commits them; unset while nothing committed. */
  committed?: readonly StateChange[];
};

/** A transition handler called as a transition's work, and the Result it settled to; null until it settles. */
type WorkCall = { call: HandlerCall; handler: Registered; result: Result | null };

/** A commit delegate (see HandlerResult.onCommit), with the exit, update, enter or transition call and the handler
 * whose result carried it, which the log entry of its throw names. */
type DelegateCall = { call: HandlerCall; handler: Registered; delegate: () => void };

/** A declared transition from its start to its end; see {@link startTransition}. */
type PendingTransition = {
  /** The dispatch that declared it. */
  run: DispatchRun;
  declared: DeclaredAnswer;
  /** Aborts the signal its work's handlers share, with a TransitionAborted: on an accepted abort, the timeout, a
   * failure, or disposeFlow. */
  controller: AbortController;
  /** Fires at the deadline and calls `expire`; every other end clears it. Set when the work starts. */
  timer: unknown;
  /** What the timer calls: the timeout's end (see {@link onTimeout}), or, once an abort is accepted, the end of the
   * abort's wait for the work (see {@link abortTransition}). Set when the work starts. */
  expire: () => void;
  /** The transition handlers called as its work, in the order of the end's enter calls. */
  works: WorkCall[];
  /** Settles when every work has settled. Set when the work starts. */
  settled: Promise<unknown>;
  /** Set when an abort is accepted: the work's result is dropped from then on, and the abort's step replaces
   * the end. */
  aborting: boolean;
  /** Set once an accepted abort's entry logged the works: a work that settles after that is reported on the
   * console, since no entry will show it. */
  dropped: boolean;
  startTime: number;
  /** Resolves with the outcome; the pending result of its dispatch waits on it. */
  promise: Promise<Result>;
  /** Every end resolves through here, which stamps the outcome with the transition's span (startedAt when it
   * started, finishedAt the end) before it resolves `promise`. */
  resolve: (outcome: Result) => void;
};

/** A send the lock holder made while a transition was pending, and the settle of its pending result. */
type QueuedSend = { signal: Signal; options: DispatchOptions; settle: (outcome: Result | Promise<Result>) => void };

/** observe()'s callback: gets the instance of an observed variant that committed, and the path of its node as the log
 * names it: the state's name for a top-level state, `media.producers[cam]` for a nested one. */
type ObserverHandler<TState> = (state: TState, path: string) => void;
/** observe()'s compare: whether the change from `a` to `b` calls the callback. */
type ObserverComparerFn<TState> = (a: TState, b: TState) => boolean;
/** The emitter's listener that subscribe() registers for an observer: the node's instance before the change (of
 * another state, or undefined, where its position held another state or none), its committed instance, the
 * collector of the entry of the commit that tells it, and the node's path. */
type ObserverListener<TState> = (a: StateInstance | undefined, b: TState, rc: ResultCollector, path: string) => void;

/** The names of the states whose variants are in the union `V`. */
// A conditional type whose checked type is a bare type parameter maps a union member by member.
type StateNameOf<V> = V extends StateVariant<any, any, any, infer TName, any, any, any> ? TName : never;

/**
 * The names of the states whose instances the type `P` holds in its props, directly or in an Items (a ReadonlyMap of
 * them), and below those, down to 8 levels: the props of a state that holds its own instances would otherwise be
 * searched forever. Any object type is searched, a state's props or not, and an instance counts by its state's name
 * alone. A type that names no state, as `StateInstance<Props>` and `any` do, adds no name, since it would let every
 * variant through.
 */
type HeldIn<P, D extends unknown[] = []> = D["length"] extends 8
  ? never
  : {
      // `extends infer Y` names the prop's type, so the Items test runs on each member of a union, as an optional
      // prop's `Items | undefined`; `extends infer X` names the instance the prop holds, for the branch below.
      [K in keyof P]: (P[K] extends infer Y ? (Y extends ReadonlyMap<unknown, infer E> ? E : Y) : never) extends infer X
        ? X extends { readonly [VARIANT]: StateVariant<any, any, any, infer N> }
          ? (string extends N ? never : N) | HeldIn<X, [...D, 0]>
          : never
        : never;
    }[keyof P];

/**
 * What observe() asks of its target's type `T` for the variants `V`: a prop under the state name of each variant
 * whose state `T` does not hold below its top-level props (see {@link HeldIn}), of that state's props or a subtype of
 * them (the instance applyFlow puts there, or a narrower initial value), where the variant's name comes from its type.
 * So a top-level state's variant needs the state's prop, a nested state's variant needs `T` to hold the state's
 * instances below, in a prop or an Items, at any depth, and a variant of a state outside the target names a prop the
 * target lacks: the call does not compile. HeldIn finds a state by its name in anything the props hold, so a variant
 * of a state outside the flow compiles too when the props reach an instance of that state outside the flow, in a
 * cache say, or when the state shares a nested state's name.
 *
 * observe() puts this on its target's type parameter as a constraint, not on the variants as a condition on the
 * target's type: inside a class the target is `this`, the polymorphic this type, which a conditional type leaves
 * unresolved, while a constraint is checked against the class. The search for nested states is such a conditional
 * type, so the constraint is a union: the first member for a target whose type is known, the second, a prop under
 * every variant's state name, for `this` and a target typed by a type parameter, which meet it through their
 * constraint. A nested state's variant therefore does not compile with those: pass the target typed as the class,
 * `this as Player`. A variant typed `any`, or one whose type names no state (`StateVariant<Props>`, as generic code
 * types them), leaves nothing to check, and any object passes.
 */
type TargetOf<V, T> = 0 extends 1 & V
  ? // V is `any` (only `any` makes `1 & V` a type that 0 extends).
    object
  : string extends StateNameOf<V>
    ? object
    :
        | {
            readonly [K in Exclude<StateNameOf<V>, { [P in keyof T]: HeldIn<T[P]> }[keyof T]>]: Infer<
              Extract<V, StateVariant<any, any, any, K, any, any, any>>
            >;
          }
        | { readonly [K in StateNameOf<V>]: Infer<Extract<V, StateVariant<any, any, any, K, any, any, any>>> };

type Disposer = {
  [Symbol.dispose](): void;
};

type StateManagerCallback<TStates> = (sm: StateManager<TStates>) => void;

/** A lock's dispatch function; see {@link lock}. */
export type DispatchFn = ((signal: Signal, options?: DispatchOptions) => Result) & {
  [Symbol.asyncDispose](): Promise<void>;
};

//#endregion

//#region Helper Functions

/** The emitter's event for the observers of each variant: a symbol of its own, since two definitions may share a name,
 * and their variants a string form. A WeakMap, so it holds no variant alive. */
const observeKeys = new WeakMap<StateVariant, symbol>();

/** The emitter's event for the observers of `variant` (see {@link observeKeys}); the first call makes it. */
function observeKey(variant: StateVariant): symbol {
  const key = observeKeys.get(variant) ?? Symbol(String(variant));
  observeKeys.set(variant, key);
  return key;
}

/**
 * The flow applyFlow set up on `target`.
 *
 * @throws StateFlowError when `target` was never applied, or its flow was disposed
 */
function stateMeta(target: object): StateFlowMeta {
  const meta = managementStateMap.get(target);
  if (meta == null) {
    throw new StateFlowError("SF007", `${buildName(target)} doesn't contain state flows`);
  }
  if (meta.disposed) {
    throw disposedError(meta);
  }
  return meta;
}

/** What a call on a disposed flow throws. */
function disposedError(meta: StateFlowMeta): StateFlowError {
  return new StateFlowError("SF008", `${meta.name} is disposed`);
}

/** A promise and the function that resolves it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  // The executor runs synchronously, so `resolve` is replaced before this function returns.
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

//#endregion

/**
 * Initializes a state management system on a target object by applying state definitions
 * and configuring event handlers.
 *
 * @param target - The object that will hold the state values and receive state updates
 * @param states - Array of state definitions that define the possible states and transitions
 * @param initializer - Callback function to set up state change handlers; its adders register whether
 *   setHandlersDisabled is on or not, and the switch decides at each call whether they run
 * @param config - The flow's log handlers, its timers, when a reducer's answer counts as no change, and the states it
 *   starts from (see {@link FlowConfig})
 * @throws StateFlowError if state definitions are invalid or state objects are not found on target, or an
 *   initial instance holds a nested state in a transitional variant, which commits only as the temp of a
 *   declared transition, or, unless it was given (see FlowConfig.start), in an asynchronous variant, which a node
 *   enters only as the next of one; or two definitions declare named results of one name: the states, or the nested
 *   states and Items their initial instances hold at any depth (a definition first held later is not seen), since every state with a result reducer of that
 *   name takes such a result
 *
 * @example
 * ```ts
 * // Under each state's name, its initial props: audioState is named "audio", videoState "video".
 * const mediaController = {
 *   audio: { volume: 0.5 },
 *   video: { playing: false }
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
  initializer: StateManagerCallback<ArrayToRecord<TStates>>,
  config: FlowConfig = {},
): void {
  // Each result name the definitions seen so far declare, with the one that declares it.
  const declaring = new Map<string, AnyDefinition>();
  for (const def of states) {
    if (!isStateDef(def)) {
      throw new StateFlowError("SF009", "Incorrect state definition");
    }
    const name = getName(def);

    const st = target[name];
    if (st == null) {
      throw new StateFlowError("SF010", `State object ${name} not found`);
    }

    // Nested states of the initial instance enter no variant, as the top-level ones do not: no step runs.
    const given = config.start?.[name];
    const initial = given ?? getInitialState(def)(st);
    const transitional = findTransitional(undefined, initial, topLevel(name));
    if (transitional !== null) {
      throw new StateFlowError(
        "SF011",
        `${pathName(transitional)} starts in a transitional variant, which commits only as the temp of a declared transition`,
      );
    }
    // From nothing, every node an instance built here holds counts as entered; a given instance is the same before and
    // after, so it enters none.
    const asynchronous = findAsynchronousEntry(given, initial, topLevel(name));
    if (asynchronous !== null) {
      throw new StateFlowError(
        "SF012",
        `${pathName(asynchronous.path)} starts in ${String(asynchronous.entered[VARIANT])}, whose entry is asynchronous; declare a transition into it`,
      );
    }
    claimResultNames(initial, declaring);
    Object.defineProperty(target, name, { value: initial });
  }

  const logHandlers = config.logHandlers?.length ? config.logHandlers : [consoleLogHandler];
  const flowName = String(Symbol.toStringTag in target ? target[Symbol.toStringTag] : target.constructor.name);

  const handlers: HandlerRegistry = new Map();
  managementStateMap.set(target, {
    emitter: new EventEmitter(),
    // globalThis's setTimeout and clearTimeout are looked up at each call, so fake timers installed later apply, and
    // called with the global object as `this`, which a browser requires of them.
    timers: config.timers ?? globalThis,
    byValue: config.equalAnswers === "value",
    handlers,
    logHandlers,
    states: states as StateDefinition[],
    reducers: new Map(),
    pending: null,
    inStep: false,
    queue: [],
    lockHolder: null,
    lockQueue: [],
    logGroup: null,
    flowSubscribers: new Set(),
    watchers: [],
    deliveries: 0,
    name: flowName,
    disposed: false,
  });

  const meta = stateMeta(target);
  const emit = (target as { emit?: unknown }).emit;
  initializer(
    stateManager(handlers, (name, changed, payload) => {
      if (typeof emit !== "function") {
        throw new StateFlowError("SF013", `${flowName} has no emit method, which defineEvent("${name}") needs`);
      }
      meta.watchers.push({
        name: `event:${name}`,
        changed,
        act: (cur) => (payload === undefined ? emit.call(target, name) : emit.call(target, name, payload(cur))),
        prev: prepareSnapshot(target, meta),
      });
    }),
  );
}

/**
 * Adds to `declaring` the names of the named results that the definitions `x` holds declare (see
 * {@link addHeldDefinitions}), each with its definition. Every state with a result reducer of a name takes a result of
 * that name, so one definition of a flow declares it, on one variant or several.
 *
 * @throws StateFlowError when `declaring` gives a name to another definition already
 */
function claimResultNames(x: StateInstance, declaring: Map<string, AnyDefinition>): void {
  const defs = new Set<AnyDefinition>();
  addHeldDefinitions(x, defs);
  for (const def of defs) {
    // A definition's own enumerable values are its variants.
    const names = Object.values(def).flatMap((variant: StateVariant) => Object.keys(variant.results));
    for (const name of names) {
      const other = declaring.get(name) ?? def;
      if (other !== def) {
        throw new StateFlowError(
          "SF014",
          `${String(other)} and ${String(def)} both declare a result named ${name}; every state with a result reducer of that name takes it, so one state of a flow declares it`,
        );
      }
      declaring.set(name, def);
    }
  }
}

/** The target's committed states by name, frozen: reducers read it, and a write to it would change no state. */
function prepareSnapshot(target: object, meta: StateFlowMeta): FlowSnapshot {
  return Object.freeze(
    Object.fromEntries(meta.states.map((s) => [s[Symbol.toStringTag], Reflect.get(target, s[Symbol.toStringTag])])),
  );
}

/**
 * Dispatches a signal to trigger state transitions in the target object.
 *
 * @deprecated Prefer `await using send = await lock(target); await send(sig).expect(...).done()`.
 * Bare `dispatch()` throws under a held lock / pending transition (see the guards below);
 * only use it for synchronous teardown or pre-lock bootstrap, or to abort a pending transition
 * that another caller's lock holds (`{ abort: true }`, which skips the lock). Every other caller
 * should acquire a lock so signals queue behind any in-flight transition instead of throwing.
 *
 * @param target - Object containing the states to be updated
 * @param signal - Signal object that triggers state transitions
 * @param options - `abort`: abort the pending transition with this signal; `mute`: write no log entry
 * @returns Result object indicating success, failure, or transition status; while a declared transition
 *   runs, a pending result whose `done()` resolves to the end it reached
 * @throws StateFlowError inside a reducer or inside this target's own dispatch, under a held lock, or
 *   while a transition is pending (unless `abort` is set); and when the target is no flow, or its flow is disposed
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
 *
 * // Abort a transition that another caller's lock is waiting on:
 * dispatch(player, signals.stop(), { abort: true });
 * ```
 */
export function dispatch(target: object, signal: Signal, options: DispatchOptions = {}): Result {
  // Reducers are pure — no dispatch, no side effects. Fail fast with a clear
  // message here before the lock/transition checks below get a chance to run.
  if (isInReducer()) {
    throw new StateFlowError("SF015", "Cannot dispatch from inside a reducer");
  }
  const meta = stateMeta(target);
  if (meta.inStep) {
    throw new StateFlowError("SF016", `Cannot dispatch to ${meta.name} from inside its own dispatch`);
  }
  // An abort skips the lock: its holder is waiting for the very transition the abort ends.
  if (options.abort && meta.pending != null) {
    return abortTransition(target, meta, meta.pending, signal, options);
  }
  if (meta.lockHolder != null) {
    if (options.abort) {
      // An abort races the transition's end by nature, so finding nothing to abort is a result.
      return Verdict.rejected("SF017", "nothing to abort: no transition is pending and the lock is held").withSignal(
        signal,
      );
    }
    throw new StateFlowError("SF018", "Lock is held. Use `await using send = await lock(target)` for queued access");
  }
  if (meta.pending != null) {
    throw new StateFlowError(
      "SF019",
      `A transition is pending on ${meta.name}; use lock() to queue, or { abort: true }`,
    );
  }

  return dispatchNow(target, meta, signal, options);
}

/**
 * Acquires an exclusive lock on the target for dispatching multiple signals.
 * Use with `await using` for automatic cleanup.
 *
 * While a declared transition is pending, the returned `send` queues each signal and returns a pending
 * result; the queued signals are reduced in order after the transition ends. `send(signal, { abort: true })`
 * aborts the pending transition instead (see {@link DispatchOptions}).
 *
 * Once disposeFlow ran, every send answers Rejected "<name> is disposed", with no log entry and nothing dispatched,
 * whatever its lock: one taken before the dispose, one whose wait for its turn or for a pending transition the dispose
 * ended, or one asked for afterwards, which lock() resolves at once, even while a lock taken before is held. A caller
 * needs no catch, and one that expects OK throws, as expect does for any kind it does not list. The release of a lock
 * taken before the dispose still flushes the entries its label buffered until then.
 *
 * @param target - Object containing the states to lock
 * @param label - Optional short label for the critical section. When given, every entry logged
 *   inside the lock is buffered and flushed together under one `console.group(label)` on release,
 *   so a multi-signal operation reads as a single unit (see `emitGrouped`). Because entries are
 *   buffered, a labeled lock's logs appear together at release rather than one-by-one in real time
 *   — that delay is what makes correct nesting possible. Omit the label for unchanged, immediate
 *   per-entry logging.
 * @returns A callable DispatchFn that dispatches signals while holding the lock, and answers every signal Rejected
 *   once the flow is disposed
 * @throws StateFlowError (the promise rejects) when the target is no flow
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
  // stateMeta throws for a disposed flow, which lock() answers with the sender below: it is called only for a target
  // never applied.
  const meta = managementStateMap.get(target) ?? stateMeta(target);
  const id = Symbol("lock");

  // Captured SYNCHRONOUSLY at call time — an async function body runs in the caller's stack
  // up to its first await, so for UI-triggered locks this still executes inside the
  // interaction event's synchronous propagation (the whole point: by the time `send()` runs,
  // microtask hops have long left that stack). Null without a provider — the default.
  const dispatchContext = label != null ? getGlobalDispatchContext() : null;
  const lockRequestedAt = dispatchContext != null ? Date.now() : 0;

  const dispose = async (): Promise<void> => {
    if (meta.lockHolder !== id) {
      return;
    }

    // Wait for the pending transition before releasing. An abort or a queued send can start a new one
    // when it ends, so wait until none is pending.
    while (meta.pending != null) {
      await meta.pending.promise;
    }

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
    (signal: Signal, options: DispatchOptions = {}): Result => {
      // Once disposeFlow ran, every send answers Rejected, whatever this lock's state (see disposeFlow).
      if (meta.disposed) {
        return Verdict.rejected("SF008", `${meta.name} is disposed`).withSignal(signal);
      }
      if (meta.lockHolder !== id) {
        throw new StateFlowError("SF020", "Lock has been released");
      }
      // Reducers are pure. Checked before the queue and the abort below, which would otherwise accept it.
      if (isInReducer()) {
        throw new StateFlowError("SF015", "Cannot dispatch from inside a reducer");
      }
      if (meta.inStep) {
        throw new StateFlowError("SF016", `Cannot dispatch to ${meta.name} from inside its own dispatch`);
      }
      if (meta.pending != null) {
        return options.abort
          ? abortTransition(target, meta, meta.pending, signal, options)
          : queueBehindTransition(meta, signal, options);
      }

      return dispatchNow(target, meta, signal, options);
    },
    { [Symbol.asyncDispose]: dispose },
  );

  // A disposed flow has no lock to hand: lock() resolves at once, even while a lock taken before the dispose is held.
  if (meta.disposed) {
    return send;
  }

  // Claim ownership. If the lock is held OR anyone is already queued, wait our FIFO turn; otherwise take it
  // immediately. This claim is SYNCHRONOUS (no await between the check and the assignment), so two concurrent lock()
  // calls can never both take it. dispose() hands ownership DIRECTLY to the next waiter (sets lockHolder = next.id
  // before resolving), so lockHolder is never null while a waiter is about to resume: a racing lock() cannot slip in
  // front of a woken waiter and invalidate its handle ("Lock has been released").
  if (meta.lockHolder != null || meta.lockQueue.length > 0) {
    // dispose() resumes it with meta.lockHolder = id already set; disposeFlow resumes it and hands nothing over.
    await new Promise<void>((resolve) => meta.lockQueue.push({ id, resolve }));
  } else {
    meta.lockHolder = id;
  }

  // disposeFlow ended the wait, or ran after a release handed this lock() the lock. Return before sync(), which throws
  // on a disposed flow, and before the label's group, which would take the place of the one that a lock taken before
  // the dispose still flushes.
  if (meta.disposed) {
    return send;
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

  return send;
}

//#region Dispatch

/** A new dispatch of `signal` on `target`, with its own entry; `aborted` is set on an abort's. */
function newRun(
  target: object,
  meta: StateFlowMeta,
  signal: Signal,
  options: DispatchOptions,
  aborted: PendingTransition | null,
): DispatchRun {
  // Production never registers a tap, so a dispatch must not pay a call and a closure for one: each place that tells
  // the taps checks the set's size first.
  taps.size > 0 && tellTaps(meta, (tap) => tap.dispatched(target, signal));
  return {
    target,
    meta,
    signal,
    mute: options.mute === true,
    collector: new ResultCollector(meta.name, signal),
    aborted,
  };
}

/** Tags `result` with the run's signal, finishes the run's entry with it and `snapshot`, its final states, tells the
 * taps the step ended (see FlowTap.ended), and returns it. Every entry, a muted one too, ends here. */
function finish(run: DispatchRun, snapshot: FlowSnapshot, result: Result): Result {
  const tagged = result.withSignal(run.signal);
  finishEntry(run.meta, run.collector, snapshot, tagged, run.mute);
  if (taps.size > 0) {
    const { entry } = run.collector;
    // The works of the transition this entry ends or drops have not settled since it wrote them: a work settles on a
    // later microtask (see startWork), and everything from there to here runs in one synchronous call.
    const step: FlowTapStep = {
      signal: run.signal,
      abort: run.aborted !== null,
      result: tagged,
      transition: entry.transition,
      changes: run.committed ?? [],
      fired: entry.observers.filter(({ needObserve }) => needObserve),
      unsettled: (run.works ?? []).filter((work) => work.result === null).map((work) => work.call),
    };
    tellTaps(run.meta, (tap) => tap.ended(run.target, step));
  }
  return tagged;
}

/**
 * Reduces `signal` from the committed snapshot and runs what its reducers decided. Does not check the lock, a
 * pending transition or re-entry: its callers do.
 */
function dispatchNow(target: object, meta: StateFlowMeta, signal: Signal, options: DispatchOptions): Result {
  const run = newRun(target, meta, signal, options, null);
  const committed = prepareSnapshot(target, meta);
  const plan = prepareDispatch(meta, committed, signal, null);
  if (plan instanceof Result) {
    return finish(run, committed, plan);
  }
  const declared = plan.reduction.declared;
  return declared !== null ? startTransition(run, plan, declared) : runOk(run, plan);
}

/**
 * Reduces `signal` on the committed snapshot `C` (see {@link reduce}) and plans, without touching the world, what
 * its reducers decided: their answers composed into the tree (see {@link face}), and the first step, to next, or for a
 * declared transition to its temp face: there the declaring node holds temp, while every other answer takes its next.
 * `aborted` is the transition an abort's dispatch aborts, null for any other dispatch. Returns the reducers' refusal or
 * Ignored; an Error when the answers break a rule of the plan, each checked in this order (see {@link findConflict},
 * the transitional check below, {@link findStepError}), so nothing commits; or the plan.
 */
function prepareDispatch(
  meta: StateFlowMeta,
  C: FlowSnapshot,
  signal: Signal,
  aborted: DeclaredAnswer | null,
): Result | Plan {
  const reduction = reduce(meta.states, C, signal, meta.reducers, meta.byValue);
  if (reduction instanceof Result) {
    return reduction;
  }
  const conflict = findConflict(reduction);
  if (conflict !== null) {
    return conflict;
  }
  const N = face(C, reduction.decided, (answer) => answer.next);
  const declared = reduction.declared;
  const T =
    declared === null
      ? N
      : face(C, reduction.decided, (answer) => (answer === declared ? declared.transition.temp : answer.next));
  const first = prepareStep(meta, C, T);
  // The transitional check: an Error when the dispatch would leave a node in a transitional variant, which commits
  // only as the temp of a declared transition. An abort's dispatch runs on a snapshot that holds one, the aborted
  // transition's temp, and its reducers must leave it:
  // - None may stay at any depth of next (`N`). The temp face needs no check of its own: outside the declaring node's
  //   subtree it holds the variants `N` holds, and inside it a temp may hold transitional variants.
  // - None may stand in a failed as it composes with the failed of the answers below it: each one's failed, or its
  //   node before the signal when it declares none.
  const left = findTransitionalIn(C, N);
  if (left !== null) {
    const variant = (instanceAt(N, left) as StateInstance)[VARIANT];
    return Verdict.error(
      new StateFlowError(
        "SF021",
        `${pathName(left)} would be left in ${String(variant)}, a transitional variant, which commits only as the temp of a declared transition`,
      ),
    );
  }
  for (const answer of reduction.answers) {
    const failed = answer.failed;
    if (failed === undefined) {
      continue;
    }
    const composed = compose(answer.node, (b) => (b === answer ? failed : (b.failed ?? b.before)), answer.before);
    const found = findTransitional(answer.before, composed, answer.node.path);
    if (found !== null) {
      return Verdict.error(
        new StateFlowError(
          "SF022",
          `${pathName(answer.node.path)}: its failed ${String(failed)} would leave ${pathName(found)} in a transitional variant`,
        ),
      );
    }
  }
  return findStepError(reduction, first, aborted) ?? { C, reduction, first };
}

/**
 * The plan's conflict check: an Error when a reducer's answer replaced or removed a node below it whose own reducer
 * answered too, so two reducers would decide one state; null when there is none. An answer's next, temp and failed
 * must each hold every answered node below it (see {@link findLostAnswer}).
 */
function findConflict(reduction: Reduction): Result | null {
  for (const answer of reduction.answers) {
    for (const x of [answer.next, answer.transition?.temp, answer.failed]) {
      const lost = isState(x) ? findLostAnswer(x, answer.node) : null;
      if (lost !== null) {
        return Verdict.error(
          new StateFlowError(
            "SF023",
            `${pathName(answer.node.path)} replaced or removed ${pathName(lost.path)}, whose own reducer also answered`,
          ),
        );
      }
    }
  }
  return null;
}

/**
 * The plan's step checks: an Error when a step of the plan enters an asynchronous variant, or a face it may commit
 * breaks one of the DisposableBox rules (see {@link findBoxError}); null when none does.
 *
 * No step may make a node enter an asynchronous variant but the end of a declared transition into it, whose work is
 * that variant's transition handlers. The variant's mark decides, whatever handlers are registered or mocked and
 * whatever the handlers-off switch says. Every other step is synchronous, so none of these may enter one:
 * - `first`: to next, or to the temp face (which is next without a transition);
 * - the failed step after a refused `first`, which runs when an answer declared a failed: to the failed face, where
 *   each answer holds its failed, or else its instance before the signal, as one without failed stays;
 * - the declared transition's failed end, from the temp face to its failed.
 *
 * The DisposableBox rules check the faces the plan may commit; in an abort's dispatch (`aborted`, the transition it
 * aborts) the failed step's face holds that transition's failed where the failed face would leave its temp, as
 * failPath places it.
 *
 * The end and the failed end start from the committed temp, which is not made yet, so their faces are planned here
 * from the temp face. For the entry rule that is exact: a fold changes no variant, and another state's answer to a
 * named result commits in the temp step only where both ends keep the node (see endsHold).
 */
function findStepError(reduction: Reduction, first: Step, aborted: DeclaredAnswer | null): Result | null {
  const entered = findAsynchronousEntryIn(first.from, first.to);
  if (entered !== null) {
    return Verdict.error(
      new StateFlowError("SF024", `${entering(entered)}, whose entry is asynchronous; declare a transition`),
    );
  }

  const { declared } = reduction;

  // Each failed step's start and the face it goes to, with its name in an Error. Without a failed declared, the failed
  // face holds the committed instances, which it does not enter anew, so it is not built.
  const followed: Array<[FlowSnapshot, FlowSnapshot, string]> = [];

  // For the DisposableBox checks: the faces the plan may commit before a declared transition's ends, and the faces of
  // those two ends, each with its name in an Error.
  const faces: Array<[FlowSnapshot, string]> = [[first.to, declared === null ? "in next" : "in temp"]];
  const ends: Array<[FlowSnapshot, string]> = [];

  if (reduction.answers.some((answer) => answer.failed !== undefined)) {
    const F = face(first.from, reduction.decided, (answer) => answer.failed ?? answer.before);
    followed.push([first.from, F, "in the failed step"]);

    // An abort's failed step also ends the transition it aborts in that transition's failed, where F would leave its
    // temp (see failPath), so that is the face it may commit.
    const ending = aborted !== null && findTransitionalIn(first.from, F) !== null;
    faces.push([ending ? endFace(F, aborted, aborted.failed) : F, "in the failed step"]);
  }

  if (declared !== null) {
    const temp = first.to;
    const failedEnd = endFace(temp, declared, declared.failed);
    followed.push([temp, failedEnd, "at the failed end of the transition"]);
    ends.push(
      [endFace(temp, declared, declared.next), "at the end of the transition"],
      [failedEnd, "at the failed end of the transition"],
    );
  }

  for (const [from, failed, where] of followed) {
    const asynchronous = findAsynchronousEntryIn(from, failed);
    if (asynchronous !== null) {
      return Verdict.error(
        new StateFlowError(
          "SF025",
          `${entering(asynchronous)}, whose entry is asynchronous, ${where}; declare a transition`,
        ),
      );
    }
  }

  // Skipped while no DisposableBox was made: no face can hold one then.
  return madeDisposableBoxes === 0 ? null : findBoxError(first, faces, ends);
}

/**
 * The plan's DisposableBox checks (see DisposableBox): an Error when a face of `faces`, those the plan may commit
 * before a declared transition's ends, or of `ends`, the faces of those ends, breaks a rule of one face (see
 * {@link findFaceBoxError}); or when an end holds a box that the committed states (`first.from`) hold and the temp
 * (`first.to`) does not, since the temp's commit disposes it. Each face comes with its name in an Error. Null when none
 * does.
 */
function findBoxError(
  first: Step,
  faces: ReadonlyArray<[FlowSnapshot, string]>,
  ends: ReadonlyArray<[FlowSnapshot, string]>,
): Result | null {
  for (const [face, where] of [...faces, ...ends]) {
    const found = findFaceBoxError(face, where);
    if (found !== null) {
      return found;
    }
  }

  // Only a declared transition has ends. Its temp commits before them and disposes what it drops of the committed
  // states, so neither end may hold that again.
  if (ends.length === 0) {
    return null;
  }

  const temp = new Set(placesIn(first.to).map((place) => place.box.deref()));
  const committed = new Map(placesIn(first.from).map((place) => [place.box.deref(), place]));
  for (const [end, where] of ends) {
    for (const place of placesIn(end)) {
      const value = place.box.deref();
      const was = committed.get(value);
      if (was !== undefined && !temp.has(value)) {
        return Verdict.error(
          new StateFlowError(
            "SF026",
            `${placeName(place)} holds ${String(place.box)} ${where}, which the temp drops from ${placeName(was)}; the temp's commit disposes it`,
          ),
        );
      }
    }
  }
  return null;
}

/**
 * The DisposableBox rules of one face (see DisposableBox): an Error, which names the places and has `where` name the
 * face, when `face` holds one box in two places or a box the engine disposed already; null when it holds neither. Two
 * boxes are one by Box.equals, so the places are keyed by the boxed value.
 */
function findFaceBoxError(face: FlowSnapshot, where: string): Result | null {
  const seen = new Map<unknown, Place>();
  for (const place of placesIn(face)) {
    const value = place.box.deref();
    const twin = seen.get(value);
    if (twin !== undefined) {
      return Verdict.error(
        new StateFlowError(
          "SF027",
          `${placeName(twin)} and ${placeName(place)} hold ${String(place.box)} ${where}; a DisposableBox has one place in the states`,
        ),
      );
    }

    if (disposedValues.has(value)) {
      return Verdict.error(
        new StateFlowError(
          "SF028",
          `${placeName(place)} holds ${String(place.box)} ${where}, which the engine disposed already`,
        ),
      );
    }

    seen.set(value, place);
  }
  return null;
}

/** How an Error names `place`: the node's path as the log names it, then the prop (`link.conn`). */
function placeName(place: Place): string {
  return `${pathName(place.path)}.${place.prop}`;
}

/** "<path> enters <variant>", for the node at `path` entering `entered`. */
function entering({ path, entered }: AsynchronousEntry): string {
  return `${pathName(path)} enters ${String(entered[VARIANT])}`;
}

/**
 * Runs a dispatch whose reducers declared no transition: its first step commits next, and when a handler refuses it
 * the failed path follows in the same entry (see {@link failPath}). Returns the dispatch's result.
 */
function runOk(run: DispatchRun, plan: Plan): Result {
  let outcome: Result = Verdict.ok();
  try {
    const stepped = runStep(run, plan.first);
    if (stepped.committed === null) {
      outcome = failPath(run, plan, stepped);
    }
  } catch (err) {
    // A string form that throws while a step's changes are logged stops the step before its commit (see
    // logChanges). The throw goes on to the caller; the entry still records it.
    outcome = Verdict.error(err);
    throw err;
  } finally {
    // The states the target has: next, the failed step's, or, refused without failed, those it had.
    finish(run, prepareSnapshot(run.target, run.meta), outcome);
  }
  return outcome;
}

//#endregion

//#region Failed

/**
 * The failed path of `refused`, a refused ok or temp step, written to its entry: every answer goes to the failed its
 * reducer declared, and one without failed stays as it was. The failed step is the diff from the snapshot the reducers
 * ran on to that face, and takes over what the refused step carried (see {@link runFailedStep}). In a transition's
 * dispatch, its entry is marked failed when that step commits.
 */
function failPath(run: DispatchRun, plan: Plan, refused: Refused): Result {
  let F = face(plan.C, plan.reduction.decided, (answer) => answer.failed ?? answer.before);
  const aborted = run.aborted?.declared;
  let cause: "aborted" | null = null;
  // An abort's dispatch runs on a snapshot that holds a transitional variant: the temp of the transition it aborts,
  // at or below that transition's declaring node. A node without failed keeps it, and a transitional variant commits
  // only as a temp, so the aborted transition ends in its failed in this step, with the other answers' failed, and the
  // step's FAILURE data says so.
  // Placed on this face, that failed enters no asynchronous variant: what it shares with its temp comes from this face,
  // which this dispatch's plan checked, and its own plan checked the rest against that temp, which plan.C holds as it
  // committed (a fold changes no variant, and another state's answer in that temp step stands only where the failed
  // keeps the node, see endsHold).
  if (aborted !== undefined && findTransitionalIn(plan.C, F) !== null) {
    F = endFace(F, aborted, aborted.failed);
    cause = "aborted";
  }
  const step = prepareStep(run.meta, plan.C, F);
  if (plan.reduction.declared !== null && step.changes.length > 0) {
    run.collector.setTransition("failed");
  }
  return runFailedStep(run, step, refused, cause);
}

/**
 * Runs `step` as the failed step after `refused`: the step before it, which did not commit, or what ended the
 * transition (see {@link runStep}). It takes over what the refused step carried, so the DisposableBoxes of that step
 * which its own committed states hold stay, and the others are disposed with its own, once, after its commit delegates
 * and commit handlers. When it changes nothing, nothing commits, and they are disposed at once unless the committed
 * states hold them. Its FAILURE data (see {@link FailureData}) takes its kind from `cause` when the timeout or an
 * accepted abort ended a transition, and from the refusal otherwise; its reason and error come from the refusal.
 *
 * @returns The merge of the refusal with the failed step's refusal as an Error: a failed step's handlers and fold
 *   cannot stop its commit, and what they refuse is an Error of the result.
 */
function runFailedStep(run: DispatchRun, step: Step, refused: Refused, cause: "timeout" | "aborted" | null): Result {
  const { refusal: failure, named, planned } = refused;
  if (step.changes.length === 0) {
    disposeCarried(run.meta, planned, named, step.from);
    return mergeResults([failure]);
  }
  // A failure is a Rejected, which holds a message, or an Error, which holds an error; a Result gives null for what it
  // does not hold, and `?? undefined` turns a null error into an absent field.
  // One object for every reducer that gets it, frozen, so no reducer changes what the next one reads. The refusal's
  // data is copied and frozen as a signal's payload is, so props that keep it do not freeze the handler's object.
  const data: FailureData = Object.freeze({
    kind: cause ?? (failure.kind === ResultKind.Rejected ? "rejected" : "error"),
    reason: failure.message ?? failure.error?.message,
    error: failure.error ?? undefined,
    ...(failure.data === undefined ? {} : { data: Object.freeze({ ...failure.data }) }),
  });
  const { refusal } = runStep(run, step, { failure: data, named, planned });
  if (refusal === null) {
    return mergeResults([failure]);
  }
  const asError =
    refusal.kind === ResultKind.Error
      ? refusal
      : Verdict.error(new StateFlowError("SF029", refusal.message ?? String(refusal)));
  return mergeResults([failure, asError]);
}

/**
 * The FAILURE result, with `data`, for each node the failed step `step` enters or updates whose variant has a reducer
 * for it, in the order the step makes those calls, updates before enters. Every such node lies inside a failed that a
 * reducer declared, since a node without one keeps its instance.
 */
function failureResults(step: Step, data: FailureData): ResultToFold[] {
  return [...step.update, ...step.enter].flatMap((call) =>
    FAILURE in call.instance[VARIANT][RESULT_REDUCERS] ? [{ call, name: FAILURE, data }] : [],
  );
}

//#endregion

//#region Steps

/**
 * The step from `from` to `to`, a frozen snapshot, prepared without touching the world: each state's tree is
 * diffed node by node (see {@link diffNode}). Inside each tree, exits run children first and later siblings
 * first, and updates and enters parents first; the states take their turns in the flow's order.
 */
function prepareStep(meta: StateFlowMeta, from: FlowSnapshot, to: FlowSnapshot): Step {
  const exit: HandlerCall[] = [];
  const update: HandlerCall[] = [];
  const enter: HandlerCall[] = [];
  const changes: StateChange[] = [];
  for (const def of meta.states) {
    const state = getName(def);
    const tree: TreeDiff = { exit: [], update, enter, changes };
    diffNode(from[state], to[state], topLevel(state), undefined, tree);
    // diffNode collects in pre-order; reversed, this tree's exits run children first and later siblings first.
    exit.push(...tree.exit.reverse());
  }
  return { from, to, exit, update, enter, changes };
}

/**
 * Runs a prepared step: its exit, update and enter handlers, the fold of the named results the update and enter
 * handlers returned into the nodes whose handlers returned them, the answers of the other states that take those
 * results (see {@link answerResults}), the commit of what that gives, then the commit delegates: `delegates` first,
 * then those the handlers' results carry, of every round, in the order of their calls (see HandlerResult.onCommit),
 * then the commit handlers, then the disposal of the DisposableBoxes the step carried that the committed states do not
 * hold (see {@link disposeCarried}).
 *
 * The handlers of the phases see the instances as the reducers declared them; the commit, the delegates, the commit
 * handlers, the observers and the entry's changes see them folded.
 *
 * `named` and `planned` are what the step carries besides its own, whose DisposableBoxes it disposes with its own: at a
 * declared transition's end (see {@link reachNext}), its work's named results and the end's face before they folded
 * in; in a failed step, what the refused step before it carried (see {@link runFailedStep}). At the end, `delegates`
 * are those its work's results carry, which the end step runs before its own handlers' and drops with them when it does
 * not commit.
 *
 * When other states took a result, a further round runs the handlers of the nodes their answers change, on the
 * target with the results folded in, and folds the named results those handlers return, which other states may take
 * in turn; the step commits once a round leaves nothing more to take. A round answers only nodes that no earlier
 * round, and no reducer of the step, changed, so the rounds end.
 *
 * A phase's refusal or a fold's or an answer's failure stops the step: nothing after it runs, nothing commits, the
 * entry gets the changes the round attempted, and the step returns what it carried, which the failed step after it
 * takes over. A failed step (`failure` given: the FAILURE data of what refused the step before it, or ended the
 * transition) is a floor, which commits whatever its handlers return instead: every phase runs, every result that
 * folds folds, the commit and the commit handlers run, and the refusals come back with what it committed. Its first
 * fold starts with the FAILURE results (see {@link failureResults}).
 *
 * In a transition's temp step (`pending` given), the transition is pending from the commit on, so a commit handler
 * that calls sync() or lock() waits for its end.
 *
 * The update and enter handlers of every round get the step's AbortSignal, which aborts when the step does not commit,
 * whatever stopped it, and never once it committed (see EnterHandler). A throw that stops the step before its commit
 * (a string form, see logChanges) reaches the caller, and no failed step takes over what the step carried: as the
 * signal aborts, the DisposableBoxes the committed states do not hold are disposed. The step is the unit because its
 * rounds commit together or not at all.
 */
function runStep(
  run: DispatchRun,
  step: Step,
  {
    failure = null,
    pending = null,
    delegates: givenDelegates = [],
    named: givenNamed = [],
    planned: givenPlanned = [],
  }: {
    failure?: FailureData | null;
    pending?: PendingTransition | null;
    delegates?: readonly DelegateCall[];
    named?: readonly NamedResult[];
    planned?: readonly FlowSnapshot[];
  } = {},
): StepOutcome {
  const { target, meta, collector } = run;
  const floor = failure !== null;
  const controller = new AbortController();

  // The given ones, then those the rounds add; a step that does not commit drops them all unrun.
  const delegates: DelegateCall[] = [...givenDelegates];

  // What the step carries, whose DisposableBoxes are disposed when the committed states after it do not hold them: the
  // named results, those given, then those of every round; and the snapshots, those given, the step's target, then that
  // of every further round, which holds what the round before folded and answered.
  const named: NamedResult[] = [...givenNamed];
  const planned: FlowSnapshot[] = [...givenPlanned, step.to];

  meta.inStep = true;
  try {
    let refusal: Result | null = null;
    let failures: ResultToFold[] = failure === null ? [] : failureResults(step, failure);
    let round = step;
    let to: FlowSnapshot;
    for (;;) {
      const ran = runRound(
        run,
        step.from,
        round,
        failures,
        floor,
        pending?.declared ?? null,
        controller.signal,
        delegates,
      );
      named.push(...ran.named);
      if (ran.failure !== null) {
        refusal = refusal === null ? ran.failure : refusal.merge(ran.failure);
        if (!floor) {
          logChanges(collector, prepareStep(meta, step.from, round.to).changes);

          // Inside the step guard, so a listener can no more dispatch to or dispose the target than a handler can.
          controller.abort();
          return { committed: null, refusal, named, planned };
        }
      }
      if (ran.answered === ran.folded) {
        to = ran.folded;
        break;
      }
      round = prepareStep(meta, ran.folded, ran.answered);
      planned.push(round.to);
      failures = [];
    }
    // Every node the step changed, with what commits there, undefined where a position empties, and the enter calls,
    // whose commit handlers run: the diff from where the step started to what its rounds left.
    const done = prepareStep(meta, step.from, to);
    logChanges(collector, done.changes);
    applyState(target, meta, done.changes, collector);
    run.committed = done.changes;
    if (pending !== null) {
      meta.pending = pending;
    }

    // A throw is caught here, as a commit handler's is: in a temp step the transition is pending already.
    for (const { call, handler, delegate } of delegates) {
      try {
        delegate();
      } catch (err) {
        collector.logHandler(call.name, "commit", handler.name, Verdict.error(err));
      }
    }

    runCommitHandlers(meta, done.enter, to, collector);

    // The states before the step did not stay either.
    disposeCarried(meta, [step.from, ...planned], named, to);
    return { committed: to, refusal };
  } catch (err) {
    controller.abort();
    disposeCarried(meta, planned, named, step.from);
    throw err;
  } finally {
    meta.inStep = false;
  }
}

/**
 * Disposes each DisposableBox a step carried that `kept`, the committed states after it, does not hold (see
 * DisposableBox): those that the top-level instances of the snapshots `dropped` hold where `kept` holds another
 * instance, and those of `named`, the named results the step's handlers returned, a result's data that is a box
 * included. `dropped` is the side of the step that did not stay: what it planned, and after a commit the states before
 * it too. A failed step's `dropped` and `named` include what the refused step before it carried. Each value is disposed
 * once, through `Symbol.dispose`, or else `Symbol.asyncDispose`, not awaited; a throw or a rejection goes to
 * console.error. Skipped while no DisposableBox was made: no state or result can hold one then.
 */
function disposeCarried(
  meta: StateFlowMeta,
  dropped: readonly FlowSnapshot[],
  named: readonly NamedResult[],
  kept: FlowSnapshot,
): void {
  if (madeDisposableBoxes === 0) {
    return;
  }

  const carried: Place[] = [];
  for (const snapshot of dropped) {
    for (const state in snapshot) {
      if (snapshot[state] !== kept[state]) {
        addPlaces(snapshot[state], topLevel(state), carried);
      }
    }
  }

  // A named result's data may be a box itself, placed here under the result's name, or hold boxes in its props as a
  // node does. A string is skipped: for-in would read each of its characters as a prop.
  for (const { call, name, data } of named) {
    if (data instanceof DisposableBox) {
      carried.push({ box: data, path: call.path, prop: name });
    } else if (typeof data === "object") {
      addPlaces(data, call.path, carried);
    }
  }

  // Every node of the committed states counts, so they are read only when the step carried a box.
  if (carried.length === 0) {
    return;
  }

  const held = new Set(placesIn(kept).map((place) => place.box.deref()));
  for (const { box } of carried) {
    const value = box.deref();
    if (held.has(value) || disposedValues.has(value)) {
      continue;
    }
    disposedValues.add(value);

    // DisposableBox.of took a value that has one of the two. The executor runs at once, so a sync dispose is called
    // now; its throw, like an async dispose's rejection, rejects the promise, which nothing awaits.
    new Promise((resolve) => resolve((value[Symbol.dispose] ?? value[Symbol.asyncDispose]).call(value))).catch(
      (err: unknown) => console.error(`[SF/${meta.name}] the dispose of ${String(box)} failed:`, err),
    );
  }
}

/**
 * Runs one round of a step that started from `from`: the exit, update and enter handlers of `round`, the fold of
 * `failures` and of the named results the update and enter handlers return into `round.to`, in the order of their
 * calls, and the other states' answers to those named results (see {@link answerResults}); `declared` is the
 * transition whose temp the step commits, null in any other step, `signal` the step's AbortSignal, and `delegates` the
 * step's commit delegates, which the handlers' results add to.
 *
 * @returns The round's failure: outside a floor step, the first phase's refusal, which stops the round, or the fold's
 *   or an answer's; in a floor step, the merge of all of them; null when none failed. Also the target with the results
 *   folded in, and that target with the answers composed in, the same snapshot when no other state took a result; and
 *   the named results the round's handlers returned.
 */
function runRound(
  run: DispatchRun,
  from: FlowSnapshot,
  round: Step,
  failures: readonly ResultToFold[],
  floor: boolean,
  declared: DeclaredAnswer | null,
  signal: AbortSignal,
  delegates: DelegateCall[],
): { failure: Result | null; folded: FlowSnapshot; answered: FlowSnapshot; named: NamedResult[] } {
  const named: NamedResult[] = [];
  const refusals: Result[] = [];
  for (const kind of ["exit", "update", "enter"] as const) {
    const phase = runPhase(run, kind, round[kind], round.to, named, signal, delegates);
    if (phase !== null) {
      refusals.push(phase);
      if (!floor) {
        return { failure: phase, folded: round.to, answered: round.to, named };
      }
    }
  }
  const folded = fold(round.to, [...failures, ...named], floor);
  const answered = answerResults(run.meta, from, folded, floor, declared);
  if (answered.failure !== null) {
    refusals.push(answered.failure);
  }
  return {
    failure: refusals.length > 0 ? mergeResults(refusals) : null,
    folded: folded.snapshot,
    answered: answered.snapshot,
    named,
  };
}

/**
 * Takes each named result among `folded.taken`, the results a fold into a step's target folded, as a fact of the flow:
 * the other states' answers to it compose into `folded.snapshot` (see {@link answerResult}), on top of the answers to
 * the results before it. A result whose fold failed, which a floor step skipped at its node, reaches no other state,
 * and FAILURE is no named result: only the failed step's own nodes take it. `from` is the snapshot the step started
 * from, where those reducers run, and `declared` the transition whose temp the step commits, null in any other step. A
 * result whose answers refuse, or break a rule of the plan, is a failure, as a failed fold is: it stops, and in a floor
 * step, which commits whatever happens, its answers are left out and it is kept. The fold's failure stops before any
 * other state takes a result, except in a floor step. Outside a floor step, once the answers composed, a snapshot that
 * holds a DisposableBox in two places, or one the engine disposed, is a failure too (see {@link findFaceBoxError}), so
 * the step is refused before its commit.
 *
 * @returns The snapshot with the answers composed in, frozen, and the failure, the fold's included: the first, or in a
 *   floor step the merge of every failure; null when none failed.
 */
function answerResults(
  meta: StateFlowMeta,
  from: FlowSnapshot,
  folded: ReturnType<typeof fold>,
  floor: boolean,
  declared: DeclaredAnswer | null,
): { snapshot: FlowSnapshot; failure: Result | null } {
  if (folded.failure !== null && !floor) {
    return folded;
  }
  let answered = folded.snapshot;
  const failures = folded.failure === null ? [] : [folded.failure];
  for (const result of folded.taken.filter((taken): taken is NamedResult => typeof taken.name === "string")) {
    const composed = answerResult(meta, from, answered, result, declared);
    if (composed instanceof Result) {
      failures.push(composed);
      if (!floor) {
        break;
      }
    } else {
      answered = composed;
    }
  }

  // Not checked where an answer failed, which stops the step anyway, nor where nothing folded: the snapshot is then
  // the step's target, which the plan checked, or at a transition's end reachNext checks.
  const boxed =
    floor || failures.length > 0 || folded.taken.length === 0 || madeDisposableBoxes === 0
      ? null
      : findFaceBoxError(answered, "when the named results fold");
  if (boxed !== null) {
    failures.push(boxed);
  }
  return { snapshot: answered, failure: failures.length > 0 ? mergeResults(failures) : null };
}

/**
 * `to` with the answers of the other states to `result` (see reduceResult) composed in, as a signal's answers compose
 * into its face (see face): each at its node, holding the answers below it, with what it keeps of its node's instance
 * before the step taken from `to`, so a change the step made below the node lands in it (see adopt). `to` itself when
 * no state took the result. The reducers ran on `from`, the snapshot the step started from.
 *
 * Returns the reducers' refusal, or an Error when the answers break a rule of the plan, checked in this order, so none
 * of them composes: an answer replaced or removed a node whose own reducer answered too (see {@link findConflict}); an
 * answer decides a node that the step, or an earlier result's answer, changed already (see findLostChange), or, in the
 * temp step of `declared`, a node at or below its declaring node that its next or failed does not keep (see
 * {@link endsHold}), either of which would decide one state twice; it leaves a node in a transitional variant; it
 * enters an asynchronous variant, which only a declared transition's next enters.
 */
function answerResult(
  meta: StateFlowMeta,
  from: FlowSnapshot,
  to: FlowSnapshot,
  result: NamedResult,
  declared: DeclaredAnswer | null,
): FlowSnapshot | Result {
  const reduction = reduceResult(meta.states, from, result, meta.reducers, meta.byValue);
  if (reduction instanceof Result) {
    return reduction;
  }
  const conflict = findConflict(reduction);
  if (conflict !== null) {
    return conflict;
  }
  for (const { node, before, next } of reduction.answers) {
    const where = `${pathName(node.path)}: the result reducer ${result.name} of ${String(before[VARIANT])}`;
    const lost = findLostChange(next, before, instanceAt(to, node.path), node.path);
    if (lost !== null) {
      return Verdict.error(
        new StateFlowError(
          "SF030",
          `${where} answered for ${pathName(lost)}, which this step changes already; two answers would decide one state`,
        ),
      );
    }
    if (declared !== null && !endsHold(declared, node.path, before)) {
      return Verdict.error(
        new StateFlowError(
          "SF031",
          `${where} answered for a node the transition of ${pathName(declared.node.path)} decides at its next or failed; two answers would decide one state`,
        ),
      );
    }
    const left = findTransitional(before, next, node.path, true);
    if (left !== null) {
      return Verdict.error(
        new StateFlowError(
          "SF032",
          `${where} would leave ${pathName(left)} in a transitional variant, which commits only as the temp of a declared transition`,
        ),
      );
    }
    const entered = findAsynchronousEntry(before, next, node.path);
    if (entered !== null) {
      return Verdict.error(
        new StateFlowError(
          "SF033",
          `${where}: ${entering(entered)}, whose entry is asynchronous; declare a transition`,
        ),
      );
    }
  }
  // Each answer's node stands in `to` as an instance of the origin it had before the step (findLostChange), so adopt
  // has it to take the step's changes below from. With no answer, `to` itself, the same snapshot, which tells runStep
  // that no further round is due.
  return reduction.answers.length === 0
    ? to
    : face(to, reduction.decided, (answer) =>
        adopt(answer.next, answer.before, instanceAt(to, answer.node.path) as StateInstance),
      );
}

/**
 * Whether the ends of `declared`, its next and its failed, keep `x`, the instance of the node at `path` before the temp
 * step, as the temp does, when `path` is the declaring node or below it; true for a node elsewhere. The end puts what
 * the temp step committed in the place of what the ends keep (see adoptAt), so another state's answer there commits at
 * the end too; a node an end builds anew is that end's decision, as for the answers of the transition's own signal.
 */
function endsHold(declared: DeclaredAnswer, path: Path, x: StateInstance): boolean {
  const depth = declared.node.path.positions.length;
  // The node at `path` is the declaring node or below it when the first `depth` positions of `path` lead to it.
  const head: Path = { state: path.state, positions: path.positions.slice(0, depth) };
  const below = path.positions.slice(depth);
  return (
    !samePath(declared.node.path, head) || [declared.next, declared.failed].every((end) => heldAt(end, below) === x)
  );
}

/**
 * Adds a step's changes to its entry: as the step prepared them when it committed nothing, or as it committed them,
 * with the named results folded in, so the entry matches its finalStates.
 */
function logChanges(collector: ResultCollector, changes: StateChange[]): void {
  for (const change of changes) {
    collector.logStateChange(change.stateName, change.old, change.next);
  }
}

/**
 * Runs every handler of one phase of a step: the calls in their order (see {@link prepareStep}), each call's
 * handlers in registration order, each logged as a handler result. An update or enter handler gets `signal`, the
 * step's AbortSignal, fifth (see EnterHandler). The named results the handlers return are added to `named`, with
 * their calls, and the commit delegates their results carry, whatever their kind, to `delegates`, in the order of the
 * calls. Returns the merge, in that order, of the failures among their results (a Rejected, or an Error, which a throw
 * becomes; see Result.merge), which refuses the step, or null when none failed. The phase's other handlers run anyway,
 * and an Ignored refuses nothing.
 */
function runPhase(
  { target, meta, collector }: DispatchRun,
  kind: "exit" | "update" | "enter",
  calls: HandlerCall[],
  snapshot: FlowSnapshot,
  named: NamedResult[],
  signal: AbortSignal,
  delegates: DelegateCall[],
): Result | null {
  const results: Result[] = [];

  // An exit handler releases and makes nothing, so it gets no signal (see StateHandler).
  const fifth = kind === "exit" ? [] : [signal];

  for (const call of calls) {
    const variant = call.instance[VARIANT];
    for (const handler of handlersFor(meta.handlers, variant, kind)) {
      let result: Result;
      try {
        const returned = handler.cb.call(handler.context, call.instance, snapshot, call.prev, call.key, ...fifth);
        result = stepResult(returned, handler.name, kind, variant);
      } catch (err) {
        // Verdict.error gives any thrown value a string form, so logging the result cannot throw.
        result = Verdict.error(err);
      }
      collector.logHandler(call.name, kind, handler.name, result);
      taps.size > 0 && tellTaps(meta, (tap) => tap.handled(target, kind, call, result));
      if (result instanceof HandlerResult && result.named !== null) {
        named.push({ call, name: result.named.name, data: result.named.data });
      }
      if (result instanceof HandlerResult) {
        delegates.push(...result.delegates.map((delegate) => ({ call, handler, delegate })));
      }

      // Tagged so that, when this result refuses the step, the dispatch's result names its handler and the node.
      // A copy is tagged: the handler's own result may be a constant that other handlers return too.
      results.push(result.copy().withHandlerName(handler.name).withStateUpdating(`${kind} ${call.name}`));
    }
  }
  const failures = results.filter((result) => result.in(ResultKind.Rejected, ResultKind.Error));
  return failures.length > 0 ? mergeResults(failures) : null;
}

/**
 * Runs the commit handlers of the entered nodes, each on the node as `snapshot`, the committed one, holds it,
 * and logged as a handler result. None can throw out of here: in a declared transition's temp step they run after the
 * transition is pending, where a throw would leave it with no end.
 */
function runCommitHandlers(
  meta: StateFlowMeta,
  calls: HandlerCall[],
  snapshot: FlowSnapshot,
  collector: ResultCollector,
): void {
  for (const call of calls) {
    const instance = instanceAt(snapshot, call.path) as StateInstance;
    for (const handler of handlersFor(meta.handlers, instance[VARIANT], "commit")) {
      let result: Result = Verdict.ok();
      try {
        const returned = handler.cb.call(handler.context, instance, snapshot, call.prev, call.key);
        if (isThenable(returned)) {
          // Not awaited: the step's entry may be delivered before the promise settles, so a rejection can no
          // longer be its handler result.
          const variant = String(call.instance[VARIANT]);
          Promise.resolve(returned).catch((reason: unknown) => {
            console.error(`[SF/${meta.name}] commit handler ${handler.name} on ${variant} rejected:`, reason);
          });
        }
      } catch (err) {
        // Verdict.error gives any thrown value a string form, so logging the result cannot throw either.
        result = Verdict.error(err);
      }
      collector.logHandler(call.name, "commit", handler.name, result);
    }
  }
}

//#endregion

//#region Transition

/**
 * Starts the transition `declared` declared (see StateResult.transition). Its first step commits the temp face: temp
 * at the declaring node and every other answer's next (see {@link runTempStep}). From what committed the end is
 * prepared: the step to next, which changes only the declaring node (see {@link endFace}). Its enter calls give the
 * work: every transition handler of every asynchronous variant it enters, nested states included (see
 * {@link startWork}).
 *
 * @returns A pending result whose done() resolves to the end; the end's outcome when there is no work, as the end
 *   then runs inside this call; or the failed path's result when a handler refused the temp step, which starts no
 *   transition.
 */
function startTransition(run: DispatchRun, plan: Plan, declared: DeclaredAnswer): Result {
  const { meta } = run;
  const p = newPending(run, declared);
  const committed = runTempStep(run, plan, p);
  if (committed instanceof Result) {
    return committed;
  }
  // No user code runs from here to startWork, so nothing can leave p pending with no end.
  const end = prepareStep(meta, committed, endFace(committed, declared, declared.next));
  // Only an asynchronous variant has transition handlers: addTransitionHandler and mockHandlers refuse any other.
  const planned = end.enter.flatMap((call) =>
    handlersFor(meta.handlers, call.instance[VARIANT], "transition").map((handler) => ({ call, handler })),
  );
  if (planned.length === 0) {
    // No work: the end enters no asynchronous variant, or no transition handler of one runs. The end runs inside this
    // call; no handler got the signal, so a refused end has no signal to abort.
    return endTransition(p, end, null).outcome;
  }
  startWork(p, end, planned);
  return Verdict.pending(p.promise).withSignal(run.signal);
}

/** A transition of `declared`, in `run`, before anything of it ran. */
function newPending(run: DispatchRun, declared: DeclaredAnswer): PendingTransition {
  const { promise, resolve } = deferred<Result>();
  const startTime = Date.now();
  return {
    run,
    declared,
    controller: new AbortController(),
    timer: undefined,
    expire: () => {},
    works: [],
    settled: Promise.resolve(),
    aborting: false,
    dropped: false,
    startTime,
    promise,
    resolve: (outcome) => resolve(outcome.withTimestamps(startTime, Date.now())),
  };
}

/**
 * Runs the temp step of `p`'s dispatch, a full step with the dispatch's other answers, written to the dispatch's
 * entry, marked temp; one that changes nothing makes no call and commits nothing new, as any step. `p` is pending
 * from the commit on (see {@link runStep}). The entry is finished before the work is planned, so it records the
 * pending result even when the transition turns out to have no work and its end, in an entry of its own, runs inside
 * the send. A refused temp step follows ok's rules: the failed path runs (see {@link failPath}) and no transition
 * starts, so next never commits: the failed step takes over next's face as planned with what the temp step carried.
 *
 * @returns What the step committed; or, when a handler refused it, the failed path's result.
 */
function runTempStep(run: DispatchRun, plan: Plan, p: PendingTransition): FlowSnapshot | Result {
  run.collector.setTransition("temp");
  let outcome: Result = Verdict.pending(p.promise);
  try {
    const stepped = runStep(run, plan.first, { pending: p });
    if (stepped.committed === null) {
      const next = endFace(plan.first.to, p.declared, p.declared.next);
      outcome = failPath(run, plan, { ...stepped, planned: [...stepped.planned, next] });
      return outcome;
    }
    return stepped.committed;
  } catch (err) {
    // A string form that throws while the step's changes are logged stops it before its commit, so before p is
    // pending: no transition starts, and the throw goes on to the caller.
    outcome = Verdict.error(err);
    throw err;
  } finally {
    finish(run, prepareSnapshot(run.target, run.meta), outcome);
  }
}

/**
 * `x`, an answer of `declared`'s reducer (its next, or a failed), as the end puts it at the declaring node of `from`
 * (see {@link adopt}): the reducer built `x` beside temp, from the same instance, and temp stands in `from` as it
 * committed, with the answers below it and the named results folded into them.
 */
function adoptAt(from: FlowSnapshot, declared: DeclaredAnswer, x: StateInstance): StateInstance {
  // `from` holds the declaring node: it committed it, or it is an abort's failed face that holds the transitional
  // node at or below it (see failPath).
  const cur = instanceAt(from, declared.node.path) as StateInstance;
  return adopt(x, declared.transition.temp, cur);
}

/** `from` with `x` at the declaring node, adopted (see {@link adoptAt}): an end changes only that node. */
function endFace(from: FlowSnapshot, declared: DeclaredAnswer, x: StateInstance): FlowSnapshot {
  return replaceAt(from, declared.node.path, adoptAt(from, declared, x));
}

/**
 * Starts the work of `p`: each planned transition handler, called with the instance `end` enters, the end's
 * target before any fold, the instance it replaces, its key, and the transition's signal, all at once. Their
 * synchronous parts run inside the step guard, so none dispatches to or disposes its own target. Each work's result
 * goes to {@link onWorkSettled} as it settles, unless the timer ends the transition first (see {@link onTimeout}).
 * The signal aborts at every end that commits none of the work's results, and only there: as it aborts, the
 * DisposableBoxes of next's face as planned and of the results settled by then are disposed, unless the committed
 * states hold them or the failed end after a refused end step disposed them already (see {@link runFailedStep}), and
 * onWorkSettled disposes those of a result that settles later.
 */
function startWork(
  p: PendingTransition,
  end: Step,
  planned: ReadonlyArray<{ call: HandlerCall; handler: Registered }>,
): void {
  const { target, meta } = p.run;
  const { timeoutMs } = p.declared.transition;
  const signal = p.controller.signal;

  signal.addEventListener("abort", () =>
    disposeCarried(meta, [end.to], workResults(p.works), prepareSnapshot(target, meta)),
  );

  p.expire = () => onTimeout(p, end);
  p.timer = meta.timers.setTimeout(() => p.expire(), timeoutMs);
  const settled: Array<Promise<Result>> = [];
  meta.inStep = true;
  try {
    for (const { call, handler } of planned) {
      const work: WorkCall = { call, handler, result: null };
      p.works.push(work);
      const result = transitionResult(
        () => handler.cb.call(handler.context, call.instance, end.to, call.prev, call.key, signal),
        handler.name,
        call.instance[VARIANT],
      );
      settled.push(
        result.then((r) => {
          work.result = r;
          onWorkSettled(p, end, work, r);
          return r;
        }),
      );
    }
  } finally {
    meta.inStep = false;
  }
  p.settled = Promise.all(settled);
}

/**
 * Takes `result`, what `work` of `p` settled to. While `p` is pending, the first Rejected or Error ends it at once in
 * its failed, whatever the other works give; once every work has settled OK or Ignored, the end reaches next (see
 * {@link endTransition}). When the work's result will not commit (a work refused, or the end step did not commit:
 * refused, a fold or another state's answer failed, or a string form threw while it was logged), failed commits, the
 * queue drains, and then the work's signal aborts as failed, as on a timeout.
 * A result that settles once the signal aborted never commits, so its DisposableBoxes are disposed (see startWork).
 * A result after `p` ended (the timeout, a failure, disposeFlow) is dropped; one while an accepted abort waits is
 * left for the abort's entry; one after that entry is reported on the console, since no entry will show it.
 */
function onWorkSettled(p: PendingTransition, end: Step, work: WorkCall, result: Result): void {
  const { target, meta } = p.run;
  taps.size > 0 && tellTaps(meta, (tap) => tap.handled(target, "transition", work.call, result));

  // Settled once the work's signal aborted, the result never commits.
  if (p.controller.signal.aborted) {
    disposeCarried(meta, [], workResults([work]), prepareSnapshot(target, meta));
  }

  if (p.dropped) {
    console.error(
      `[SF/${meta.name}] transition handler ${work.handler.name} on ${work.call.name}: dropped after abort: ${String(result)}`,
    );
    return;
  }
  if (meta.pending !== p || p.aborting) {
    return;
  }
  if (result.in(ResultKind.Rejected, ResultKind.Error)) {
    meta.timers.clearTimeout(p.timer);
    // A tagged copy, so the refusal names its handler and its node; the handler's own result may be a shared constant.
    const failure = result.copy().withHandlerName(work.handler.name).withStateUpdating(`transition ${work.call.name}`);
    endTransition(p, end, failure);
    drainQueue(target, meta);
    p.controller.abort(transitionFailed(failure));
    return;
  }
  if (p.works.every((other) => other.result !== null)) {
    meta.timers.clearTimeout(p.timer);
    const { refused } = endTransition(p, end, null);
    drainQueue(target, meta);
    if (refused !== null) {
      p.controller.abort(transitionFailed(refused.refusal));
    }
  }
}

/** The reason the work's signal aborts with when `refusal` keeps the work's result from committing. */
function transitionFailed(refusal: Result): TransitionAborted {
  return new TransitionAborted(
    "failed",
    "SF034",
    `failed: ${refusal.message ?? refusal.error?.message ?? String(refusal)}`,
  );
}

/**
 * Ends `p` when its work outlasts its timeout: the node goes to its failed with an Error whose error is a
 * TransitionAborted of kind timeout, the queue drains, and then the work's signal aborts with that same reason, so
 * its listeners find the failed end committed. Every other end clears the timer, and an accepted abort takes it over
 * for its wait (see {@link abortTransition}), so this runs only while `p` is pending and not aborting.
 */
function onTimeout(p: PendingTransition, end: Step): void {
  const { declared } = p;
  const reason = new TransitionAborted(
    "timeout",
    "SF035",
    `${pathName(declared.node.path)} did not reach ${String(declared.next[VARIANT])} within ${declared.transition.timeoutMs} ms`,
  );
  endTransition(p, end, Verdict.error(reason), "timeout");
  drainQueue(p.run.target, p.run.meta);
  p.controller.abort(reason);
}

/**
 * Ends `p` in an entry of its own, marked final or failed, whose handler results begin with the work's: each work's
 * result, or "unsettled at failure" for one still unsettled when `failure` ends the transition before its whole work
 * settled: another work's refusal, or, with `cause` timeout, the timeout ("unsettled at timeout"). Without a failure
 * the end reaches next (see {@link reachNext}); a failure, or a refusal on the way to next, takes the node to its
 * failed (see {@link failEnd}), whose FAILURE data takes the timeout as its kind from `cause`. Resolves `p` with the
 * outcome. After an asynchronous end no caller is on the stack, so it never throws: a throw from the failed end's step
 * (a string form that throws while its changes are logged) becomes the outcome, and the waiters are released either
 * way. That throw stopped the failed end's commit, and nothing else is left to commit, so the declaring node keeps
 * temp, as the temp step committed it, even when its variant is transitional.
 *
 * @returns The outcome; and what kept next from committing, null when next committed or a failure ended the
 *   transition.
 */
function endTransition(
  p: PendingTransition,
  end: Step,
  failure: Result | null,
  cause: "timeout" | null = null,
): { outcome: Result; refused: Refused | null } {
  const run = {
    ...p.run,
    collector: new ResultCollector(p.run.meta.name, p.run.signal),
    works: p.works,
    committed: undefined,
  };
  run.meta.pending = null;
  run.collector.setTransition("final");
  for (const work of p.works) {
    run.collector.logHandler(
      work.call.name,
      "transition",
      work.handler.name,
      work.result ?? `unsettled at ${cause ?? "failure"}`,
    );
  }
  let outcome: Result;
  let refused: Refused | null = null;
  try {
    if (failure !== null) {
      // No end step ran, so the failed end takes nothing over: the work's signal aborts on that (see startWork).
      outcome = failEnd(run, p, end.from, { refusal: failure, named: [], planned: [] }, cause);
    } else {
      refused = reachNext(run, p, end);
      outcome = refused === null ? Verdict.ok() : failEnd(run, p, end.from, refused, null);
    }
  } catch (err) {
    outcome = Verdict.error(err);
  }
  if (p.works.length > 0) {
    // A work settles after the send that started it returned.
    run.collector.markAsync(p.startTime);
  }
  const result = finish(run, prepareSnapshot(run.target, run.meta), outcome);
  p.resolve(result);
  return { outcome: result, refused };
}

/**
 * Reaches next once the work succeeded, in `run`'s entry: the named results the work returned fold into the end's
 * target, in the order of the calls that returned them, the other states take them (see {@link answerResults}), and
 * the end step commits what that gives, so its handlers see the fold and the answers. The commit delegates the work's
 * results carry run first when it commits, in the order of the works. Returns null when next committed; otherwise what
 * kept it from committing: the fold's or an answer's failure, a DisposableBox rule the end's target breaks, the end
 * step's refusal, or a throw from the end step as an Error. Only the refused end step hands over what it carried, the
 * work's results and next's face as planned among it, to the failed end (see {@link runFailedStep}): after a failed
 * fold or answer, or a broken box rule, those are disposed as the work's signal aborts (see {@link startWork}), and an
 * end step that threw disposed what it carried already.
 */
function reachNext(run: DispatchRun, p: PendingTransition, end: Step): Refused | null {
  const named = workResults(p.works);
  const answered = answerResults(run.meta, end.from, fold(end.to, named, false), false, null);

  // The end puts next on the temp as it committed, which the plan saw only as planned: what the temp step folded or
  // answered may leave next holding a box the temp's commit disposed, or one box twice, also when nothing folds here.
  const failure =
    answered.failure ??
    (madeDisposableBoxes === 0 ? null : findFaceBoxError(answered.snapshot, "at the end of the transition"));
  if (failure !== null) {
    return { refusal: failure, named: [], planned: [] };
  }
  // A fold changes no variant and no nested state, so this step makes the calls `end` prepared, on the folded
  // instances, and those of the nodes the other states' answers change.
  const step = prepareStep(run.meta, end.from, answered.snapshot);

  // Every work settled OK or Ignored, so its result is the HandlerResult its handler returned (see transitionResult).
  const delegates = p.works.flatMap(({ call, handler, result }) =>
    (result as HandlerResult).delegates.map((delegate) => ({ call, handler, delegate })),
  );
  try {
    const stepped = runStep(run, step, { delegates, named, planned: [end.to] });
    return stepped.committed === null ? stepped : null;
  } catch (err) {
    // A string form that throws while the end step's changes are logged stops it before its commit, after its
    // handlers ran: next did not commit, as when a handler refuses.
    return { refusal: Verdict.error(err), named: [], planned: [] };
  }
}

/** The named results among the results `works` settled to, in their order, each with its work's call. */
function workResults(works: readonly WorkCall[]): NamedResult[] {
  return works.flatMap(({ call, result }) =>
    result instanceof HandlerResult && result.named !== null
      ? [{ call, name: result.named.name, data: result.named.data }]
      : [],
  );
}

/**
 * The failed end of `p`, written to `run`'s entry, marked failed: the declaring node goes from `from`, what committed
 * when the work started, to the failed its reducer declared, so a transitional temp never stays. The other answers
 * committed in the temp step and keep their next. The failed end is a failed step from what committed, after
 * `refused`, with `cause` timeout when the timeout ended the transition (see {@link runFailedStep}).
 */
function failEnd(
  run: DispatchRun,
  p: PendingTransition,
  from: FlowSnapshot,
  refused: Refused,
  cause: "timeout" | null,
): Result {
  run.collector.setTransition("failed");
  const { declared } = p;
  return runFailedStep(run, prepareStep(run.meta, from, endFace(from, declared, declared.failed)), refused, cause);
}

//#endregion

//#region Abort

/**
 * Aborts the pending transition `p` with `signal` (see {@link DispatchOptions}): every reducer the signal reaches
 * runs on the committed snapshot, and the abort is refused when they refuse, change nothing, or would leave a
 * transitional variant, and when another abort is in progress; the transition then continues. Accepted, the
 * work's signal aborts with a TransitionAborted of kind aborted, "aborted by <signal>", and the abort waits for the
 * work to settle, no longer than what is left of its timeout and not past a disposeFlow, then runs its own dispatch
 * (see {@link completeAbort}). Nothing else commits meanwhile, so the plan made now stays exact.
 */
function abortTransition(
  target: object,
  meta: StateFlowMeta,
  p: PendingTransition,
  signal: Signal,
  options: DispatchOptions,
): Result {
  const run = newRun(target, meta, signal, options, p);
  const committed = prepareSnapshot(target, meta);
  const path = pathName(p.declared.node.path);
  const name = signal[Symbol.toStringTag];
  if (p.aborting) {
    return finish(run, committed, Verdict.rejected("SF036", `an abort of ${path} is already in progress`));
  }
  const plan = prepareDispatch(meta, committed, signal, p.declared);
  if (plan instanceof Result) {
    let refusal: Result;
    if (plan.kind === ResultKind.Ignored) {
      refusal = Verdict.rejected("SF037", `${name} changes nothing; the transition continues`);
    } else if (plan.kind === ResultKind.Rejected) {
      // A refusal may carry no message (`StateResult.rejected("")`); the signal's name then says what was refused.
      refusal = Verdict.rejected("SF038", `${plan.message ?? `${name} was rejected`}; the transition continues`);
    } else {
      // An Error result always carries an Error: every way to build one goes through toError (result.ts). Its
      // message may be empty (`throw new Error()`), as a refusal's may.
      const error = plan.error as Error;
      refusal = Verdict.error(
        new StateFlowError("SF039", `${error.message || `${name} failed`}; the transition continues`, error),
      );
    }
    return finish(run, committed, refusal);
  }
  if (plan.reduction.declared === null && plan.first.changes.length === 0) {
    return finish(run, committed, Verdict.rejected("SF037", `${name} changes nothing; the transition continues`));
  }

  run.collector.setAborted(path);
  p.aborting = true;
  // From here the transition's timer ends this wait at the deadline instead of the transition: only that timer knows
  // what is left of the timeout on the flow's timers. Swapped before abort() runs the work's listeners, so a timer
  // that fires in one of them ends the wait, not the transition.
  const deadline = new Promise<void>((resolve) => {
    p.expire = resolve;
  });
  // abort() runs the work's abort listeners inside the call. A send they make queues behind the abort, a second
  // abort meets `aborting`, and a disposeFlow ends the transition with no step.
  p.controller.abort(new TransitionAborted("aborted", "SF040", `aborted by ${name}`));

  // `p.promise` resolves during the wait only through disposeFlow (the work's result is dropped while aborting), and
  // then the work no longer matters.
  const outcome = Promise.race([p.settled, deadline, p.promise]).then(() => {
    // When the work won, the timer would otherwise keep the event loop or a simulated clock busy until the deadline.
    meta.timers.clearTimeout(p.timer);
    return completeAbort(p, plan, run);
  });
  return Verdict.pending(outcome).withSignal(signal);
}

/**
 * Completes an accepted abort once the work settled or its deadline passed: `p` ends Rejected "aborted by
 * <signal>", the abort's entry lists every work as dropped, with what it settled to or as unsettled, and the
 * abort's own dispatch runs its plan: a step, or a new transition its reducers declared. When disposeFlow ran during
 * the wait, no step runs.
 *
 * @returns The abort's result: its step's, or the end of the transition it declared.
 */
function completeAbort(p: PendingTransition, plan: Plan, run: DispatchRun): Result | Promise<Result> {
  const { target, meta } = run;
  if (meta.pending !== p) {
    // disposeFlow ran during the wait: the target is torn down, so no step runs.
    return finish(
      run,
      plan.C,
      Verdict.error(new StateFlowError("SF041", `flow disposed during the abort of ${pathName(p.declared.node.path)}`)),
    );
  }
  meta.pending = null;
  p.resolve(Verdict.rejected("SF040", `aborted by ${run.signal[Symbol.toStringTag]}`).withSignal(p.run.signal));
  for (const work of p.works) {
    run.collector.logHandler(
      work.call.name,
      "transition",
      work.handler.name,
      `dropped after abort: ${work.result ?? "unsettled"}`,
    );
  }
  p.dropped = true;
  run.works = p.works;
  let outcome: Result | Promise<Result>;
  try {
    const declared = plan.reduction.declared;
    outcome = (declared !== null ? startTransition(run, plan, declared) : runOk(run, plan)).done();
  } catch (err) {
    // The step threw before its commit (a string form that throws while its changes are logged); no caller is on
    // the stack to take it.
    outcome = Verdict.error(err).withSignal(run.signal);
  }
  // Does nothing while a transition the abort's reducers declared is pending; that transition's end drains.
  drainQueue(target, meta);
  return outcome;
}

//#endregion

/** Queues the lock holder's send behind the pending transition; it is reduced after the end, in order. */
function queueBehindTransition(meta: StateFlowMeta, signal: Signal, options: DispatchOptions): Result {
  const { promise, resolve } = deferred<Result>();
  meta.queue.push({ signal, options, settle: resolve });
  return Verdict.pending(promise).withSignal(signal);
}

/**
 * Reduces the queued sends in order until the queue is empty or one of them leaves a transition pending,
 * whose end drains the rest. Runs with no caller on the stack, so a send whose dispatch throws settles
 * with the Error and the loop goes on.
 */
function drainQueue(target: object, meta: StateFlowMeta): void {
  while (meta.pending == null) {
    const queued = meta.queue.shift();
    if (queued == null) {
      return;
    }
    try {
      // done() is the result itself, or the end of a transition the send declared.
      queued.settle(dispatchNow(target, meta, queued.signal, queued.options).done());
    } catch (err) {
      queued.settle(Verdict.error(err).withSignal(queued.signal));
    }
  }
}

/**
 * Finishes `collector`'s entry with `result` and delivers it: buffered under a labeled lock (its dispose
 * flushes the group), otherwise after the finish resolves. A muted dispatch writes none.
 */
function finishEntry(
  meta: StateFlowMeta,
  collector: ResultCollector,
  snapshot: FlowSnapshot,
  result: Result,
  mute: boolean,
): void {
  if (mute) {
    return;
  }
  const finished = collector.finish(snapshot, result);
  const group = meta.logGroup;
  if (group != null) {
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

/**
 * Commits a step's `changes`, each with what committed at its node (top-level states and nested nodes, in pre-order,
 * the states in the flow's order): sets every top-level state among them on the target, then tells each node to the
 * observers of its new variant, and hands each to the subscribers. Nothing told can break the commit: every state is
 * set before any observer runs, and an observer's or a subscriber's throw is caught where it is called (see subscribe
 * and emitFlowChanges).
 */
function applyState(target: object, meta: StateFlowMeta, changes: StateChange[], rc: ResultCollector): void {
  for (const { path, next } of changes) {
    if (path.positions.length === 0) {
      Reflect.set(target, path.state, next);
      meta.reducers.delete(path.state);
    }
  }

  // A node the step removed has no variant to tell.
  for (const { stateName, old, next } of changes) {
    if (next !== undefined) {
      meta.emitter.emit(observeKey(next[VARIANT]), old, next, rc, stateName);
    }
  }

  if (meta.watchers.length > 0) {
    notifyWatchers(target, meta, changes, rc);
  }

  // A flow with no subscribers builds no FlowChange.
  if (meta.flowSubscribers.size > 0) {
    emitFlowChanges(
      meta,
      changes.map((change) => buildFlowChange(meta, change, rc)),
    );
  }
}

/**
 * Tells the flow's events and watches of a commit: each decides on the committed states and the states it saw at the
 * commit before. The entry records one that fires under observers, named by the top-level states the commit changed,
 * and it acts on a later turn of the flow's timers, in registration order. A throw from a predicate is the
 * entry's observer error, a throw from an act goes to console.error: neither can break the commit.
 */
function notifyWatchers(target: object, meta: StateFlowMeta, changes: StateChange[], rc: ResultCollector): void {
  const cur = prepareSnapshot(target, meta);
  const changed = [...new Set(changes.map((change) => change.path.state))].join(",");
  for (const watcher of meta.watchers) {
    const prev = watcher.prev;
    watcher.prev = cur;
    let fires: boolean;
    try {
      fires = watcher.changed(cur, prev);
    } catch (err) {
      rc.logObserver(changed, watcher.name, false, Verdict.error(err));
      console.error(`[SF/${meta.name}] the predicate of ${watcher.name} threw:`, err);
      continue;
    }
    if (fires) {
      rc.logObserver(changed, watcher.name, true);
      meta.deliveries += 1;
      meta.timers.setTimeout(() => {
        meta.deliveries -= 1;

        try {
          watcher.act(cur, prev);
        } catch (err) {
          console.error(`[SF/${meta.name}] ${watcher.name} threw:`, err);
        }
      }, 0);
    }
  }
}

/**
 * Watches the flow: after every commit `changed(cur, prev)` runs on the committed states and on the states as of the
 * commit before (the states of now the first time), and when it returns true `callback(cur, prev)` runs on a later
 * turn of the flow's timers. The commit's entry records a watch that fires under observers as `watch:<callback name>`.
 * Unlike an event (see StateManager.defineEvent) a watch is attached and released at any time: dispose the returned
 * Disposer to stop it. The callback runs only while the watch is registered, so once the Disposer or disposeFlow
 * removed it, a callback that an earlier commit set does not run. A throw from `changed` is the entry's observer
 * error, a throw from `callback` goes to console.error; neither can break the commit.
 *
 * @param target - Object initialized with {@link applyFlow}
 * @param changed - Decides on the states after the commit and as of the commit before
 * @param callback - Runs with the same two snapshots when `changed` returned true
 * @returns Disposer that stops the watch
 * @throws StateFlowError when the target is no flow, or its flow is disposed
 *
 * @example
 * ```ts
 * using w = watch(player, (cur, prev) => cur.driver.current !== prev.driver.current, (cur) => track(cur.driver));
 * ```
 */
export function watch<T extends object>(
  target: T,
  changed: ChangePredicate<T>,
  callback: (cur: T, prev: T) => void,
): Disposer {
  const meta = stateMeta(target);
  const watcher: Watcher = {
    name: `watch:${buildName(undefined, callback)}`,
    changed: changed as ChangePredicate<FlowSnapshot>,
    // A timer turn after the commit, the callback runs only if the watch is still registered: the disposer below and
    // disposeFlow take it off.
    act: (cur, prev) => {
      if (meta.watchers.includes(watcher)) {
        callback(cur as T, prev as T);
      }
    },
    prev: prepareSnapshot(target, meta),
  };
  meta.watchers.push(watcher);
  return {
    [Symbol.dispose]: () => {
      const at = meta.watchers.indexOf(watcher);
      if (at >= 0) {
        meta.watchers.splice(at, 1);
      }
    },
  };
}

/**
 * Builds one observation-only change record of a node from its instances before and after the commit, with the signal
 * and the `dispatchOrder` of the entry that `rc` writes for the committing step. A nested node's record has its path.
 */
function buildFlowChange(
  meta: StateFlowMeta,
  { path, stateName, old, next }: StateChange,
  rc: ResultCollector,
): FlowChange {
  // diffNode records a node only where its two sides differ, so one of them is an instance.
  const node = (next ?? old) as StateInstance;
  return {
    flowName: meta.name,
    stateName: String(node[VARIANT][DEF]),
    // A top-level state's change keeps the shape it had before nested nodes had changes of their own. The step's
    // stateName is the node's path as the log names it.
    ...(path.positions.length > 0 ? { path: stateName } : {}),
    prevVariant: old?.[VARIANT][Symbol.toStringTag] ?? "(none)",
    nextVariant: next?.[VARIANT][Symbol.toStringTag] ?? "(none)",
    prev: old,
    next,
    signal: rc.signal,
    dispatchOrder: rc.dispatchOrder,
  };
}

/**
 * Delivers each change to every current subscriber on its own turn of the flow's timers, after the commit.
 * Subscribers are observation-only: a subscriber's throw is reported with console.error and affects neither the
 * dispatch nor the other subscribers, and delivery is re-checked against the live set so a subscriber disposed after
 * scheduling stops receiving.
 */
function emitFlowChanges(meta: StateFlowMeta, changes: FlowChange[]): void {
  const subscribers = [...meta.flowSubscribers];
  for (const change of changes) {
    for (const subscriber of subscribers) {
      meta.deliveries += 1;
      meta.timers.setTimeout(() => {
        meta.deliveries -= 1;

        if (!meta.flowSubscribers.has(subscriber)) {
          return;
        }
        try {
          subscriber(change);
        } catch (err) {
          console.error(`[SF/${meta.name}] subscriber ${buildName(undefined, subscriber)} threw:`, err);
        }
      }, 0);
    }
  }
}

/**
 * Waits until no declared transition is pending on the target.
 *
 * @param target - Object containing states that may be transitioning
 * @returns Promise that resolves when no transition is pending; an abort or a queued send can start a new
 *   transition when one ends, and sync() waits for that one too
 * @throws StateFlowError if target object is not initialized with applyFlow, or its flow is disposed
 *
 * @example
 * ```ts
 * // Wait for a pending transition to end, then read the state it reached.
 * await sync(player);
 * console.log(String(player.driver));
 * ```
 */
export async function sync(target: object): Promise<void> {
  const meta = stateMeta(target);
  while (meta.pending != null) {
    await meta.pending.promise;
  }
}

/**
 * Waits until the flow has nothing left to deliver: every delivery set on the flow's timers has run (the callbacks of
 * observers, events and watches, and the changes of subscribers), and so has every delivery that a commit they made in
 * turn set. The locks they ask for are served before it resolves: lock() claims its place in the lock's queue
 * synchronously, inside the call, so once the deliveries ran, a lock that settled takes queues behind every lock they
 * asked for, and settled releases it at once. That lock, like every lock, also waits for a pending declared transition
 * to end (see sync), so settled waits for it too. A lock that a delivery asks for only after an await of its own may
 * come later and is not waited for. On a disposed flow it waits for the deliveries set before disposeFlow, whose
 * observers' and watches' callbacks are dropped since disposeFlow removed them, and takes no lock, since a disposed
 * flow hands none. With nothing to deliver, the lock free and no transition pending, it resolves without waiting for a
 * timer. Awaited by a caller that holds the target's lock, it never resolves, since its own lock() waits for that one.
 *
 * @param target - Object initialized with {@link applyFlow}, its flow disposed or not
 * @returns Promise that resolves once no delivery is left, the locks asked for before were served, and a pending
 *   declared transition ended
 * @throws StateFlowError (the promise rejects) when the target is no flow, or when disposeFlow runs while settled
 *   waits for the lock, behind its holder or for the transition the lock waits for
 *
 * @example
 * ```ts
 * disposeFlow(player);
 * await settled(player); // the events of the last commits have fired
 * ```
 */
export async function settled(target: object): Promise<void> {
  // stateMeta refuses a disposed flow, which settled waits on too: it is called only for a target never applied.
  const meta = managementStateMap.get(target) ?? stateMeta(target);

  do {
    // Each turn of the flow's timers runs deliveries, and one that commits sets more, so the count is read again.
    while (meta.deliveries > 0) {
      await new Promise<void>((resolve) => meta.timers.setTimeout(resolve, 0));
    }

    if (meta.disposed) {
      return;
    }

    // Taken and released at once: it comes after every lock the deliveries asked for, whose sends may set more.
    const send = await lock(target);
    await send[Symbol.asyncDispose]();

    // disposeFlow ran while the lock was awaited, behind its holder or for a transition: settled rejects (see @throws).
    if (meta.disposed) {
      throw disposedError(meta);
    }
  } while (meta.deliveries > 0);
}

/**
 * Creates an observer that watches for changes into specific state variants, of the target's top-level states or of
 * the nested states they hold, at any depth. Disposing the returned Disposer removes the observer, as disposeFlow
 * does; its callback runs only while it is registered, so a callback that an earlier commit set does not run then.
 *
 * Every node of a variant's state that a commit changes into the variant tells the observer, top-level or nested, as
 * many as changed (each element of an Items, say): a state held both at the top level and nested tells it of each,
 * told apart by the path. The compare gets the node's instances before and after the change; a nested node that held
 * no instance of its state before, at a position that was empty or held another state, has nothing to compare, and
 * the callback runs. The callback gets the committed instance and the node's path, as the log names it: `media`,
 * `media.producers[cam]`.
 *
 * A variant of a state outside the target's flow would never fire, and the call does not compile: the target's type
 * must have a prop under each variant's state name, of that state's props, or hold that state's instances below its
 * top-level props (see {@link TargetOf}). The types find a nested state by its name in anything the props hold, so a
 * variant of a state that only an object outside the flow holds (a cache, another flow's target), or of another
 * definition with a nested state's name, compiles too, and its observer never fires. The types cannot search `this`,
 * or a target typed by a type parameter, for nested states, so a nested state's variant does not compile with them:
 * pass the target typed as the class, `this as Player`. At run time a nested state that no node holds yet cannot be
 * told from a state outside the flow: a call the types let through, as a target or a variant typed `any` does,
 * registers an observer that may never fire.
 *
 * The observer is told of each change after the commit set every state; a throw from its compare or its callback is
 * reported with console.error and cannot break the commit, and a throw from the compare is its result in the entry.
 *
 * @param target - Object containing the states to observe
 * @param stateVariants - Array of variants, of the target's top-level states or of nested states, to watch for changes
 * @param handlerFn - Callback function executed when observed states change, with the instance and its node's path
 * @param compareFn - Optional function to determine if states are different
 * @param ctx - Optional object whose name, joined with handlerFn's, names the observer in log entries
 * @returns Disposer object that cleans up the observer when disposed
 * @throws StateFlowError when the target is no flow, or its flow is disposed
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
export function observe<V extends AnyVariant, T extends TargetOf<V, T>>(
  target: T,
  stateVariants: ReadonlyArray<V>,
  handlerFn: ObserverHandler<InstanceOfVariant<V>>,
  compareFn: ObserverComparerFn<InstanceOfVariant<V>> = (a, b) => a !== b,
  ctx?: object,
): Disposer {
  const meta = stateMeta(target);
  const listeners = stateVariants.map((stateVar) => ({
    key: observeKey(stateVar),
    listener: subscribe(meta, stateVar, compareFn, handlerFn, ctx),
  }));

  return {
    [Symbol.dispose]: () => {
      for (const { key, listener } of listeners) {
        meta.emitter.off(key, listener);
      }
    },
  };
}

/**
 * Subscribes to committed state changes of a flow, observation-only.
 *
 * Unlike {@link observe}, a `subscribeFlow` subscriber cannot influence the flow at all: it
 * receives a plain {@link FlowChange} value (with the real, frozen `prev`/`next` state instances)
 * and has no handle to dispatch or mutate flow state. It runs strictly AFTER the state
 * has committed, each change on its own turn of the flow's timers (see {@link FlowConfig}), so nothing it does can
 * reorder or block the dispatch. A throwing subscriber is isolated — it never affects the dispatch or other
 * subscribers.
 *
 * One {@link FlowChange} is delivered per node that changed in a commit: each top-level state that changed, and each
 * nested node inside it that changed, at any depth, with its path, in pre-order. With no subscribers registered,
 * dispatch is entirely unaffected and pays nothing.
 *
 * @param target - Object initialized with {@link applyFlow}
 * @param subscriber - Observation-only callback invoked once per changed node, post-commit
 * @returns A {@link Disposer} — dispose it (e.g. via `using`) to stop delivery
 * @throws StateFlowError if `target` was not initialized with {@link applyFlow}, or its flow is disposed
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

/**
 * Registers the observer of `stateVar` that observe() makes of `cmpFn` and `hdlFn`, and returns its listener, for the
 * observer's disposer to remove. applyState calls it with each node that changed into the variant, after the commit
 * set every state. Its compare runs then, unless the node held no instance of the state before, and its result goes
 * to the change's entry under the node's path; when it asks for the callback, or did not run, the callback runs on a
 * later turn of the flow's timers, if the listener is still on the emitter then. A throw from either is reported with
 * console.error, and a throw from the compare is its result in the entry: an observer cannot break the commit that
 * tells it.
 */
function subscribe<TState>(
  meta: StateFlowMeta,
  stateVar: StateVariant,
  cmpFn: ObserverComparerFn<TState>,
  hdlFn: ObserverHandler<TState>,
  ctx?: object,
): ObserverListener<TState> {
  // Named here, so a context whose name cannot be read throws from observe() and not inside a commit.
  const name = buildName(ctx, hdlFn);
  const key = observeKey(stateVar);
  const listener: ObserverListener<TState> = (a, b, rc, path) => {
    let needObserve: boolean;
    try {
      // A nested node whose position was empty, or held another state, has no instance of this state to compare, and
      // its callback runs; `a` is otherwise an instance of the observed variant's state, as TState is.
      needObserve = a?.[VARIANT][DEF] !== stateVar[DEF] || cmpFn(a as TState, b);
    } catch (err) {
      rc.logObserver(path, name, false, Verdict.error(err));
      console.error(`[SF/${meta.name}] the compare of observer ${name} on ${String(stateVar)} threw:`, err);
      return;
    }
    if (needObserve) {
      rc.logObserver(path, name, true);
      meta.deliveries += 1;
      meta.timers.setTimeout(() => {
        meta.deliveries -= 1;

        // Only while the observer is registered: its disposer and disposeFlow take the listener off the emitter.
        if (!meta.emitter.listeners(key).includes(listener)) {
          return;
        }
        try {
          hdlFn(b, path);
        } catch (err) {
          console.error(`[SF/${meta.name}] observer ${name} on ${String(stateVar)} threw:`, err);
        }
      }, 0);
    }
  };
  meta.emitter.on(key, listener);
  return listener;
}

/**
 * Tears a flow down: removes its handlers, observers, events and watches and its state properties, then disposes every
 * DisposableBox the final states hold (see DisposableBox). A pending declared transition ends with no further commit:
 * its `done()` resolves to an Error, and so do the `done()` of an abort waiting for its work, at once, and every send
 * queued behind it. Its work's signal aborts last, with a TransitionAborted of kind disposed, "flow disposed", once the
 * teardown is done, and the DisposableBoxes of its next as planned and of the work's results are disposed then, or as
 * those results settle (see startWork). No exit handler runs; the signal is the work's only notice to release what it
 * holds. From then on every send answers Rejected "<name> is disposed", whatever its lock, one taken before included,
 * and every lock() still waiting, or called afterwards, resolves to such a sender (see lock). Every other call on the
 * target afterwards throws a StateFlowError "<name> is disposed", except settled (below) and disposeFlow: a second call
 * does nothing, so a listener of the work's signal may dispose its own target. The deliveries set before it still run,
 * but the callback of an observer or a watch among them is dropped, as it is no longer registered; an event's and a
 * subscriber's arrive (see settled).
 *
 * @param target - Object initialized with {@link applyFlow}
 * @throws StateFlowError inside a reducer, or inside this target's own dispatch (a handler of its step);
 *   dispose it after the dispatch returns. Also when the target was never applied
 */
export function disposeFlow(target: object): void {
  if (isInReducer()) {
    throw new StateFlowError("SF042", "Cannot dispose a flow from inside a reducer");
  }
  if (managementStateMap.get(target)?.disposed) {
    return;
  }
  const meta = stateMeta(target);
  if (meta.inStep) {
    throw new StateFlowError("SF043", `Cannot dispose ${meta.name} from inside its own dispatch`);
  }
  const p = meta.pending;
  if (p != null) {
    meta.timers.clearTimeout(p.timer);
    meta.pending = null;
    p.resolve(
      Verdict.error(
        new StateFlowError(
          "SF044",
          `flow disposed during the transition of ${pathName(p.declared.node.path)} to ${String(p.declared.next[VARIANT])}`,
        ),
      ),
    );
  }
  for (const queued of meta.queue.splice(0)) {
    queued.settle(
      Verdict.error(
        new StateFlowError("SF045", `flow disposed before ${queued.signal[Symbol.toStringTag]} was reduced`),
      ),
    );
  }
  // A lock() still waiting its turn would wait forever once the holder has nothing to hand over: end its wait now. It
  // resumes once `disposed` is set below, and answers with a sender that holds nothing (see lock).
  for (const waiter of meta.lockQueue.splice(0)) {
    waiter.resolve();
  }
  meta.handlers.clear();
  meta.reducers.clear();
  meta.emitter.removeAllListeners();
  meta.watchers.splice(0);
  const final = prepareSnapshot(target, meta);
  for (const state of meta.states) {
    Reflect.deleteProperty(target, state[Symbol.toStringTag]);
  }
  meta.disposed = true;

  // A dispose that calls the flow finds it disposed. No state stays, so every DisposableBox the final states hold goes.
  disposeCarried(meta, [final], [], {});

  // Last: abort() runs the work's listeners inside the call, and a listener that disposes the target again
  // must find it disposed. During an abort's wait the signal has aborted already and keeps its first reason.
  p?.controller.abort(new TransitionAborted("disposed", "SF046", "flow disposed"));
}
