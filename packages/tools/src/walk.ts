import {
  addFlowTap,
  DisposableBox,
  type FlowConfig,
  Items,
  isState,
  lock,
  type Signal,
  StateFlowError,
  type StateInstance,
  settled,
  stateVar,
  TransitionAborted,
} from "@state-flow/core";
// index.ts re-exports this module; the cycle is safe, as this module uses what it imports only inside its functions.
import { handlersOff, printStates, TestClock } from ".";
import { statesOf } from "./print";

/** The states a new object starts from, by state name, as FlowConfig.start takes them. */
type WalkStart = Record<string, StateInstance>;

/**
 * One thing that can happen to the object: a call of its public methods, or a fact the world states, which returns the
 * signal that states it, or null where it does not apply (a step that then does nothing). A fact is what holds in the
 * world, which the world may say again: told again, it must commit nothing, since a commit, of an equal instance too,
 * calls the variant's handlers again. A fact marked `stale` is one the object must not take at all, as the answer to a
 * request it gave up. How the walk tells and checks both is in walk's doc. A signal whose reducer commits each time it
 * is told (a tick, a progress, a removal that builds a new collection) is no fact: send it from a call. A reducer that
 * answers a repeated fact with equal props commits too, unless the flow itself counts an equal answer as no change
 * (FlowConfig.equalAnswers "value", which compares a nested state and a collection by identity only); the builder
 * passes the setting the flow ships with, since one added for the walk alone hides the commits its users get. A throw
 * from a call's own code counts as the object's. Only the walk moves the clock: an action whose world answers later
 * sets a timer on the flow's timers, which the builder got, and never waits on the clock itself (advance, idle, send),
 * or its step may be checked before it ended and fail "settles".
 */
type WalkAction<T> = { call(object: T): unknown; stale?: never } | { fact(object: T): Signal | null; stale?: boolean };

/** What the walk drives. */
export interface WalkSubject<T extends object> {
  /**
   * A new object, the target of its flow, whose flow takes `flow` as its config (applyFlow's last argument) as it is:
   * its start states and its timers, a TestClock. The first object gets no start states, so every state starts as
   * usual.
   */
  build(flow: FlowConfig & { timers: TestClock }): T;
  /** By name; a path names actions by them. */
  actions: Record<string, WalkAction<T>>;
  /** By name; each holds on a state when it returns true. */
  invariants: Record<string, (object: T) => boolean>;
  /** How far each step moves the clock, in ms, once its action started: the bound of a world that stays silent. */
  stepTime: number;
}

/** The first check that failed and the actions from the first state that make it fail. */
interface WalkFailure {
  check: string;
  path: string[];
}

/** A state reached: its print, the states a new object starts from there, and the actions that reach it. */
interface Reached {
  print: string;
  start: WalkStart;
  path: string[];
}

/** The action that gives the first state: the builder's object, after nothing happened to it. */
const nothing = { call() {} };

/**
 * `value` with each DisposableBox replaced by a DisposableBox of a stand-in for its value, at any depth of nested
 * states and Items; every state instance is built anew by its variant's factory. The engine disposes a boxed value
 * once for all flows and refuses a state that holds one it disposed (SF028), and another object started from the same
 * state may have dropped, and so disposed, a value this one still holds. The stand-in is a Proxy: a new object that
 * reads as the value does, its keys and array-ness included, and whose dispose does nothing. The box stays a
 * DisposableBox, as the prop's type and a state's parser may require, and the print writes it as it writes the value.
 */
function withInertBoxes(value: unknown): unknown {
  if (value instanceof DisposableBox) {
    const inert = new Proxy(value.deref() as object, {
      get: (target, key) => (key === Symbol.dispose ? () => {} : Reflect.get(target, key)),
    });
    return DisposableBox.of(inert as Disposable);
  }
  if (value instanceof Items) {
    let items = value;
    for (const [key, item] of value) {
      const fresh = withInertBoxes(item) as never;
      // A map takes with(key, item) and a keyed set with(item), throwing SF003 for the other form; Items has no
      // public way to tell the two apart.
      try {
        items = items.with(key, fresh);
      } catch {
        items = items.with(fresh);
      }
    }
    return items;
  }
  if (isState(value)) {
    return stateVar(value)(Object.fromEntries(Object.entries(value).map(([key, prop]) => [key, withInertBoxes(prop)])));
  }
  return value;
}

/**
 * `states`, by state name, each with every DisposableBox at any depth replaced by a DisposableBox of a new stand-in for
 * its value (see withInertBoxes), so that a new object can start from states another object holds or held: whatever
 * either object drops, the engine disposes only the stand-in, whose dispose does nothing.
 */
export function inertStates(states: WalkStart): WalkStart {
  // A cast: withInertBoxes gives a state instance for a state instance.
  return Object.fromEntries(
    Object.entries(states).map(([name, instance]) => [name, withInertBoxes(instance)]),
  ) as WalkStart;
}

