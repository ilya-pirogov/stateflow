import {
  Box,
  DisposableBox,
  defineSignal,
  disposeFlow,
  type FlowConfig,
  FrozenMap,
  FrozenSet,
  HandlerResult,
  type Items,
  lock,
  mockHandlers,
  type StateInstance,
  type StateVariant,
  settled,
  sync,
} from "@state-flow/core";
import { handlersOff, TestClock } from "./index";
import { type Call, type Recorded, recordSessions, type Step } from "./recorder";

/**
 * What stands for a boxed value or a referenced one: a class, so the print writes it as a reference again. Its dispose
 * does nothing, so a DisposableBox can hold it. It holds nothing else, as a record holds nothing of the value.
 */
class StandIn {
  [Symbol.dispose](): void {}
}

/**
 * Replays `record` (docs/session-record.md; recordSessions writes it) on the object `build` returns, with every
 * handler off. `differences` lists every difference between the replay's record and `record`, in the order of the
 * session: the start states, then each step (whether it was an abort, its handler calls, the observers that fired, its
 * signal, payload, or the states at its dispatch), and the states at the end. An empty list means none. A step's
 * states are those its dispatch found, so a changed commit is named by the step after it, or by the states at the end.
 * `replayed` is the replay's own record, as recordSessions writes one: what the object did this time, for a caller
 * that checks the states it reached, since the object itself is disposed by then.
 *
 * `definitions` are every definition the flow holds, nested ones too: the record names each variant and each Items'
 * definition, and they are looked up here. `build` gets the flow's config to pass to applyFlow: the record's start
 * states rebuilt, as `FlowConfig.start` takes them, and a new TestClock as its timers, which this drives. A boxed or
 * referenced value in those states is a stand-in that holds nothing. When the object's own code reads such a value
 * outside a reducer (an observer's callback, an event's payload), `build` first gives the stand-in what that code
 * reads, with `Object.assign(box.deref(), members)`: the stand-in stays the one object its number names. Dispatches
 * the object makes while it is built stand for the record's first steps and are compared, not sent again; the rest
 * are sent in order under one lock held for the whole replay, so nothing the object starts on its own sends in
 * between. When an abort is sent, how the clock moves and how each handler call is answered are in the format file's
 * Replay and Time. The object is disposed (`disposeFlow`) once it is at rest, while handlers are still off, so nothing
 * it set to run later runs after.
 *
 * @throws Error before anything runs, naming the reason: the record's `cannotReplay` is set, or the record names a
 *   variant or a definition that `definitions` does not hold (one renamed since the recording). Rejects with what a
 *   step's dispatch throws on replay, as a dispatch that threw in the session (a string form that throws) does again.
 */
