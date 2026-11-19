/**
 * Handlers: the callbacks a flow registers on variants to act on the world, which callbacks run for a variant
 * and a kind at a given moment, and what their returns mean. A target keeps its registrations in a registry
 * keyed by the variant object, so a variant of a nested state is registered like a top-level one, and two
 * definitions that share a name never share handlers.
 */
import { HandlerResult, type Result, Verdict } from "./result";
import type { AnyVariant, AsyncVariant, FlowSnapshot, InstanceOfVariant, StateVariant, VariantId } from "./state";
import { IS_ASYNC } from "./symbols";
import { buildName, isThenable, StateFlowError } from "./utils";

/**
 * An enter handler of the variant `V`. `state` is the instance entered, as its reducer declared it, `snapshot` the
 * frozen snapshot of every top-level state the step prepared, `prev` the instance the node had before (undefined
 * for a nested state entering a new position, or one another definition held), `key` a nested state's key in its
 * parent's Items (undefined at the top level and for a single nested state), and `signal` the step's AbortSignal.
 * Besides the four plain results it may return a named result of `V` (`V.results.<name>(data)`): after the enter phase
 * the variant's result reducer folds its data into the entered instance, which is what commits, and every other state
 * with a result reducer of that name takes it in the same step (see defineFlow). It is synchronous: a returned promise
 * is an Error that refuses the step; an entry that waits for the world is a transition handler's.
 *
 * Every enter and update handler of a step, a further round's too (see {@link StateManager}), gets the step's signal.
 * It aborts when the step does not commit, whatever kept it from committing: a handler refused or threw, a named result
 * did not fold, another state's answer to it failed, the named results broke a DisposableBox rule, or a throw stopped
 * the step before its commit. Nothing undoes what the handler did, and a handle it returned in a named result is in no
 * state, so on the abort the handler releases what it made in that call; a DisposableBox the named result carries the
 * engine disposes instead, after the step into failed that follows, unless the states committed then hold it (see
 * DisposableBox). Once the step commits, the signal never aborts, also in a step into failed, which commits whatever
 * its handlers return. It aborts as the step ends, inside the dispatch, so its listeners, like the handler, must not
 * dispatch to or dispose their own target synchronously: that throws.
 *
 * It runs in every step that enters `V` at its node, so one dispatch may call it twice for one instance: in a refused
 * step, whose signal aborts, and again in the step into failed after it, when the failed holds that instance at that
 * node (see StateResult.ok), or in a declared transition's refused end and again in its failed end.
 */
export type EnterHandler<V> = (
  state: InstanceOfVariant<V>,
  snapshot: FlowSnapshot,
  prev: InstanceOfVariant<V> | undefined,
  key: unknown,
  signal: AbortSignal,
) => HandlerResult<VariantId<V>>;

/**
 * An exit handler of the variant `V`: `state` is the instance left, `snapshot` the frozen snapshot of the step, `prev`
 * the same instance as `state`, and `key` a nested state's key in its parent's Items (undefined at the top level and
 * for a single nested state). It returns one of the four plain results: the node it leaves holds no instance of `V`
 * once the step commits, so there is none to fold a named result of `V` into, and a named result from here is an Error.
 * Unlike an enter or update handler, it gets no signal (see {@link EnterHandler}): an exit releases, and makes nothing
 * to release when its step does not commit.
 *
 * It runs in every step that leaves `V` at its node, a refused step included, so one dispatch may call it twice for
 * one instance: in a refused step and again in the failed step after it (see StateResult.ok), or in a declared
 * transition's refused end and again in its failed end, whenever the later step leaves that instance too. What it does
 * at once must bear a second call; a release that must happen once waits for the commit in a commit delegate (see
 * HandlerResult.onCommit), or is left to the engine through a DisposableBox the state holds (see DisposableBox).
 */
export type StateHandler<V> = (
  state: InstanceOfVariant<V>,
  snapshot: FlowSnapshot,
  prev: InstanceOfVariant<V>,
  key: unknown,
) => HandlerResult;