/**
 * One step: a new object started from `start` with handlers off, `action` applied, and the checks walk's doc names.
 * Returns the state reached or the failure.
 */
async function step<T extends object>(
  subject: WalkSubject<T>,
  start: WalkStart,
  action: WalkAction<T>,
  path: string[],
): Promise<Reached | WalkFailure> {
  using _off = handlersOff();
  try {
    const clock = new TestClock();
    // The errors handlers gave: with handlers off a handler that ran is a mock, and its Error is the world's answer.
    const worlds = new WeakSet<Error>();
    // The targets a step of which ended in an Error of the engine's or a reducer's own: neither one a handler gave nor
    // a TransitionAborted, the timeout of a world that stayed silent. By target: the tap hears every flow of the page,
    // and the object's own dispatches while it is built.
    const failed = new WeakSet<object>();
    // How many nodes each target's steps have committed.
    const commits = new WeakMap<object, number>();
    using tap = new DisposableStack();
    tap.defer(
      addFlowTap({
        dispatched() {},
        handled(_target, _kind, _call, { error }) {
          if (error !== null) {
            worlds.add(error);
          }
        },
        ended(target, { result: { error }, changes }) {
          commits.set(target, (commits.get(target) ?? 0) + changes.length);
          if (error !== null && !(error instanceof TransitionAborted) && !worlds.has(error)) {
            failed.add(target);
          }
        },
      }),
    );
    const object = subject.build({
      start: inertStates(start),
      timers: clock,
    });
    const signal = "fact" in action ? action.fact(object) : null;
    let lastTellingCommitted = false;
    const act = async () => {
      if ("call" in action) {
        await action.call(object);
      } else if (signal !== null) {
        await using send = await lock(object);
        for (const _telling of action.stale ? [1] : [1, 2]) {
          const before = commits.get(object) ?? 0;
          await send(signal).done();
          lastTellingCommitted = (commits.get(object) ?? 0) > before;
        }
      }
    };
    let ended = false;
    let refusedOnly = true;
    void act()
      .catch((error: unknown) => {
        refusedOnly = error instanceof StateFlowError && error.code === "SF066";
      })
      .then(() => settled(object))
      .then(() => {
        ended = true;
      });
    await clock.advance(subject.stepTime);
    if (!ended) {
      return { check: "settles", path };
    }
    if (!refusedOnly) {
      return { check: "throws only a refusal", path };
    }
    if (failed.has(object)) {
      return { check: "no engine Error", path };
    }
    if (lastTellingCommitted) {
      return { check: "a repeated or stale fact changes nothing", path };
    }
    for (const [name, holds] of Object.entries(subject.invariants)) {
      if (!holds(object)) {
        return { check: name, path };
      }
    }
    return { print: printStates(object), start: statesOf(object), path };
  } catch {
    return { check: "nothing throws outside the action", path };
  }
}

