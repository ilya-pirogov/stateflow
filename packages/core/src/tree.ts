/**
 * The tree of a flow's states: a top-level state's instance and, at positions in its props, the nested
 * states it holds, at any depth. Pure functions over frozen instances: where a node is, how a node is rebuilt
 * around changed nested states, how the reducers' answers compose into a snapshot, and how two snapshots differ
 * node by node. Nothing here touches a target or calls a handler.
 */
import { DisposableBox } from "./box";
import { definitionOf, type Items, isItems, keyString, replaceItem } from "./collections";
import type { Answer, Decided } from "./reducers";
import { type AnyDefinition, type FlowSnapshot, instantiate, isState, type StateInstance } from "./state";
import { DEF, IS_ASYNC, IS_TRANSITIONAL, VARIANT } from "./symbols";

/** Where a nested state sits in its parent: held directly in a prop, or under a key of the Items in a prop. */
export type Position = { readonly prop: string } | { readonly prop: string; readonly key: unknown };

/** A node of the tree: a top-level state's name and the positions that lead from it to the node. */
export type Path = { readonly state: string; readonly positions: readonly Position[] };

/** One handler call of a step: the node's instance (for an exit, the instance it leaves), the instance it had
 * before (undefined for a node entering a new position or one another definition held), and its key in its
 * parent's Items (undefined at the top level and for a single nested state). `name` names it in the log. */
export type HandlerCall = {
  path: Path;
  name: string;
  instance: StateInstance;
  prev: StateInstance | undefined;
  key: unknown;
};

/** One node a step changes, for its log entry. An undefined side is a position empty on that side. */
export type StateChange = {
  path: Path;
  /** The node's path as the log names it (see {@link pathName}): the state's name for a top-level state. */
  stateName: string;
  old: StateInstance | undefined;
  next: StateInstance | undefined;
};

/** What a step does to one tree, collected by {@link diffNode}. */
export type TreeDiff = { exit: HandlerCall[]; update: HandlerCall[]; enter: HandlerCall[]; changes: StateChange[] };

/** The path of the top-level state `state`. */
export function topLevel(state: string): Path {
  return { state, positions: [] };
}

/** The path of the node at `position` below the node at `path`. */
export function below(path: Path, position: Position): Path {
  return { state: path.state, positions: [...path.positions, position] };
}

/** The path of the node that holds the node at `path`; undefined for a top-level state. */
export function above(path: Path): Path | undefined {
  return path.positions.length === 0 ? undefined : { state: path.state, positions: path.positions.slice(0, -1) };
}

/** A nested state's key in its parent's Items; undefined for a single nested state. */
export function positionKey(position: Position): unknown {
  return "key" in position ? position.key : undefined;
}

/** Whether two keys are one key of a Map: SameValueZero, which Array.prototype.includes uses too. */
export function sameKey(a: unknown, b: unknown): boolean {
  return [a].includes(b);
}

/** Whether two paths lead to one node: one state, and position by position one prop and one key or none. */
export function samePath(a: Path, b: Path): boolean {
  return (
    a.state === b.state &&
    a.positions.length === b.positions.length &&
    a.positions.every((position, i) => {
      const other = b.positions[i];
      return (
        position.prop === other.prop &&
        "key" in position === "key" in other &&
        sameKey(positionKey(position), positionKey(other))
      );
    })
  );
}

/** How the log names the node at `path`: `media`, `media.transport`, `media.producers[cam]`. */
export function pathName(path: Path): string {
  return (
    path.state + path.positions.map((p) => ("key" in p ? `.${p.prop}[${keyString(p.key)}]` : `.${p.prop}`)).join("")
  );
}

/**
 * The value `x` holds in its own data property `prop`; undefined for a getter. A getter is a value the parser
 * derived from the props: the engine never calls it, so it is no position, and a rebuild keeps it.
 */
function heldIn(x: object, prop: string): unknown {
  return Object.getOwnPropertyDescriptor(x, prop)?.value;
}

/**
 * The positions of the nested states `x` holds in its own data properties, in the order of its own props, and
 * for an Items prop in the Items' order; none for undefined. Any other prop value is data.
 */
