/**
 * The reducer side of a dispatch, where user reducer code runs: every signal reducer of every node in the flow's tree
 * (top-level and nested states) whose variant has one, each in reducer scope on the frozen snapshot from before
 * the signal, read as an answer or as a verdict; the result reducers that fold a step's named results, and a
 * failed step's FAILURE results, into the nodes they are given to; and the result reducers by which the other states
 * take a named result, read as answers on the snapshot the step started from.
 */
import { isBox } from "./box";
import { FrozenMap, FrozenSet, type Items, keyFunctionOf, keyString } from "./collections";
import { runInReducer } from "./reducer-scope";
import {
  type DeclaredTransition,
  mergeResults,
  type ReducerAnswer,
  Result,
  ResultKind,
  StateResult,
  Verdict,
} from "./result";
import type { ReducerContext, Signal } from "./signal";
import {
  type AnyDefinition,
  type FlowSnapshot,
  getName,
  isState,
  type ResultReducer,
  type StateDefinition,
  type StateInstance,
} from "./state";
import { DEF, type FAILURE, RESULT_REDUCERS, SIGNAL_REDUCERS, SNAPSHOT, VARIANT } from "./symbols";
import {
  above,
  below,
  childPositions,
  type HandlerCall,
  instanceAt,
  type Path,
  type Position,
  pathName,
  positionKey,
  replaceAt,
  sameKey,
  sameNestedStates,
  topLevel,
  valueAt,
} from "./tree";
import { isPlainObject, isThenable, StateFlowError } from "./utils";

/** What one reducer decided for its node: its ReducerAnswer, where the node stands, and the instance it ran on. */
export type Answer = ReducerAnswer & {
  /** The node's place in the decided tree. */
  node: Decided;
  /** The node's instance in the snapshot the reducer ran on. */
  before: StateInstance;
};

/** A node whose reducer answered, or an ancestor of one; subtrees where no reducer answered are left out. */
export type Decided = {
  path: Path;
  answer: Answer | null;
  below: Array<{ position: Position; decided: Decided }>;
};

/** An answer that declared a transition, which always names its failed: StateResult.transition requires it. */
export type DeclaredAnswer = Answer & { transition: DeclaredTransition; failed: StateInstance };

/**
 * What the reducers decided for one signal: the decided tree of each top-level state that has one, by name; every
 * answer in the order the reducers ran, which is pre-order, states in the flow's order; and the answer that declared a
 * transition, if one did.
 */
export type Reduction = {
  decided: Map<string, Decided>;
  answers: Answer[];
  declared: DeclaredAnswer | null;
};

/**
 * Runs the reducer that each node of the flow's tree has for `signal`, in pre-order with the states in the flow's
 * order, every one on `snapshot`, the frozen snapshot from before the signal: no reducer sees what another reducer
 * decided for the same signal. A nested node's reducer gets its parent's instance in that snapshot and its key in its
 * parent's Items as ctx.parent and ctx.key. Every reducer runs, and their verdicts merge in that order (see
 * Result.merge), an answer counting as OK: a refusal wins over every answer, and an answer over Ignored. Only the
 * nodes that have a reducer for the signal run; `known` keeps each state's reducers by name, and the first
 * dispatch after a state's top-level instance changes, or after defineFlow fills a reducer record its tree had
 * unfilled, walks its tree once to collect them (see {@link reducersOf}). With `byValue`, an answer whose next is of
 * its node's variant with equal props counts as the node's instance (see {@link normalize}).
 *
 * @returns The merged refusal (Rejected or Error); Ignored when no reducer answered; an Error when two reducers
 *   declared a transition; otherwise the reduction.
 */