/**
 * An update handler of the variant `V`: `state` is the new instance, as its reducer declared it, `snapshot` the frozen
 * snapshot of the step, `prev` the instance the node had before, `key` a nested state's key in its parent's Items
 * (undefined at the top level and for a single nested state), and `signal` the step's AbortSignal, which aborts when
 * the step does not commit, as an enter handler's does (see {@link EnterHandler}). Besides the four plain results it
 * may return a named result of `V` (`V.results.<name>(data)`): after the enter phase, before the enter handlers'
 * results, the variant's result reducer folds its data into the new instance, which is what commits, and every other
 * state with a result reducer of that name takes it in the same step (see defineFlow). Like an enter handler, it may
 * run twice in one dispatch for one instance, in a refused step and in the step into failed after it.
 */
export type UpdateHandler<V> = (
  state: InstanceOfVariant<V>,
  snapshot: FlowSnapshot,
  prev: InstanceOfVariant<V>,
  key: unknown,
  signal: AbortSignal,
) => HandlerResult<VariantId<V>>;

/**
 * A transition handler of the asynchronous variant `V`: the asynchronous part of an entry into `V` that a reducer
 * declared with `StateResult.transition`. `next` is the instance entered, as its reducer declared it, `snapshot` the
 * frozen snapshot the transition's end prepared, before any named result folds, `prev` the instance the node holds
 * while the work runs, and `key` a nested state's key in its parent's Items.
 *
 * `signal` aborts when the work's result will not commit, and its reason is a TransitionAborted whose kind says why:
 * `aborted`, an abort of the transition was accepted ("aborted by <signal>"); `timeout`, the work outlasted its
 * timeout, and the failed end has run; `disposed`, disposeFlow ran; `failed`, a handler of the work refused or failed,
 * or every handler succeeded and the end step did not commit (a handler refused it, a result reducer failed, a
 * DisposableBox rule broke, or a string form threw while it was logged), and the failed end has run. On every kind the
 * handler releases what it acquired, but for a DisposableBox its named result carries: the engine disposes that one by
 * the time the signal aborts, or as a later result settles, unless the committed states hold it (see DisposableBox).
 * Pass the signal on to what can be cancelled, listen for its abort on what cannot, and call `signal.throwIfAborted()`
 * after each await: once the signal has aborted, the engine drops whatever the handler returns or throws.
 *
 * It returns a promise of one of the four plain results or of a named result of `V`, which folds into `next`
 * before the transition's end step, so the end's enter handlers already see it; every other state with a result
 * reducer of that name takes it in the end step too (see defineFlow). A Rejected or an Error ends the transition at
 * once, in its failed. A throw, or a return that is no promise, is an Error. The commit delegates the result carries
 * run when the end step commits, before those of the end step's own handlers; an end that does not commit drops them
 * (see HandlerResult.onCommit).
 */
export type TransitionHandler<V> = (
  next: InstanceOfVariant<V>,
  snapshot: FlowSnapshot,
  prev: InstanceOfVariant<V> | undefined,
  key: unknown,
  signal: AbortSignal,
) => Promise<HandlerResult<VariantId<V>>>;

/**
 * A commit handler of the variant `V`: `state` is the instance entered as it committed, with the named results
 * folded in, `snapshot` the frozen snapshot the step committed, `prev` the instance the node had before
 * (undefined as for an enter handler), and `key` a nested state's key in its parent's Items (undefined at the
 * top level and for a single nested state). It runs right after the commit and cannot fail the dispatch: its
 * return value is ignored, a throw is logged as its handler result, and a returned promise is not awaited; if
 * that promise rejects, the rejection is reported with console.error.
 */
export type CommitHandler<V> = (
  state: InstanceOfVariant<V>,
  snapshot: FlowSnapshot,
  prev: InstanceOfVariant<V> | undefined,
  key: unknown,
) => void;

/** What an event or a watch decides on: the flow's committed states after a commit (`cur`) and as of the commit before it (`prev`). */
export type ChangePredicate<TStates> = (cur: TStates, prev: TStates) => boolean;

/** Registers an event of the flow; the flow builds it, so the manager needs no view of the target. */
export type EventRegistrar = (
  name: string,
  changed: ChangePredicate<FlowSnapshot>,
  payload: ((cur: FlowSnapshot) => unknown) | undefined,
) => void;