export async function replay(
  record: string,
  definitions: readonly object[],
  build: (flow: FlowConfig & { timers: TestClock }) => object,
): Promise<{ differences: string[]; replayed: string }> {
  const recorded = JSON.parse(record) as Recorded;
  if (recorded.cannotReplay !== null) {
    throw new Error(`replay: cannot replay this record: ${recorded.cannotReplay}`);
  }
  const named = namesOf(definitions);
  const standIns = new Map<number, StandIn>();
  const start = decode(recorded.start, named, standIns) as NonNullable<FlowConfig["start"]>;
  // The recorded calls of each variant and kind, in the session's order: while the replay commits what the session
  // did, it makes the same calls in the same order, so each call of a mock takes the next one. A call sits in the
  // step last dispatched when the session told it, so a work's answer waits until the replay has sent that step:
  // `sent` resolves once it has, and a work answered right away would settle before an abort it answered.
  const queues = new Map<string, Array<[Call, Promise<void>]>>();
  const steps = recorded.steps.map((step) => {
    // assigned by the promise's executor, which runs at once
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    for (const call of decode(step.calls, named, standIns) as Call[]) {
      const queue = queues.get(`${call.kind} ${call.variant}`) ?? [];
      queue.push([call, sent]);
      queues.set(`${call.kind} ${call.variant}`, queue);
    }
    return { abort: step.abort, signal: step.signal, payload: decode(step.payload, named, standIns), markSent };
  });
  using _off = handlersOff();
  using mocks = new DisposableStack();
  for (const queue of queues.values()) {
    // a queue holds at least the call that made it
    const [{ kind, variant: id }] = queue[0] as [Call, Promise<void>];
    const variant: StateVariant = named(id);
    mocks.use(
      mockHandlers(variant, {
        // a transition handler returns a promise; any other must not
        [kind]:
          kind === "transition"
            ? async () => {
                const [call, sent] = queue.shift() ?? [];
                await sent;
                return answerOf(variant, call?.outcome);
              }
            : () => answerOf(variant, queue.shift()?.[0].outcome),
      }),
    );
  }
  using recording = recordSessions();
  const clock = new TestClock();
  const target = build({ start, timers: clock });
  // disposed when this returns, before handlers are on again (the stack ends before handlersOff's scope)
  mocks.defer(() => disposeFlow(target));
  const made = (JSON.parse(recording.record(target)) as Recorded).steps.length;
  for (const step of steps.slice(0, made)) {
    step.markSent();
  }
  let replayed: string;
  {
    // Asked for before the clock moves, so the replay is first in line for the lock. A transition the build started
    // holds the lock back until it ends, which the clock's moves bring about.
    const taking = lock(target);
    await settle(clock, sync(target));
    await using send = await taking;
    for (const step of steps.slice(made)) {
      // An abort was sent while the transition it aborts was pending: only what is due now runs before it, the
      // answers given to the step before it among them.
      await (step.abort ? clock.idle() : settle(clock, sync(target)));
      // a factory made here gives the signal its name, by which its reducers are found
      send(defineSignal<Record<string, unknown>>(step.signal)(step.payload as Step["payload"]), { abort: step.abort });
      step.markSent();
    }
    await settle(clock, sync(target));
    // Read while the lock is held: a send of the object's own that waited for the lock is not in it.
    replayed = recording.record(target);
  }
  // What the object queued behind the lock runs now, to its end, a transition it declares included, before the
  // dispose: a send to a disposed flow is refused, and a transition pending at the dispose is cut.
  await settle(clock, settled(target));
  return { differences: differences(recorded, JSON.parse(replayed) as Recorded), replayed };
}
/**
 * Moves `clock` from one timer to the next, each move after what is due ran, until `ended` resolves: the engine's
 * `sync(target)`, no transition pending, or its `settled(target)`, nothing left to deliver and the locks asked for
 * served. So a pending transition ends by its timeout, or an accepted abort by the end of its wait, as their timers
 * say, and no real time passes for the simulated time moved. A flow on other timers sets none on `clock` and ends on
 * its own time, which this waits for.
 */
async function settle(clock: TestClock, ended: Promise<void>): Promise<void> {
  let pending = true;
  void ended.then(() => {
    pending = false;
  });
  await clock.idle(); // the mocks' answers settle on microtasks, which idle runs before it returns
  for (let due = clock.nextDue; pending && due !== undefined; due = clock.nextDue) {
    await clock.advance(due - clock.now);
  }
  await ended;
}
/**
 * What each name in a record, a print or a list of handlers names: each definition of `definitions` by its name and
 * each variant by its id "<state>.<variant>", since a definition's own enumerable values are its variants and the
 * string form of each is that name or id. The function it returns throws for a name that none of them has.
 */
export function namesOf(definitions: readonly object[]): (name: string) => any {
  const byName = new Map<string, unknown>(
    definitions
      .flatMap((definition) => [definition, ...Object.values(definition)])
      .map((named) => [String(named), named]),
  );
  // `any`: whether a name is a definition's or a variant's is known only from where it is read
  return (name) => {
    if (!byName.has(name)) {
      throw new Error(`${name} is named, which the definitions given do not hold`);
    }
    return byName.get(name);
  };
}