export function childPositions(x: StateInstance | undefined): Position[] {
  const positions: Position[] = [];
  if (x === undefined) {
    return positions;
  }
  for (const prop of Object.keys(x)) {
    const value = heldIn(x, prop);
    if (isState(value)) {
      positions.push({ prop });
    } else if (isItems(value)) {
      for (const key of value.keys()) {
        positions.push({ prop, key });
      }
    }
  }
  return positions;
}

/** The nested state `x` holds at `position`, or undefined when it holds none there. */
export function valueAt(x: StateInstance | undefined, position: Position): StateInstance | undefined {
  const value = x === undefined ? undefined : heldIn(x, position.prop);
  if ("key" in position) {
    return isItems(value) ? (value.get(position.key) as StateInstance | undefined) : undefined;
  }
  return isState(value) ? value : undefined;
}

/** Whether `a` and `b` hold the same nested states, the same objects, at the same positions. */
export function sameNestedStates(a: StateInstance, b: StateInstance): boolean {
  const positions = childPositions(a);
  return (
    positions.length === childPositions(b).length &&
    positions.every((position) => valueAt(b, position) === valueAt(a, position))
  );
}

/** The node at `path` in `snapshot`; undefined when a position on the way holds none. */
export function instanceAt(snapshot: FlowSnapshot, path: Path): StateInstance | undefined {
  return heldAt(snapshot[path.state], path.positions);
}

/** The node that `positions` lead to from `x`, `x` itself for none; undefined when a position on the way holds none. */
export function heldAt(x: StateInstance | undefined, positions: readonly Position[]): StateInstance | undefined {
  return positions.reduce<StateInstance | undefined>((node, position) => valueAt(node, position), x);
}

/**
 * Adds to `defs` the definition of `x`, of every nested state it holds at any depth, and of every Items it holds,
 * empty or not: the definitions applyFlow sees in an initial instance. A definition a node first holds later, in a
 * position that held none, is not among them.
 */
export function addHeldDefinitions(x: StateInstance, defs: Set<AnyDefinition>): void {
  defs.add(x[VARIANT][DEF]);
  // An empty Items holds no position, so its definition is read from the Items itself.
  for (const prop of Object.keys(x)) {
    const value = heldIn(x, prop);
    if (isItems(value)) {
      defs.add(definitionOf(value));
    }
  }
  for (const position of childPositions(x)) {
    addHeldDefinitions(valueAt(x, position) as StateInstance, defs);
  }
}

/** A DisposableBox a node holds: the node, by its path, and the own prop that holds the box. */
export type Place = { box: DisposableBox<any>; path: Path; prop: string };

/**
 * Adds to `places` each DisposableBox that `x`, the node at `path`, holds in an own enumerable string-keyed prop, and
 * those of the nested states it holds in its props, directly or in an Items, at any depth. Each prop is read once,
 * through its descriptor, so no getter runs (see heldIn); a box inside an array or an object in a prop is not looked
 * for. `x` may also be a named result's data, read the same way.
 */
export function addPlaces(x: object | null | undefined, path: Path, places: Place[]): void {
  // for-in visits the enumerable string keys, inherited ones too, which have no own descriptor; and it builds no array.
  for (const prop in x) {
    const value: unknown = Object.getOwnPropertyDescriptor(x, prop)?.value;
    if (value instanceof DisposableBox) {
      places.push({ box: value, path, prop });
    } else if (isState(value)) {
      addPlaces(value, below(path, { prop }), places);
    } else if (isItems(value)) {
      value.forEach((item, key) => {
        addPlaces(item as StateInstance, below(path, { prop, key }), places);
      });
    }
  }
}

/** Every DisposableBox the nodes of `snapshot` hold (see {@link addPlaces}), the states in the snapshot's order. */
export function placesIn(snapshot: FlowSnapshot): Place[] {
  const places: Place[] = [];
  for (const state in snapshot) {
    addPlaces(snapshot[state], topLevel(state), places);
  }
  return places;
}

/**
 * The instance an engine rebuild was made from, for each instance {@link rebuild} made; see {@link originOf}.
 * A WeakMap, so it holds no instance alive.
 */
const rebuiltFrom = new WeakMap<StateInstance, StateInstance>();

/**
 * The instance a reducer (or the target's initial props) built, of which `x` is `x` itself or an engine rebuild
 * that only swapped nested states. Two instances of one origin differ only in their nested states, so the
 * diff gives the node no update call.
 */