export function reduce(
  states: readonly StateDefinition[],
  snapshot: FlowSnapshot,
  signal: Signal,
  known: Map<string, TreeReducers>,
  byValue: boolean,
): Reduction | Result {
  const answers: Answer[] = [];
  // The verdicts of the reducers that did not answer. The answers' OK takes part in the merge through the checks
  // below: a refusal among these verdicts wins over it, and it wins over their Ignored.
  const verdicts: Result[] = [];
  const decided = new Map<string, Decided>();
  const name = signal[Symbol.toStringTag];
  for (const def of states) {
    const state = getName(def);
    for (const reducible of reducersOf(known, snapshot[state], state).signals[name] ?? []) {
      const { x, path } = reducible;
      const where = () => `${pathName(path)}: the reducer of ${String(x[VARIANT])} for ${name}`;
      const outcome = runReducer(reducible, signal, snapshot, where, byValue);
      if (outcome instanceof Result) {
        verdicts.push(outcome);
      } else {
        const node = decidedAt(decided, path);
        const answer: Answer = { ...outcome, node, before: x };
        node.answer = answer;
        answers.push(answer);
      }
    }
  }

  const merged = mergeResults(verdicts);
  if (merged.in(ResultKind.Rejected, ResultKind.Error)) {
    return merged;
  }
  if (answers.length === 0) {
    // When no variant has a reducer, a bare Ignored would not tell whether the state or the signal is wrong.
    const variants = states.map((def) => String(snapshot[getName(def)][VARIANT]));
    return verdicts.length > 0
      ? merged
      : Verdict.ignored("SF064", `no reducer for ${signal[Symbol.toStringTag]} in ${variants.join(", ")}`);
  }
  // One pending transition per target: the lock, the abort and the timer each belong to one.
  const declaring = answers.filter((answer): answer is DeclaredAnswer => answer.transition !== null);
  if (declaring.length > 1) {
    const [a, b] = declaring.map((answer) => pathName(answer.node.path));
    return Verdict.error(new StateFlowError("SF055", `two transitions declared in one dispatch: ${a} and ${b}`));
  }
  return { decided, answers, declared: declaring[0] ?? null };
}

/**
 * Runs the reducers by which the other states take `result`, a named result a handler of the node at `result.call`
 * returned: the result reducer of the result's name that each node of `snapshot`, the snapshot the step started from,
 * has under a name its variant does not declare (see {@link reducersOf}), unless the node is of the declaring node's
 * state, where only the declaring node takes the result, by its fold (see {@link fold}). As the reducers of a
 * signal run (see {@link reduce}): in pre-order with the states in the flow's order, every one on `snapshot`, with the
 * result's data for the signal, its answer read as a signal reducer's (see {@link normalize}), and their verdicts
 * merged in that order. A transition or a failed in an answer is an Error: the transition belongs to the signal
 * reducers, and a node that takes a result stays as it was when its step is refused, as a node whose reducer declared no
 * failed.
 *
 * @returns The merged refusal (Rejected or Error); otherwise the answers, none when no node took the result.
 */
export function reduceResult(
  states: readonly StateDefinition[],
  snapshot: FlowSnapshot,
  { call, name, data }: NamedResult,
  known: Map<string, TreeReducers>,
  byValue: boolean,
): Reduction | Result {
  const answers: Answer[] = [];
  const verdicts: Result[] = [];
  const decided = new Map<string, Decided>();
  const declaring = call.instance[VARIANT][DEF];
  for (const def of states) {
    const state = getName(def);
    for (const reducible of reducersOf(known, snapshot[state], state).results[name] ?? []) {
      const { x, path } = reducible;
      if (x[VARIANT][DEF] === declaring) {
        continue;
      }
      const where = () => `${pathName(path)}: the result reducer ${name} of ${String(x[VARIANT])}`;
      const outcome = runReducer(reducible, data, snapshot, where, byValue);
      if (outcome instanceof Result) {
        verdicts.push(outcome);
      } else if (outcome.transition !== null || outcome.failed !== undefined) {
        verdicts.push(
          Verdict.error(
            new StateFlowError("SF056", `${where()} returned a transition or a failed; it answers with next only`),
          ),
        );
      } else {
        const node = decidedAt(decided, path);
        const answer: Answer = { ...outcome, node, before: x };
        node.answer = answer;
        answers.push(answer);
      }
    }
  }
  const merged = mergeResults(verdicts);
  return merged.in(ResultKind.Rejected, ResultKind.Error) ? merged : { decided, answers, declared: null };
}

/**
 * Runs a node's reducer (see {@link Reducible}) in reducer scope on the node's instance, with `payload` (a signal, or a
 * result's data) and a ctx that reads `snapshot`, and reads its return as the node's answer or the verdict it gives
 * (see {@link normalize}); its throw is its Error. `where` names the reducer in an Error's message.
 */