/**
 * The value `print`, one canonical print (docs/canonical-print.md; printStates and printValue write it), holds, as a
 * flow takes it: a state rebuilt by its variant in `definitions` (every definition the print names, nested ones too),
 * an Items as its definition's, a variant as the one named, and each boxed or referenced value a new stand-in, one
 * per number, in a box of the kind written. Plain JSON is a print of itself, but for a key that starts with "$", which
 * the print writes with one more and this reads back with one less.
 * @throws Error naming a variant or a definition the print names that `definitions` do not hold
 */
export function parsePrint(print: string, definitions: readonly object[]): any {
  return decode(JSON.parse(print), namesOf(definitions), new Map());
}

/**
 * `value`, a part of a parsed record, as the flow takes it (docs/session-record.md); `named` gives what a name in it
 * names.
 */
function decode(value: unknown, named: (name: string) => any, standIns: Map<number, StandIn>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decode(item, named, standIns));
  }
  // null, a boolean, a number or a string: Object() wraps a primitive in a new object and returns an object as it is
  if (Object(value) !== value) {
    return value;
  }
  const x = value as Record<string, any>;
  // A form's tag is its first key: the print writes it first, and a key of the data that starts with "$" is written
  // with one more "$", so it is never a tag.
  switch (Object.keys(x)[0]) {
    case "$number":
      return Number(x.$number);
    case "$bigint":
      return BigInt(x.$bigint);
    case "$undefined":
      return undefined;
    case "$box":
      return Box.of(decode({ $ref: x.$box }, named, standIns));
    case "$disposableBox":
      return DisposableBox.of(decode({ $ref: x.$disposableBox }, named, standIns) as StandIn);
    case "$variant":
      return named(x.$variant);
    case "$ref": {
      const standIn = standIns.get(x.$ref) ?? new StandIn();
      standIns.set(x.$ref, standIn);
      return standIn;
    }
    case "$map":
      return new FrozenMap(decode(x.$map, named, standIns) as Array<[unknown, unknown]>);
    case "$set":
      return new FrozenSet(decode(x.$set, named, standIns) as unknown[]);
    case "$state":
      return named(x.$state)(decode(x.props, named, standIns));
    case "$items": {
      const entries = decode(x.$items, named, standIns) as Array<[unknown, StateInstance]>;
      const empty: Items<any, unknown> = named(x.of).items();
      return entries.reduce((items, [key, item]) => items.with(key, item), empty);
    }
  }
  // An object of data: a key the print wrote with one more "$" gets its own back.
  return Object.fromEntries(
    Object.entries(x).map(([key, held]) => [key.startsWith("$$") ? key.slice(1) : key, decode(held, named, standIns)]),
  );
}
/**
 * What a recorded handler call gave the flow, as a handler of `variant` returns it; for an unsettled work, a promise
 * that never settles.
 */
function answerOf(variant: StateVariant, outcome: Call["outcome"] | undefined): HandlerResult | Promise<never> {
  if (outcome == null) {
    return HandlerResult.ok();
  }
  if ("unsettled" in outcome) {
    return new Promise(() => {});
  }
  if ("named" in outcome) {
    const results = variant.results as Record<string, (data: unknown) => HandlerResult>;
    return (results[outcome.named] as (data: unknown) => HandlerResult)(outcome.data);
  }
  if ("rejected" in outcome) {
    return HandlerResult.rejected(outcome.rejected, outcome.data as Parameters<typeof HandlerResult.rejected>[1]);
  }
  throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
}
/** Each part where `replayed` differs from `recorded`, with both sides as JSON. */
function differences(recorded: Recorded, replayed: Recorded): string[] {
  const found: string[] = [];
  const compare = (where: string, was: unknown, is: unknown): void => {
    const [before, now] = [JSON.stringify(was), JSON.stringify(is)];
    if (before !== now) {
      found.push(`${where}:\n  recorded ${before}\n  replayed ${now}`);
    }
  };
  compare("start", recorded.start, replayed.start);
  for (let i = 0; i < Math.max(recorded.steps.length, replayed.steps.length); i++) {
    compare(`step ${i}`, recorded.steps[i], replayed.steps[i]);
  }
  compare("stop", recorded.stop, replayed.stop);
  return found;
}