export function originOf(x: StateInstance): StateInstance {
  return rebuiltFrom.get(x) ?? x;
}

/**
 * A new instance of `base`'s variant with `base`'s props and, at each given position, the given nested state;
 * every position must hold a nested state in `base`. It runs no user code, so it cannot throw where a step has no
 * branch for a throw: the props passed the parser and sealProps when `base` was built, so they are copied by their
 * descriptors, a getter as a getter and none called, onto an object with the prototype the parser's output had,
 * which the factory requires to be Object.prototype or null. An Items position is swapped with
 * {@link replaceItem}, which keeps the Items' order and runs no key function, and the instance is made by
 * {@link instantiate}, as the factory makes it. The result has `base`'s origin.
 */
export function rebuild(base: StateInstance, subs: ReadonlyArray<readonly [Position, StateInstance]>): StateInstance {
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(base);
  // instantiate defined these on `base` and defines them on the copy anew.
  for (const own of [Symbol.toStringTag, Symbol.toPrimitive, VARIANT]) {
    delete descriptors[own];
  }
  for (const [position, child] of subs) {
    // A position is a data property (see heldIn), so its descriptor holds the nested state or the Items.
    const held: unknown = descriptors[position.prop].value;
    descriptors[position.prop] = {
      value: "key" in position ? replaceItem(held as Items<AnyDefinition, unknown>, position.key, child) : child,
      enumerable: true,
    };
  }
  const result = instantiate(base[VARIANT], Object.create(Object.getPrototypeOf(base), descriptors));
  rebuiltFrom.set(result, originOf(base));
  return result;
}

/**
 * `snapshot` with `x` at `path`, frozen. The nodes above `path` are rebuilt around it (see {@link rebuild}), so
 * they keep their origin. Every position of `path` must hold a nested state in `snapshot`. When `x` is the node
 * there already, nothing changes: the result is `snapshot` itself.
 */
export function replaceAt(snapshot: FlowSnapshot, path: Path, x: StateInstance): FlowSnapshot {
  if (instanceAt(snapshot, path) === x) {
    return snapshot;
  }
  const replaceIn = (node: StateInstance, depth: number): StateInstance => {
    if (depth === path.positions.length) {
      return x;
    }
    const position = path.positions[depth];
    return rebuild(node, [[position, replaceIn(valueAt(node, position) as StateInstance, depth + 1)]]);
  };
  return Object.freeze({ ...snapshot, [path.state]: replaceIn(snapshot[path.state], 0) });
}

/**
 * The node `d` as a face of the reducers' answers composes it: `pick` of its own
 * answer, or else `held`, what its composed parent holds at its position (the committed node at the top
 * level), with each decided node below composed into it at its position. So an answer below lands inside
 * whatever an answer above it put there, and a node an answer above replaced stays replaced. Every position of
 * `d.below` exists in the base: the plan's conflict check ({@link findLostAnswer}) passed first.
 */
export function compose(d: Decided, pick: (answer: Answer) => StateInstance, held: StateInstance): StateInstance {
  const base = d.answer !== null ? pick(d.answer) : held;
  const subs: Array<[Position, StateInstance]> = [];
  for (const { position, decided } of d.below) {
    const was = valueAt(base, position) as StateInstance;
    const composed = compose(decided, pick, was);
    if (composed !== was) {
      subs.push([position, composed]);
    }
  }
  return subs.length > 0 ? rebuild(base, subs) : base;
}

/** The snapshot `C` with every decided top-level state composed (see {@link compose}), frozen. */
export function face(
  C: FlowSnapshot,
  decided: ReadonlyMap<string, Decided>,
  pick: (answer: Answer) => StateInstance,
): FlowSnapshot {
  const composed: Record<string, StateInstance> = { ...C };
  for (const [state, d] of decided) {
    composed[state] = compose(d, pick, C[state]);
  }
  return Object.freeze(composed);
}

/**
 * The first node below `d`, at any depth, whose own reducer answered and which `x`, what a reducer answered for `d`'s
 * node, does not hold at that node's position as the instance its reducer ran on; null when `x` keeps every one.
 * `x` may replace a node on the way that did not answer, as long as the replacement holds the answered node, so
 * the answer below still lands in it. Removing that node, or the answered one, or holding a copy of it,
 * loses the answer: two reducers would decide one state.
 */