function runReducer(
  { reducer, x, path, parent, key }: Reducible,
  payload: unknown,
  snapshot: FlowSnapshot,
  where: () => string,
  byValue: boolean,
): ReducerAnswer | Result {
  try {
    const returned: unknown = runInReducer(() => reducer(x, payload, reducerContext(snapshot, parent, key)));
    return normalize(returned, x, where, keyedElement(parent, path), byValue);
  } catch (err) {
    return Verdict.error(err);
  }
}

/** A node of a tree whose variant has a reducer of a name, with what a run of that reducer reads. */
type Reducible = {
  /** A signal reducer, run with the signal, or a result reducer, run with the result's data. */
  reducer: (state: any, payload: any, ctx: ReducerContext) => unknown;
  x: StateInstance;
  path: Path;
  /** The parent's instance, undefined at the top level: the reducer's ctx.parent. */
  parent: StateInstance | undefined;
  /** The node's key in its parent's Items, undefined at the top level and for a single nested state: ctx.key. */
  key: unknown;
};

/**
 * The reducers of the tree of `top`, a top-level state's instance, by name, each name's in pre-order: the signal
 * reducers by signal name, and by result name the result reducers by which a variant takes other states' named results,
 * under names it does not declare (see {@link addReducers}). An instance is frozen and holds the same nested
 * states for life, and defineFlow fills a variant's two reducer records once and freezes them; so they stay right while
 * the state holds `top` and none of `open`, the signal records of the tree that defineFlow had not filled yet, is
 * frozen.
 */
export type TreeReducers = {
  top: StateInstance;
  open: readonly object[];
  signals: Record<string, Reducible[]>;
  results: Record<string, Reducible[]>;
};

/**
 * The reducers of `top`'s tree, the instance of the top-level state `state` in the snapshot a dispatch reduces, by
 * name: the ones `known` keeps for the state when they are still right (see {@link TreeReducers}), or else collected by
 * one pre-order walk of the tree and kept there.
 */
function reducersOf(known: Map<string, TreeReducers>, top: StateInstance, state: string): TreeReducers {
  const kept = known.get(state);
  if (kept !== undefined && kept.top === top && !kept.open.some(Object.isFrozen)) {
    return kept;
  }
  // No prototype, so a signal or a result named like an Object.prototype member finds no list there.
  const signals: Record<string, Reducible[]> = Object.create(null);
  const results: Record<string, Reducible[]> = Object.create(null);
  const open: object[] = [];
  const visit = (x: StateInstance, path: Path, parent: StateInstance | undefined, key: unknown): void => {
    const variant = x[VARIANT];
    // Each record once, so a variant that many nodes share is checked once per dispatch. defineFlow freezes a
    // variant's result record together with its signal record, so the signal record tells for both.
    if (!Object.isFrozen(variant[SIGNAL_REDUCERS]) && !open.includes(variant[SIGNAL_REDUCERS])) {
      open.push(variant[SIGNAL_REDUCERS]);
    }
    const node = { x, path, parent, key };
    addReducers(signals, variant[SIGNAL_REDUCERS], {}, node);
    addReducers(results, variant[RESULT_REDUCERS], variant.results, node);
    for (const position of childPositions(x)) {
      visit(valueAt(x, position) as StateInstance, below(path, position), x, positionKey(position));
    }
  };
  visit(top, topLevel(state), undefined, undefined);
  const tree = { top, open, signals, results };
  known.set(state, tree);
  return tree;
}

/**
 * Adds each reducer of `records`, a variant's signal or result reducers by name, to `byName`, with the node it runs
 * on; except one under a name of `declared`, the variant's own named results, since such a reducer folds its own
 * variant's result (see {@link fold}) and takes no other state's.
 */