/**
 * Registers a flow's handlers; applyFlow passes it to its initializer. It is typed by the flow's states as `cur` and
 * `prev` of its events; the default fits any flow, so a callback annotated `(sm: StateManager) => void` fits every
 * applyFlow. A handler is registered on a variant of a top-level or a nested state, and runs for every node of the
 * target's tree that a step enters, leaves or updates in that variant, called as
 * `cb.call(context, state, snapshot, prev, key)` (see {@link EnterHandler}, {@link StateHandler} and
 * {@link UpdateHandler}); an enter or update handler also gets the step's AbortSignal, and a transition handler gets
 * the transition's and returns a promise (see {@link TransitionHandler}).
 *
 * In a step, exit handlers run first, then update, then enter, all before the commit. Inside each top-level
 * state's tree, nodes exit children first and later siblings first, and update or enter parents first; the
 * states take their turns in the flow's order, and one variant's handlers run in registration order. So when a
 * node changes variant while a nested state it keeps gets a new instance, that update runs after the node's
 * exit and before its enter. A node that changes only because a nested state in it changed gets no call of its
 * own.
 *
 * When other states take a named result that an update or enter handler returned, a further round of the same step
 * runs the handlers of the nodes their answers change, again exits, then updates, then enters, before the commit.
 *
 * After the commit, the commit delegates that the step's exit, update and enter handlers attached to their results run
 * in the order of those calls, at a declared transition's end after those its transition handlers attached (see
 * HandlerResult.onCommit), then the commit handlers on the variants that were entered, in the order of the enter calls.
 *
 * An exit, update or enter handler's Rejected or throw refuses the dispatch, as a reducer's does: nothing commits, the
 * dispatch's result is that failure (a throw becomes an Error), and the handler's result in the log entry carries it.
 * The other handlers of its phase still run, and when several fail, their failures merge in the order the handlers were
 * called, as above (see Result.merge): the first Rejected, or an Error over any Rejected. The later phases, the commit
 * and the commit handlers do not run. When a reducer declared a failed (`StateResult.ok(next, failed)`), the failed
 * step follows in the same dispatch, from the instances before the signal, and its own handlers cannot stop its commit:
 * their refusals join the dispatch's result as an Error. It calls the handlers of the nodes it changes as any step
 * does, so an exit the refused step made runs again where the failed step leaves the same instance (see
 * {@link StateHandler}), and an enter or update runs again where the failed holds, at a position, the instance the
 * refused step entered or updated there (see {@link EnterHandler}). Nothing undoes what the handlers that ran did: a
 * node the failed step keeps as the same instance gets no call, even one the refused step exited. The refused step's
 * enter and update handlers learn of the refusal from their AbortSignal, which aborts, and release what they made (see
 * {@link EnterHandler}); a release of what the step replaces waits for the commit in a commit delegate, which a refused
 * step drops. A commit handler cannot refuse (see {@link CommitHandler}).
 *
 * A transition declared by a reducer (`StateResult.transition`) runs the transition handlers of every asynchronous
 * variant its end enters as its work, after its temp step committed and before its end step (see
 * {@link TransitionHandler}).
 *
 * Every adder registers, whether {@link setHandlersDisabled} is on or not: the switch decides at each call, and
 * a mock (see {@link mockHandlers}) replaces the handlers of its variant and kind while it lasts.
 *
 * Each adder types `cb` by `variant` alone, so a callback, a class method without a return annotation included,
 * cannot widen the variant to fit what it returns. The callback's types are computed from the variant by
 * conditional types (InstanceOfVariant, VariantId), which give the compiler nothing to infer the variant from;
 * NoInfer on `cb` says so in the signature, so it stays true if those types change.
 */
export interface StateManager<TStates = any> {
  /**
   * Defines a public event of the flow, emitted through the target's own `emit(name, payload?)`. After every commit
   * `changed(cur, prev)` runs on the committed states and on the states as of the previous commit (the initial
   * instances the first time); when it returns true the event is emitted on a later turn of the flow's timers, with
   * `payload(cur)` when given. An event that fires is in the commit's entry under `observers`, named `event:<name>`,
   * with `stateName` listing the top-level states the commit changed; a throw from `changed` is the entry's observer
   * error and emits nothing; a throw from `payload` or from a listener goes to console.error. Nothing an event does
   * can break the commit.
   * @throws StateFlowError when the target has no `emit` method
   */
  defineEvent(name: string, changed: ChangePredicate<TStates>, payload?: (cur: TStates) => unknown): void;