export function findLostAnswer(x: StateInstance | undefined, d: Decided): Decided | null {
  for (const { position, decided } of d.below) {
    const held = valueAt(x, position);
    if (decided.answer !== null) {
      // Holding the answered node itself keeps everything below it as well.
      if (held !== decided.answer.before) {
        return decided;
      }
    } else {
      const lost = findLostAnswer(held, decided);
      if (lost !== null) {
        return lost;
      }
    }
  }
  return null;
}

/**
 * The path of the first node at or below `before`, the node at `path` before a step, that the step changed and that
 * `x`, another state's answer to a named result built from `before`, would decide again; null when there is none.
 * `cur` is the node at `path` as the step left it. A node the step left as it was (`cur` is `before`) has nothing to
 * lose. A node it removed, or gave an instance of another origin (a reducer's, not a rebuild around its nested states),
 * the step decided, so an answer there would decide that state twice. Below a node the step only rebuilt, a child that
 * `x` keeps as `before` holds it loses nothing, since adopt brings the step's version in; one that `x` replaced or
 * dropped is looked at the same way, as `x`'s own child.
 */
export function findLostChange(
  x: StateInstance | undefined,
  before: StateInstance,
  cur: StateInstance | undefined,
  path: Path,
): Path | null {
  if (cur === before) {
    return null;
  }
  if (cur === undefined || originOf(cur) !== originOf(before)) {
    return path;
  }
  for (const position of childPositions(before)) {
    const child = valueAt(before, position) as StateInstance;
    const kept = valueAt(x, position);
    const lost = kept === child ? null : findLostChange(kept, child, valueAt(cur, position), below(path, position));
    if (lost !== null) {
      return lost;
    }
  }
  return null;
}

/**
 * Whether each instance asked about is in a transitional variant or holds a node in one, at any depth. An instance is
 * frozen and holds the same nested states for life, so the answer never changes. A WeakMap, so it holds no instance
 * alive.
 */
const transitionalWithin = new WeakMap<StateInstance, boolean>();

/** Whether `x` or a node below it, at any depth, is in a transitional variant (see {@link transitionalWithin}). */
function holdsTransitional(x: StateInstance): boolean {
  let holds = transitionalWithin.get(x);
  if (holds === undefined) {
    holds =
      x[VARIANT][IS_TRANSITIONAL] ||
      childPositions(x).some((position) => holdsTransitional(valueAt(x, position) as StateInstance));
    transitionalWithin.set(x, holds);
  }
  return holds;
}

/**
 * The path of the first node in a transitional variant at or below `next`, the node at `path`, in pre-order; null when
 * there is none. `prev` is the node at `path` in the snapshot `next` was made from, undefined for none. Where `next` is
 * that same instance, the walk goes below it only when it holds a transitional node (see {@link holdsTransitional}),
 * as a committed snapshot can: an aborted transition's temp, or a temp kept because the step after it threw. A new
 * instance enters the memo only when a later dispatch finds it unchanged: writing every new instance measured slower.
 * With `strict` the walk never goes below an instance `next` keeps from `prev`: `next` is another state's answer to a
 * named result, built from `prev` as it was before the step, and what it keeps of it is not its decision, since the
 * step's own version of that node takes its place (see {@link adopt}).
 */