function addReducers(
  byName: Record<string, Reducible[]>,
  records: object,
  declared: object,
  node: Omit<Reducible, "reducer">,
): void {
  const reducers = records as Readonly<Record<string, Reducible["reducer"] | undefined>>;
  // The record has no prototype (a variant gets it from build()), so for-in visits its own names only; and no symbol,
  // so FAILURE's reducer, which the engine runs only for a failed step's own nodes, has no list.
  for (const name in reducers) {
    const reducer = reducers[name];
    // defineFlow takes undefined under a result's name without a cast; it means no reducer, as an absent name does.
    // (defineFlow drops it from a signal record.)
    if (reducer !== undefined && !Object.hasOwn(declared, name)) {
      byName[name] ??= [];
      byName[name].push({ ...node, reducer });
    }
  }
}

/**
 * The decided node at `path`, made, with every ancestor it lacks, when `decided` does not hold it yet. Answers come in
 * pre-order, so a node made for an earlier answer, when it is on `path`, is the last entry below its parent. Positions
 * compare by identity: the paths of one state's answers come from one walk in {@link reducersOf}, where a node's path
 * extends its parent's with the same Position objects.
 */
function decidedAt(decided: Map<string, Decided>, path: Path): Decided {
  let node: Decided = decided.get(path.state) ?? { path: topLevel(path.state), answer: null, below: [] };
  decided.set(path.state, node);
  for (const [depth, position] of path.positions.entries()) {
    const last = node.below[node.below.length - 1];
    if (last?.position === position) {
      node = last.decided;
    } else {
      const made: Decided = {
        path: { state: path.state, positions: path.positions.slice(0, depth + 1) },
        answer: null,
        below: [],
      };
      node.below.push({ position, decided: made });
      node = made;
    }
  }
  return node;
}

/** An element of a keyed set: its key, and the set's key function, which a reducer's new element must map to it. */
type KeyedElement = { key: unknown; keyFunction: (item: StateInstance) => unknown };

/**
 * The element the node at `path` is in `parent`, its parent's instance (undefined at the top level), when a keyed set
 * holds it; undefined for any other node.
 */
function keyedElement(parent: StateInstance | undefined, path: Path): KeyedElement | undefined {
  const position = path.positions[path.positions.length - 1];
  if (parent === undefined || !("key" in position)) {
    return undefined;
  }
  const keyFunction = keyFunctionOf(Reflect.get(parent, position.prop) as Items<AnyDefinition, unknown>);
  return keyFunction === undefined ? undefined : { key: position.key, keyFunction };
}

/**
 * An Error naming `where` when `element` is a keyed-set element and `x`, which user code built for it, maps to
 * another key; null otherwise. The set's key function is reducer code, so it runs in reducer scope.
 */
function changedKey(where: string, x: StateInstance, element: KeyedElement | undefined): Result | null {
  if (element === undefined) {
    return null;
  }
  const key = runInReducer(() => element.keyFunction(x));
  return sameKey(key, element.key)
    ? null
    : Verdict.error(
        new StateFlowError("SF057", `${where} returned ${String(x)}, whose key ${keyString(key)} is not its own`),
      );
}

/**
 * A reducer's ctx: the parent's instance in the reducer's snapshot and the node's key in the parent's Items (both
 * undefined at the top level; the key is undefined for a single nested state). It carries the snapshot under
 * SNAPSHOT, which a definition called on ctx reads, and it is frozen, so a reducer's write to it fails (in
 * strict-mode code it throws, which is the reducer's Error).
 */
function reducerContext(snapshot: FlowSnapshot, parent: StateInstance | undefined, key: unknown): ReducerContext {
  const read = (name: string): StateInstance => {
    const state = snapshot[name];
    if (state === undefined) {
      throw new StateFlowError("SF058", `No state ${name} in the flow`);
    }
    return state;
  };
  return Object.freeze(Object.defineProperty({ parent, key, read }, SNAPSHOT, { value: snapshot }));
}

/**
 * The return of a reducer that ran on `before`, its node's instance, as the node's answer, or as the verdict it gives
 * instead: a StateResult's ignored, rejected or error; an Error for an instance of another state, since a reducer
 * decides its own node only; an Error for a promise, since reducers are synchronous; an Error for anything that is
 * neither a StateResult, an instance nor props. `where` names the reducer in an Error's message; a function, so the
 * name is built only for an Error, not for every reducer of every dispatch.
 * Props become an instance of the node's current variant, so a parser's throw is the reducer's Error. In a keyed set,
 * a new element, a temp and a failed instance must keep the element's key. A nested node's transition is an answer
 * like a top-level one's: the plan lifts it into the face through its ancestors.
 * With `byValue`, a next of `before`'s variant whose props equal `before`'s (see {@link sameProps}) is `before`, as if
 * the reducer had returned it, so the step changes nothing there. A temp and a failed stay as they are: a failed step
 * folds FAILURE only into a node it enters or updates, so a failed with equal props still takes it.
 */