  /** `cb` runs when a dispatch enters `variant`: from another variant of its state (`prev` is the instance it
   * replaces), or, for a nested state, at a position that held none or held another definition (`prev`
   * undefined). */
  addEnterHandler<V extends AnyVariant>(variant: V, cb: NoInfer<EnterHandler<V>>, context?: unknown): void;

  /** `cb` runs when a dispatch leaves `variant`: for another variant of its state, or, for a nested state, when
   * its position empties or another definition takes it (its parent left, or dropped it). Both `state` and
   * `prev` are the instance it leaves. It runs in every step that leaves it, a refused one included (see
   * {@link StateHandler}). */
  addExitHandler<V extends AnyVariant>(variant: V, cb: NoInfer<StateHandler<V>>, context?: unknown): void;

  /** `cb` runs when a reducer gives `variant` a new instance of the same variant, at the top level or at a nested
   * state's position (a reducer that returns the current instance runs nothing, and neither does a node that changed
   * only because a nested state in it changed); `prev` is the instance it replaces. */
  addUpdateHandler<V extends AnyVariant>(variant: V, cb: NoInfer<UpdateHandler<V>>, context?: unknown): void;

  /** `cb` runs as part of the work of a declared transition whose end enters `variant`, a variant declared with
   * `{ async: true }` (see {@link TransitionHandler}).
   * @throws StateFlowError when `variant` is not asynchronous: the type refuses one too, unless it is cast. */
  addTransitionHandler<V extends AsyncVariant>(variant: V, cb: NoInfer<TransitionHandler<V>>, context?: unknown): void;

  /** `cb` runs right after a dispatch commits, inside the dispatch, wherever an enter handler of `variant`
   * runs, nested states included (with their key), and on a declared transition's temp, before the work
   * starts. It is meant for events to the application, and cannot fail the dispatch (see
   * {@link CommitHandler}). Like any handler, it must not dispatch to or dispose its own target synchronously:
   * that throws, and the throw is logged as its handler result. */
  addCommitHandler<V extends AnyVariant>(variant: V, cb: NoInfer<CommitHandler<V>>, context?: unknown): void;
}

/**
 * The handlers {@link mockHandlers} replaces, by kind: each typed as the handler of that kind on `V`. A transition
 * mock is typed only for an asynchronous variant, the only kind that has transition handlers; for a union of variants,
 * only when every one is asynchronous, and then as one handler of the union, as addTransitionHandler takes it.
 */
export interface HandlerMocks<V> {
  enter?: EnterHandler<V>;
  exit?: StateHandler<V>;
  update?: UpdateHandler<V>;

  // One-element tuples keep the check from distributing over a union of variants (see SignalDefinition).
  transition?: [V] extends [AsyncVariant] ? TransitionHandler<V> : never;
  commit?: CommitHandler<V>;
}

/** The kinds of handler a variant can have. */
type HandlerKind = "enter" | "exit" | "update" | "transition" | "commit";

/** Every handler kind. */
const HANDLER_KINDS: readonly HandlerKind[] = ["transition", "exit", "update", "enter", "commit"];

/** A registered handler: the callback, the `this` it is called with, and the name its handler results carry. */
export type Registered = { cb: (...args: any[]) => unknown; context: unknown; name: string };

/** A target's handlers by variant object and kind, in registration order. */
export type HandlerRegistry = Map<StateVariant, Partial<Record<HandlerKind, Registered[]>>>;

/** See {@link setHandlersDisabled}. */
let handlersDisabled = false;

/** The mocks in force, by variant object and kind; see {@link mockHandlers}. */
const mocks = new WeakMap<StateVariant, Partial<Record<HandlerKind, Registered>>>();