export function findTransitional(
  prev: StateInstance | undefined,
  next: StateInstance,
  path: Path,
  strict = false,
): Path | null {
  if (prev === next && (strict || !holdsTransitional(next))) {
    return null;
  }
  if (next[VARIANT][IS_TRANSITIONAL]) {
    return path;
  }
  for (const position of childPositions(next)) {
    const found = findTransitional(
      valueAt(prev, position),
      valueAt(next, position) as StateInstance,
      below(path, position),
      strict,
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** A node a step enters in an asynchronous variant: where, and the instance entered. */
export type AsynchronousEntry = { path: Path; entered: StateInstance };

/**
 * The first node that the step from `prev` to `next`, the node at `path` before and after, enters in an asynchronous
 * variant, in pre-order; null when it enters none. A step enters a node where it puts another variant, of the node's
 * definition or of another, or fills an empty position (see {@link diffNode}); the same instance enters nothing, here
 * or below. A node in an asynchronous variant is entered only as the next of a declared transition, whose work is its
 * transition handlers.
 */
export function findAsynchronousEntry(
  prev: StateInstance | undefined,
  next: StateInstance,
  path: Path,
): AsynchronousEntry | null {
  if (next[VARIANT][IS_ASYNC] && prev?.[VARIANT] !== next[VARIANT]) {
    return { path, entered: next };
  }
  if (prev === next) {
    return null;
  }
  for (const position of childPositions(next)) {
    const found = findAsynchronousEntry(
      valueAt(prev, position),
      valueAt(next, position) as StateInstance,
      below(path, position),
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** {@link findAsynchronousEntry} over every top-level state of `to`, from the same state of `from`, in `to`'s order. */
export function findAsynchronousEntryIn(from: FlowSnapshot, to: FlowSnapshot): AsynchronousEntry | null {
  for (const state of Object.keys(to)) {
    const found = findAsynchronousEntry(from[state], to[state], topLevel(state));
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** {@link findTransitional} over every top-level state of `to`, from the same state of `from`, in `to`'s order. */
export function findTransitionalIn(from: FlowSnapshot, to: FlowSnapshot): Path | null {
  for (const state of Object.keys(to)) {
    const found = findTransitional(from[state], to[state], topLevel(state));
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * `x`, an instance a reducer built from `built`, with what it shares with `built` taken from `cur`, `built` as a step
 * committed it: there the answers below it and the named results folded into them stand in place. So a child the
 * reducer kept as it was (`...s`) comes as it stands in `cur`, and a node the reducer built anew stays, with the same
 * rule applied below it. When `x` is `built` itself, it is `cur`. Where `cur` holds no node at a position of `x` (a
 * failed face that dropped it), `x`'s own child stays. Runs no user code.
 */
export function adopt(x: StateInstance, built: StateInstance, cur: StateInstance): StateInstance {
  if (x === built) {
    return cur;
  }
  const subs: Array<[Position, StateInstance]> = [];
  for (const position of childPositions(x)) {
    const child = valueAt(x, position) as StateInstance;
    const builtChild = valueAt(built, position);
    const curChild = valueAt(cur, position);
    const adopted = builtChild === undefined || curChild === undefined ? child : adopt(child, builtChild, curChild);
    if (adopted !== child) {
      subs.push([position, adopted]);
    }
  }
  return subs.length > 0 ? rebuild(x, subs) : x;
}

/**
 * Adds to `diff` what the step from `prev` to `next`, the node at `path` before and after, does there and below:
 * the same instance does nothing, here or below. Another instance of the same variant updates, unless both are
 * of one origin, an engine rebuild around changed nested states. Another variant of the same definition exits
 * `prev` and enters `next`, whose `prev` is the instance it replaces. Anything else (a
 * position that appears or empties, another definition at a position) exits `prev` if there is one and enters
 * `next` with no `prev` if there is one. Then the positions of `prev`, and those only `next` has, in order.
 * Calls and changes come in pre-order: the caller reverses each tree's exits so children exit first.
 */
export function diffNode(
  prev: StateInstance | undefined,
  next: StateInstance | undefined,
  path: Path,
  key: unknown,
  diff: TreeDiff,
): void {
  if (prev === next) {
    return;
  }
  const name = pathName(path);
  diff.changes.push({ path, stateName: name, old: prev, next });
  if (prev !== undefined && next !== undefined && prev[VARIANT] === next[VARIANT]) {
    if (originOf(prev) !== originOf(next)) {
      diff.update.push({ path, name, instance: next, prev, key });
    }
  } else if (prev !== undefined && next !== undefined && prev[VARIANT][DEF] === next[VARIANT][DEF]) {
    diff.exit.push({ path, name, instance: prev, prev, key });
    diff.enter.push({ path, name, instance: next, prev, key });
  } else {
    if (prev !== undefined) {
      diff.exit.push({ path, name, instance: prev, prev, key });
    }
    if (next !== undefined) {
      diff.enter.push({ path, name, instance: next, prev: undefined, key });
    }
  }
  for (const position of childPositions(prev)) {
    const at = below(path, position);
    diffNode(valueAt(prev, position), valueAt(next, position), at, positionKey(position), diff);
  }
  for (const position of childPositions(next)) {
    if (valueAt(prev, position) === undefined) {
      diffNode(undefined, valueAt(next, position), below(path, position), positionKey(position), diff);
    }
  }
}