function normalize(
  returned: unknown,
  before: StateInstance,
  where: () => string,
  element: KeyedElement | undefined,
  byValue: boolean,
): ReducerAnswer | Result {
  if (isThenable(returned)) {
    // Read as props it would commit an instance with none; and its rejection, which nothing awaits, is swallowed.
    Promise.resolve(returned).catch(() => {});
    return Verdict.error(new StateFlowError("SF059", `${where()} returned a promise; reducers are synchronous`));
  }
  let answer: ReducerAnswer;
  if (returned instanceof StateResult) {
    if (returned.answer === null) {
      return returned;
    }
    answer = returned.answer;
  } else if (isState(returned)) {
    answer = { next: returned, failed: undefined, transition: null };
  } else if (typeof returned === "object" && returned !== null && !(returned instanceof Result)) {
    // Props; a HandlerResult or an engine result is an object too, but no props.
    answer = { next: before[VARIANT](returned), failed: undefined, transition: null };
  } else {
    return Verdict.error(new StateFlowError("SF060", `${where()} returned no StateResult, instance or props`));
  }
  const def = before[VARIANT][DEF];
  if (answer.next[VARIANT][DEF] !== def) {
    return Verdict.error(
      new StateFlowError("SF061", `${where()} returned ${String(answer.next)}, not an instance of ${String(def)}`),
    );
  }
  // The definition check of next covers temp and a failed instance too: the factories take them of next's state
  // only.
  for (const x of [answer.next, answer.transition?.temp, answer.failed]) {
    const changed = isState(x) ? changedKey(where(), x, element) : null;
    if (changed !== null) {
      return changed;
    }
  }
  const { next } = answer;
  return byValue && next !== before && next[VARIANT] === before[VARIANT] && sameProps(next, before)
    ? { ...answer, next: before }
    : answer;
}

/**
 * Whether `a` and `b`, the props of two instances or two plain records or arrays inside props, have the same own
 * enumerable keys and, under each, values equal by {@link sameData}.
 */
function sameProps(a: object, b: object): boolean {
  // A spread copies exactly the own enumerable props, symbol keys too (Object.keys leaves those out); the comparison
  // reads only the copies.
  const ownA = { ...a };
  const ownB = { ...b };
  const keys = Reflect.ownKeys(ownA);
  return (
    keys.length === Reflect.ownKeys(ownB).length &&
    keys.every((key) => Object.hasOwn(ownB, key) && sameData(Reflect.get(ownA, key), Reflect.get(ownB, key)))
  );
}

/**
 * Whether two values in props are equal for FlowConfig.equalAnswers "value": the same value (===); Boxes that wrap the
 * same value; FrozenSets of one size whose elements the other has; FrozenMaps of one size whose keys the other has,
 * with equal values; arrays of one length, and plain records, by {@link sameProps}. Anything else only by ===: a
 * nested state, whose variant is no own enumerable prop, so its props cannot tell two of its instances apart; an
 * Items; any other object.
 */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (isBox(a)) {
    return a.equals(b);
  }
  if (a instanceof FrozenSet) {
    // Empty when each set has every element of the other.
    return b instanceof FrozenSet && a.symmetricDifference(b).size === 0;
  }
  if (a instanceof FrozenMap) {
    return (
      b instanceof FrozenMap &&
      a.size === b.size &&
      [...a].every(([key, value]) => b.has(key) && sameData(value, b.get(key)))
    );
  }
  if (Array.isArray(a)) {
    // A hole is no key, so it equals only a hole; the length is no enumerable key, so it is compared on its own.
    return Array.isArray(b) && a.length === b.length && sameProps(a, b);
  }
  return isPlainObject(a) && isPlainObject(b) && !isState(a) && !isState(b) && sameProps(a, b);
}