/**
 * Turns the handlers-off switch on or off, for simulation tests: a run with every handler off shows what a
 * flow commits without touching the world.
 *
 * The switch is read at every handler call, so it acts on every target, also one set up before it changed.
 * While it is on, no enter, exit, update, transition or commit handler runs, though applyFlow's initializer still
 * registers them all; turned off, those registrations run again. Reducers, the diffs of nested states, commits,
 * observers, `subscribeFlow` subscribers and the log run as usual. A declared transition has no work while it is
 * on unless a transition mock is in force (see {@link mockHandlers}), so its next commits inside the send that
 * declared it, with the props the world would fill left at their defaults, and its abort reducers cannot be reached.
 * Whether an entry is asynchronous is the variant's mark, which the switch does not change: a reducer that enters an
 * asynchronous variant without a transition is an Error with the switch on as off.
 *
 * `Box.deref` works as without the switch (it still throws inside a reducer): the switch stops handlers, and a
 * deref is not one. To check that a run touches nothing, give the target recording stand-ins, in its Boxes as
 * everywhere else.
 *
 * @param disabled - True to stop every handler; false to run them again.
 *
 * @example
 * ```ts
 * setHandlersDisabled(true);
 * try {
 *   const player = new Player(recordingDevice); // its constructor calls applyFlow
 *   await using send = await lock(player);
 *   await send(signals.play()).done();
 *   expect(recordingDevice.calls).toEqual([]);
 * } finally {
 *   setHandlersDisabled(false);
 * }
 * ```
 */
export function setHandlersDisabled(disabled: boolean): void {
  handlersDisabled = disabled;
}

/**
 * Replaces, on every target, all handlers of `variant` of each kind `given` names with that mock, until the
 * returned disposer runs (`using mocks = mockHandlers(...)`). A mock runs whether the handlers-off switch is on or
 * not, with the arguments the replaced handlers would get, so with the switch off it is a partial mock (one
 * service replaced, the others real) and with it on the only handler that runs. A transition mock gives a
 * transition's work to `variant`, an asynchronous variant, also when no transition handler is registered on it.
 * Registrations are left as they are, and the disposer brings them back.
 *
 * @throws StateFlowError when `given` has a key other than enter, exit, update, transition and commit, a kind it
 *   names is mocked on `variant` already (stacked mocks would make the disposers' order matter), or it mocks the
 *   transition handlers of a variant that is not asynchronous.
 *
 * @example
 * ```ts
 * using mocks = mockHandlers(driver.active, {
 *   transition: async () => driver.active.results.loaded({ manifest: fakeManifest }),
 * });
 * ```
 */
export function mockHandlers<V extends AnyVariant>(variant: V, given: NoInfer<HandlerMocks<V>>): Disposable {
  // A key outside the type reaches here from a variable or from JavaScript; dropped, it would leave the test that
  // set it running without its mock.
  const other = Object.keys(given).find((key) => !(HANDLER_KINDS as readonly string[]).includes(key));
  if (other !== undefined) {
    throw new StateFlowError(
      "SF047",
      `${String(variant)}: mockHandlers mocks enter, exit, update, transition and commit handlers, not ${other}`,
    );
  }
  if (given.transition !== undefined) {
    refuseSynchronous(variant);
  }
  const mocked = mocks.get(variant) ?? {};
  const added: Array<[HandlerKind, Registered]> = [];
  for (const kind of HANDLER_KINDS) {
    const cb = given[kind];
    if (cb === undefined) {
      continue;
    }
    if (mocked[kind] !== undefined) {
      throw new StateFlowError(
        "SF048",
        `${String(variant)}: its ${kind} handlers are mocked already; dispose that mock first`,
      );
    }
    added.push([kind, { cb, context: undefined, name: buildName(undefined, cb) }]);
  }
  for (const [kind, mock] of added) {
    mocked[kind] = mock;
  }
  mocks.set(variant, mocked);
  return {
    [Symbol.dispose]: () => {
      for (const [kind, mock] of added) {
        // A second dispose finds its mock gone already, and must not remove one a later mockHandlers added.
        if (mocked[kind] === mock) {
          delete mocked[kind];
        }
      }
    },
  };
}

/** Throws for a variant not declared with `{ async: true }`: only an asynchronous entry has transition handlers. */
function refuseSynchronous(variant: StateVariant): void {
  if (!variant[IS_ASYNC]) {
    throw new StateFlowError(
      "SF049",
      `${String(variant)} is not asynchronous: only a variant declared with { async: true } has transition handlers`,
    );
  }
}

/**
 * The handlers of `kind` on `variant` that run now: its mock while one is in force, whatever the switch says;
 * else none while the switch is on; else the target's registrations in their order.
 */