/** The generator mulberry32: each call returns the next draw, an unsigned 32-bit integer. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * Walks `subject` with every handler off: breadth first to `options.depth` actions, then `options.runs` random runs of
 * `options.runLength` actions each from the first state; it stops at the first failure.
 *
 * A step builds a new object from the states it starts from, on a TestClock of its own at time 0, each DisposableBox
 * of them holding a stand-in of its value (see withInertBoxes); computes the action's signal, for a fact; starts the
 * action (a fact's signal is sent under one lock, twice, or once when it is stale, each send awaited to its end);
 * moves the clock `subject.stepTime` ms (TestClock.advance); and checks, in this order, naming the first that
 * fails:
 * - "settles": the action ended and `settled()` resolved. With handlers off a transition has no work and ends inside
 *   its send, so only a transition mock that does not answer keeps one pending: it fails here, or, when its timeout
 *   falls within `stepTime`, ends at it (SF035) as a world's failure;
 * - "throws only a refusal": the action threw nothing but expect()'s refusal, a StateFlowError of code SF066;
 * - "no engine Error": no step of the object, a muted one and one made while it was built included, ended in an Error
 *   of the engine's or a reducer's own. With handlers off only a mock runs, so an Error a handler gave is the world's
 *   answer, and a TransitionAborted is the timeout of a world that stayed silent: an object handles both. An Error
 *   that merges a handler's with a reducer's counts, and so do two handlers' Errors merged in one step;
 * - "a repeated or stale fact changes nothing": the last telling, a fact's second or a stale fact's only one,
 *   committed nothing: no step of the object that ended between that send and the end its `done()` awaits, a
 *   transition's end included, lists a change (FlowTapStep.changes);
 * - each invariant, by its name, in the order of their keys, after the checks above.
 * A throw outside the action, from the builder, a fact's function, a timer's callback, an invariant or the print,
 * fails the step where it happens as "nothing throws outside the action".
 *
 * The report: `seed` as the generator took it; `states` counts the prints seen; `steps` the steps taken (the first
 * state's, those of facts that did not apply, and one that failed, included); `depth` the longest path of a step;
 * `fixedPoint` whether breadth first reached every state there is before its bound; `failure` the first failure, null
 * when none: breadth first, its path is a shortest one; in a random run, the path the run took.
 * `walkPath(subject, failure.path)` runs that path alone and fails alike.
 *
 * Limits. Time and timers do not carry from a step to the next: a timer still pending when a step ends is gone. The
 * walk forks states, not the world: a boxed value is one value for every object started from a state that holds it,
 * so an action that changes such a value itself, outside a handler, changes it for all of them, and its path may not
 * fail alone; and the engine never disposes a value a step started with, only one the step itself boxed. A stand-in
 * is made per DisposableBox, so a value the states hold both in one and elsewhere is one number in the print of the
 * step that boxed it and two in every later step's, and `states` counts both prints.
 *
 * The order, for an implementation that must take the same steps given the same subject and seed. States are told
 * apart by their canonical print (docs/canonical-print.md). Actions and invariants go in the order of their record's
 * keys, as ECMAScript's Object.keys gives them: names that are array indices (canonical decimal integers below
 * 2^32 - 1) first, ascending, then the others in the order they were written. The first state is the builder's
 * object after nothing happened. Breadth first: states are expanded in the order they were first reached, each by
 * trying every action in order; a state whose print was not seen before is queued; a state `depth` actions from the
 * first is not expanded. It is a fixed point when no queued state is `depth` actions from the first. Random: the
 * generator is mulberry32, seeded once per walk with ToUint32(seed) (truncated toward zero, then modulo 2^32); each
 * draw, in 32-bit wrapping arithmetic, is `s = s + 0x6d2b79f5; t = imul(s ^ (s >>> 15), s | 1);
 * t = (t + imul(t ^ (t >>> 7), t | 61)) ^ t; draw = (t ^ (t >>> 14)) >>> 0`, so seed 1 draws 2693262067, 11749833,
 * 2265367787 first. Run 0 draws first, then run 1, and so on. Each run starts at the first state; each of its
 * `runLength` turns takes action number `draw mod n` of the subject's n actions from where the run stands and moves
 * to the state it reaches. With no actions, a run takes no turn and draws nothing.
 */
export async function walk<T extends object>(
  subject: WalkSubject<T>,
  options: { depth: number; runs: number; runLength: number; seed: number },
) {
  const seed = options.seed >>> 0; // ToUint32
  const report = { seed, states: 0, steps: 0, depth: 0, fixedPoint: false, failure: null as WalkFailure | null };
  const seen = new Set<string>();
  const actions = Object.entries(subject.actions);
  // One step, counted; returns the state reached and whether its print is new, or null on a failure.
  const take = async (start: WalkStart, action: WalkAction<T>, path: string[]) => {
    const result = await step(subject, start, action, path);
    report.steps += 1;
    report.depth = Math.max(report.depth, path.length);
    if ("check" in result) {
      report.failure = result;
      return null;
    }
    const isNew = !seen.has(result.print);
    seen.add(result.print);
    report.states = seen.size;
    return { reached: result, isNew };
  };
  const first = await take({}, nothing, []);
  if (first === null) {
    return report;
  }
  const queue = [first.reached];
  // A for-of over an array also visits the elements pushed while it runs: the queue grows as it is expanded.
  for (const from of queue) {
    for (const [name, action] of from.path.length < options.depth ? actions : []) {
      const taken = await take(from.start, action, [...from.path, name]);
      if (taken === null) {
        return report;
      }
      if (taken.isNew) {
        queue.push(taken.reached);
      }
    }
  }
  // Breadth first queues states in the order of their paths' lengths, so the last one queued is the farthest; the
  // queue holds the first state at least.
  report.fixedPoint = (queue.at(-1) as Reached).path.length < options.depth;
  const draw = mulberry32(seed);
  for (let run = 0; run < options.runs; run++) {
    let at = first.reached;
    for (let turn = 0; turn < options.runLength && actions.length > 0; turn++) {
      // The index is below the length.
      const [name, action] = actions[draw() % actions.length] as (typeof actions)[number];
      const taken = await take(at.start, action, [...at.path, name]);
      if (taken === null) {
        return report;
      }
      at = taken.reached;
    }
  }
  return report;
}

/**
 * Runs `path`, names of `subject`'s actions, alone from the first state, each step as the walk takes it; returns the
 * first failure, or null.
 */
export async function walkPath<T extends object>(
  subject: WalkSubject<T>,
  path: readonly string[],
): Promise<WalkFailure | null> {
  let result = await step(subject, {}, nothing, []);
  for (const name of path) {
    if ("check" in result) {
      return result;
    }
    // A path names actions of the subject.
    result = await step(subject, result.start, subject.actions[name] as WalkAction<T>, [...result.path, name]);
  }
  return "check" in result ? result : null;
}