/**
 * A result to fold into the node at `call.path` through its variant's result reducer `name`: a named result an enter,
 * update or transition handler of that call returned, or FAILURE, which the engine gives a node a failed step enters
 * or updates.
 */
export type ResultToFold = { call: HandlerCall; name: string | typeof FAILURE; data: unknown };

/** A named result an enter, update or transition handler returned: a result to fold, under its name. */
export type NamedResult = ResultToFold & { name: string };

/**
 * Folds `results` into `snapshot`, the step's target, in their order: each one's result reducer gets the node as
 * folded so far, and what it returns takes the node's place. A failure is the step's failure (see {@link foldOne}):
 * it stops the fold, or in a floor step, which commits whatever happens, skips that result and is kept.
 *
 * @returns The snapshot as folded, frozen; the failure, or in a floor step the merge of every failure, null when none
 *   failed; and `taken`, the results that folded, in their order.
 */
export function fold(
  snapshot: FlowSnapshot,
  results: readonly ResultToFold[],
  floor: boolean,
): { snapshot: FlowSnapshot; failure: Result | null; taken: ResultToFold[] } {
  let folded = snapshot;
  const failures: Result[] = [];
  const taken: ResultToFold[] = [];
  for (const result of results) {
    const x = foldOne(folded, result);
    if (x instanceof Result) {
      failures.push(x);
      if (!floor) {
        break;
      }
    } else {
      folded = replaceAt(folded, result.call.path, x);
      taken.push(result);
    }
  }
  return { snapshot: folded, failure: failures.length > 0 ? mergeResults(failures) : null, taken };
}

/**
 * The node at `call.path` in `snapshot` with the result folded in by its variant's result reducer `name`, which runs in
 * reducer scope with the node, the data and a ctx that reads `snapshot` (the step's target as folded so far) and
 * carries the node's key as ctx.key. An Error, the step's failure, when the variant has no reducer of that name, the
 * reducer throws (a parser's throw on its props included) or returns neither props nor an instance of the node's
 * variant, or its return changes a nested state (those change only through steps, whose handlers run) or, in a keyed
 * set, the element's key.
 */
function foldOne(snapshot: FlowSnapshot, { call, name, data }: ResultToFold): StateInstance | Result {
  const cur = instanceAt(snapshot, call.path) as StateInstance;
  const variant = cur[VARIANT];
  // How messages name the reducer: FAILURE is a symbol, whose string form would read Symbol(FAILURE).
  const label = typeof name === "string" ? name : "FAILURE";
  const where = `${call.name}: the result reducer ${label} of ${String(variant)}`;
  const reducers = variant[RESULT_REDUCERS] as Readonly<
    Record<string | typeof FAILURE, ResultReducer<unknown, unknown> | undefined>
  >;
  const reducer = reducers[name];
  if (reducer === undefined) {
    return Verdict.error(
      new StateFlowError("SF062", `${call.name}: ${String(variant)} has no result reducer for ${label}`),
    );
  }
  try {
    const parentPath = above(call.path);
    const parent = parentPath === undefined ? undefined : instanceAt(snapshot, parentPath);
    const returned: unknown = runInReducer(() => reducer(cur, data, reducerContext(snapshot, parent, call.key)));
    if (isThenable(returned)) {
      Promise.resolve(returned).catch(() => {});
      return Verdict.error(new StateFlowError("SF059", `${where} returned a promise; reducers are synchronous`));
    }
    // Props, like a signal reducer's; a HandlerResult or an engine result is an object too, but no props.
    const x =
      typeof returned === "object" && returned !== null && !isState(returned) && !(returned instanceof Result)
        ? variant(returned)
        : returned;
    if (!isState(x) || x[VARIANT] !== variant) {
      return Verdict.error(
        new StateFlowError("SF061", `${where} returned ${String(x)}, not an instance of ${String(variant)}`),
      );
    }
    if (!sameNestedStates(cur, x)) {
      return Verdict.error(
        new StateFlowError("SF063", `${where} changed a nested state; nested states change only through a step`),
      );
    }
    return changedKey(where, x, keyedElement(parent, call.path)) ?? x;
  } catch (err) {
    return Verdict.error(err);
  }
}