export function handlersFor(
  registry: HandlerRegistry,
  variant: StateVariant,
  kind: HandlerKind,
): readonly Registered[] {
  const mock = mocks.get(variant)?.[kind];
  if (mock !== undefined) {
    return [mock];
  }
  if (handlersDisabled) {
    return [];
  }
  return registry.get(variant)?.[kind] ?? [];
}

/** The StateManager whose adders register into `registry`. */
export function stateManager(registry: HandlerRegistry, defineEvent: EventRegistrar): StateManager {
  const register =
    (kind: HandlerKind) =>
    (variant: StateVariant, cb: (...args: any[]) => unknown, context?: unknown): void => {
      if (kind === "transition") {
        refuseSynchronous(variant);
      }
      // Named here, at registration, so a context whose name cannot be read throws at setup: at a call the
      // throw would escape after a transition's temp commit and leave it pending with no end.
      const handler: Registered = { cb, context, name: buildName(context, cb) };
      const kinds = registry.get(variant) ?? {};
      kinds[kind] = [...(kinds[kind] ?? []), handler];
      registry.set(variant, kinds);
    };
  return {
    addEnterHandler: register("enter"),
    addExitHandler: register("exit"),
    addUpdateHandler: register("update"),
    addTransitionHandler: register("transition"),
    addCommitHandler: register("commit"),
    defineEvent,
  };
}

/**
 * What an exit, update or enter handler's return counts as in a step: the HandlerResult itself, or an Error for a
 * return the engine cannot use. These handlers are synchronous, so a promise is an Error. A named result folds into
 * the instance its call enters or updates, so an enter or update handler may return one, only of that instance's
 * variant, whose result reducer folds it; an exit handler may not, since the node it leaves holds no instance of its
 * variant once the step commits.
 */
export function stepResult(
  value: unknown,
  handlerName: string,
  kind: "exit" | "update" | "enter",
  variant: StateVariant,
): Result {
  if (isThenable(value)) {
    // Not awaited, and nothing else will observe it: without a handler its rejection would surface as an
    // unhandled rejection.
    Promise.resolve(value).catch(() => {});
    return Verdict.error(
      new StateFlowError(
        "SF050",
        `Handler '${handlerName}' returned a promise; enter, exit and update handlers are synchronous`,
      ),
    );
  }
  const result = entryResult(value, handlerName, variant);
  const named = result instanceof HandlerResult ? result.named : null;
  if (named !== null && kind === "exit") {
    return Verdict.error(
      new StateFlowError(
        "SF051",
        `exit handler '${handlerName}' returned the named result ${named.name}; only an enter, update or transition handler may`,
      ),
    );
  }
  return result;
}

/**
 * Calls a transition handler and maps what it gives to a promise of its Result that never rejects, so the merge of
 * a transition's work never meets a value it cannot merge and its end always comes. A throw, or a return that is
 * no promise, is an Error at once; a promise settles to its HandlerResult, plain or a named result of `variant`,
 * the variant entered, and to an Error for any other value or for a rejection.
 */
export function transitionResult(call: () => unknown, handlerName: string, variant: StateVariant): Promise<Result> {
  try {
    const returned = call();
    if (!isThenable(returned)) {
      return Promise.resolve(
        Verdict.error(new StateFlowError("SF052", `Transition handler '${handlerName}' returned no promise`)),
      );
    }
    // catch() after then(), so a throw while reading the value (its prototype, a Proxy) is mapped too.
    return Promise.resolve(returned)
      .then((value) => entryResult(value, handlerName, variant))
      .catch((reason: unknown) => Verdict.error(reason));
  } catch (err) {
    // A throw from the call, or from reading `then` on what it returned.
    return Promise.resolve(Verdict.error(err));
  }
}

/** What a handler's (resolved) return counts as for an entry into `variant`: the HandlerResult itself, or an
 * Error for any other value and for a named result of another variant. */
function entryResult(value: unknown, handlerName: string, variant: StateVariant): Result {
  if (!(value instanceof HandlerResult)) {
    return Verdict.error(new StateFlowError("SF053", `Handler '${handlerName}' did not return a HandlerResult`));
  }
  const named = value.named;
  if (named !== null && named.variant !== variant) {
    return Verdict.error(
      new StateFlowError(
        "SF054",
        `Handler '${handlerName}' on ${String(variant)} returned ${String(named.variant)}'s named result ${named.name}`,
      ),
    );
  }
  return value;
}
