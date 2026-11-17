---
title: State Visibility
description: Understanding and debugging application state through comprehensive visibility features
---

Every instance has a readable string form, every dispatch writes a structured log entry, and observers, watches, events and subscribers are told of every commit. {% .lead %}

## String Representations

### Defining a String Form

`stringRepr` gives a state the string form of its props:

```typescript
const connectionSignals = { connect: defineSignal<{ url: string }>("connect") };

const connectionState = defineState<{ url: string; attempts: number; lastError: string | null }>()
  .name("connection")
  .signals(connectionSignals)
  .variant("disconnected", { initial: true })
  .variant("connecting")
  .variant("connected")
  .stringRepr((s) => (s.lastError === null ? `${s.url} (attempts: ${s.attempts})` : `${s.url} - ${s.lastError}`))
  .build();

String(connectionState.connecting({ url: "wss://api.example.com", attempts: 2, lastError: null }));
// "connection.connecting(wss://api.example.com (attempts: 2))"
```

An instance prints as `<state>.<variant>(<string form>)`, its variant as `<state>.<variant>` (`String(stateVar(instance))`), and a signal as `<name>{<payload>}`.

### The Default Serializer

Without `stringRepr`, the props print through `serializeDebug`, which keeps them short:

- props as `key=value`, separated by spaces, and a chain of single-key objects as one dotted key (`meta.source.id=7`);
- strings longer than 25 characters cut with `…`, and quoted with `'` when they hold a space or a bracket;
- arrays of more than 10 items as the first 10 and `…+N`, and data nested deeper than 3 levels as `{...}`;
- `T`, `F`, `N` and `U` for true, false, null and undefined;
- a `Box` as `Box(<displayName>#<n>)`, a nested state by its own string form, an `Items` as `Items(<size>){<key>=<instance> ...}`, a `Map` or a `Set` by its entries, an `Error` as `<name>(<message>)`, and any other class instance as `{<ClassName>}`.

```typescript
const dataState = defineState<{ title: string; items: number[]; meta: { source: { id: number } }; done: boolean }>()
  .name("data")
  .variant("loaded", { initial: true })
  .build();

String(
  dataState.loaded({
    title: "a title longer than twenty-five characters",
    items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    meta: { source: { id: 7 } },
    done: true,
  }),
);
// "data.loaded(title='a title longer than twent…' items=[1 2 3 4 5 6 7 8 9 10 …+2] meta.source.id=7 done=T)"
```

## Log Entries

### Entry Structure

Each dispatch delivers log entries to the flow's log handlers once it returns:

```typescript {% shorthand=true %}
interface StateFlowLogEntry {
  flowName: string; // the target's Symbol.toStringTag, or its constructor's name
  signal: string; // the signal's string form
  message: string; // "[SF/<flow>] <signal> - <result>"
  startTime: number;
  isAsync: boolean; // true on the end entry of a transition whose work was asynchronous
  duration?: number; // set with isAsync
  dispatchOrder?: number; // the order in which steps started, shared by every flow on the page
  transition?: "temp" | "final" | "failed"; // on the entries of a declared transition
  aborted?: string; // on an accepted abort's entry: the path of the node whose transition it aborted
  finalStates: Record<string, string>; // every top-level state after the step
  stateChanges: Array<{ stateName: string; oldState: string; newState: string }>;
  handlerResults: Array<{
    type: "enter" | "exit" | "update" | "commit" | "transition";
    handlerName: string;
    stateName: string;
    result: string;
  }>;
  observers: Array<{ observerName: string; stateName: string; needObserve: boolean; error?: string }>;
  finalResult: string; // the result's string form
  finalResultData?: {
    kind: string; // the ResultKind's name: "OK", "Ignored", "Rejected", "InTransition" or "Error"
    message: string | null; // an Ignored or Rejected result's message; null when it has none
    code: string | null; // the result's code (Result.code); null when it has none
    errors: Array<{ name: string; message: string }>; // an Error result's errors, at least one; none for any other kind
  };
  groupLabel?: string; // set under a labeled lock
  dispatchContext?: string; // set by a dispatch-context provider, under a labeled lock
}
```

### Reading an Entry

- **One entry per step.** A dispatch writes one, its failed step included. A declared transition writes one for its temp step (`transition: "temp"`, `finalResult` `InTransition`), also when the temp changes nothing, and one for its end (`"final"` or `"failed"`). An accepted abort writes one with `aborted` set. A muted dispatch (`send(signal, { mute: true })`) writes none, nor does a transition it declares.
- **State changes.** One per node that changed, named by its path (`media`, `media.transport`, `media.producers[cam]`), with `(none)` on the side where a nested position is empty. A step that commits shows what committed, named results folded in; a refused step shows what it attempted.
- **Handler results.** An enter, exit or update handler's result, or the error it threw; a named result prints as `OK(<name>)`. A `commit` result is a commit handler's (`OK`, or its error) or the error a commit delegate threw, named by the handler that returned it. A `transition` result, in the entry that ends a transition, is what the work settled to: its result, `unsettled at timeout`, `unsettled at failure`, or, in an abort's entry, `dropped after abort: <result>`. A work that settles after an abort's entry was written goes to `console.error`; after a timeout, a failure or `disposeFlow`, it is dropped.
- **Observers.** One per observer told of a node, named by the node's path, with whether its compare asked for its callback. Events and watches are here too, as `event:<name>` and `watch:<callback name>` (a named function finds its watch here), with `stateName` listing the top-level states the commit changed. A compare's or a predicate's throw is its `error`.
- **Order.** `dispatchOrder` is the order in which steps started, not the order of their commits: a handler's dispatch to another target starts after the outer step and commits before it. Entries are delivered in the order they finish.

`finalResult` starts with the kind for `OK`, `Ignored`, `Rejected` and `InTransition` (`"Rejected: <message>"`); an Error prints its error, which starts with the error's name (`"TypeError: ..."`), not with its kind. A program reads `finalResultData` instead of parsing that text: `kind` is the result's kind, `message` is what an Ignored or Rejected result carries, and `errors` lists an Error result's errors, at least one, by `name` and `message` (a missing name reads `"Error"`, a missing message `""`). Two Errors that merged are listed flat, in merge order; any other error, an `AggregateError` a handler threw included, is one item. `code` is the result's code, `null` where it has none, so a program reads a code without parsing a message (see [Error Types](/docs/api-reference#error-types)). A muted dispatch writes no entry, so no data, and an entry has no `finalResultData` when reading an error's name or message threw while it was built; its text is unaffected. The field is optional in the type because an entry built by hand or recorded by an older build has none; every other entry the engine delivers has it.

### Log Handlers

A flow's log handlers come from its config; without any, `consoleLogHandler` prints each entry. `addGlobalLogHandler` adds a handler that gets every flow's entries, and returns its remover:

```typescript
const reportFailures: StateFlowLogHandler = (entry) => {
  const kind = entry.finalResultData?.kind;
  if (kind === "Rejected" || kind === "Error") {
    errorReporter.report(entry.message, { signal: entry.signal, states: entry.finalStates });
  }
};

applyFlow(app, [connectionState], () => {}, { logHandlers: [consoleLogHandler, reportFailures] });

const recorded: StateFlowLogEntry[] = [];
const removeRecorder = addGlobalLogHandler((entry) => recorded.push(entry));
```

The console handler is silent under vitest; `setConsoleLogSilenced(false)` turns it on, and `null` restores the default. Its output for one entry:

```
[SF/MediaPlayer] play{} - OK
  State: media.paused(position=0 duration=180) => media.playing(position=0 duration=180)
  	enter startPlayback() => OK
  	observed by updateUi() => true

  Final States:
  	media: media.playing(position=0 duration=180)
```

Under a labeled lock, `lock(target, "play request")`, the entries of the critical section are held until the lock is released and then printed under one console group, each with `groupLabel` set. `setGlobalDispatchContextProvider(fn)` adds `fn()`, taken when such a lock is asked for, to those entries as `dispatchContext`.

## Observing Changes

Four ways to follow a flow, each told after the commit set every state. Their callbacks run on later turns of the flow's timers, and a throw from one is reported without touching the commit. `settled(target)` resolves once every delivery set so far has run.

### Observers of Named Variants

`observe` follows the variants it names, of top-level or nested states. The optional compare decides which changes call the callback, which gets the committed instance and the node's path:

```typescript
using onConnection = observe(app, [connectionState.connected], (state, path) => {
  console.log(`${path}: ${String(state)}`); // "connection: connection.connected(...)"
});

// Only when the attempts grow.
using onRetry = observe(
  app,
  [connectionState.connecting],
  (state) => console.warn(`attempt ${state.attempts}`),
  (prev, cur) => cur.attempts > prev.attempts,
);
```

A nested state's variants are observed the same way: the observer is told of every node of that state that changes into one of them, at any depth, each with its path. A node that appears at a position that held no instance of its state has nothing to compare, and its callback runs.

```typescript
const cam = defineState<{ id: string }>().name("cam").variant("off", { initial: true }).variant("live").build();
const rack = defineState<{ cams: Items<typeof cam> }>().name("rack").variant("up", { initial: true }).build();

const site = { rack: { cams: cam.items({ key: (c) => c.id }) } };
applyFlow(site, [rack], () => {});

using onLive = observe(site, [cam.live], (state, path) => console.log(`${path} is live`)); // "rack.cams[front] is live"
```

The target's type must hold each variant's state, which the types look for by name in the target's props. They cannot search the polymorphic `this` of a class: inside a class, pass the target typed as the class, `observe(this as Player, [cam.live], onLive)`.

### Watches on Any Condition

`watch` runs a predicate on the committed states and the states as of the commit before, and its callback when the predicate returns true. It is attached and released at any time:

```typescript
using onDrop = watch(
  app,
  (cur, prev) => stateVar(prev.connection) === connectionState.connected && stateVar(cur.connection) !== connectionState.connected,
  (cur) => console.warn(`connection lost: ${String(cur.connection)}`),
);
```

### Events of the Target

`sm.defineEvent(name, changed, payload?)`, in `applyFlow`'s initializer, makes a public event of the flow: after each commit where `changed(cur, prev)` returns true, the engine calls the target's own `emit(name)`, or `emit(name, payload(cur))` with a payload function, on a later timer turn. `applyFlow` throws when the target has no `emit`:

```typescript
import { EventEmitter } from "events";

class Client extends EventEmitter {
  readonly connection = { url: "", attempts: 0, lastError: null as string | null };

  constructor() {
    super();
    applyFlow(this, [connectionState], (sm) => {
      sm.defineEvent(
        "connected",
        (cur, prev) =>
          stateVar(cur.connection) === connectionState.connected && stateVar(prev.connection) !== connectionState.connected,
      );
      sm.defineEvent(
        "attempt",
        (cur, prev) => cur.connection.attempts > prev.connection.attempts,
        (cur) => cur.connection.attempts,
      );
    });
  }
}

const client = new Client();
client.on("attempt", (attempts: number) => console.log(`attempt ${attempts}`));
```

An event is defined once, with the flow; a watch comes and goes. Each evaluation of either is in the commit's entry under `observers`.

### Subscribers to Every Change

`subscribeFlow` delivers a `FlowChange` for every node that changed, each top-level state and then the nested nodes inside it, with the real instances before and after, the signal's string form and the entry's `dispatchOrder`. A subscriber has no way to dispatch or to change anything:

```typescript
using debug = subscribeFlow(app, (change) => {
  const where = change.path ?? change.stateName;
  console.log(`${where}: ${change.prevVariant} -> ${change.nextVariant} (${change.signal})`);
});
```

## Recording a Session

`addFlowTap` is for tools that record a flow to run it again, for instance with every handler off (see [Testing](/docs/testing#simulating-with-handlers-off)); application code follows a flow with the four ways above. Unlike them, a tap is told inside the step, before it commits and at its end, of the flow of every target on the page:

```typescript
const recording: string[] = [];
const removeTap = addFlowTap({
  dispatched: (target, signal) => {
    if (target === app) {
      recording.push(`signal ${String(signal)}`);
    }
  },
  handled: (target, kind, call, result) => {
    if (target === app) {
      recording.push(`${kind} ${call.name} ${ResultKind[result.kind]}`);
    }
  },
  ended: (target, step) => {
    if (target === app) {
      recording.push(`ended ${String(step.signal)} ${ResultKind[step.result.kind]}`);
    }
  },
});
```

`dispatched` is told of each dispatch before its reducers run, a muted one and one the reducers refuse or ignore included. `handled` is told of each exit, update, enter or transition handler's result, with the node's path in `call.name` and the data a refusal carries in `result.data`, which a recording keeps so that a replay can give the same refusal back; a transition handler's when its work settles, and a late answer after the transition's end committed. A commit handler is not told. `ended` is told once for each log entry a dispatch writes, a muted one's too, refused steps included, once the step and its commit handlers ran, with what it committed, the observers that fired and the works a transition's end or an accepted abort left unsettled. A tap cannot dispatch to the target or dispose it while it is told, as a handler cannot, and a throw from it goes to `console.error` without stopping the step. `removeTap()` stops it. See [addFlowTap](/docs/api-reference#add-flow-tap).

## Runtime Introspection

`isState(value)` tells an instance from any other value, `stateVar(instance)` gives its variant, and `isIn(instance, "a", "b")` whether it is in one of the named variants:

```typescript
function currentStates(target: Record<string, unknown>): Record<string, string> {
  const states: Record<string, string> = {};
  for (const [key, value] of Object.entries(target)) {
    if (isState(value)) {
      states[key] = String(value);
    }
  }
  return states;
}
```

What a flow is made of is listed as plain data: the variants, marks, signals and results of the definitions you name, and the handlers registered on a target. See [listStates and listHandlers](/docs/api-reference#list-states-and-list-handlers).

The running version is on the global object: `globalThis.__STATE_FLOW__.version`.

A log handler can keep a history of results:

```typescript
class SignalHistory {
  readonly entries: Array<{ signal: string; order: number | undefined; result: string }> = [];

  readonly handler: StateFlowLogHandler = (entry) => {
    this.entries.push({ signal: entry.signal, order: entry.dispatchOrder, result: entry.finalResult });
    if (this.entries.length > 100) {
      this.entries.shift();
    }
  };

  find(pattern: RegExp) {
    return this.entries.filter((entry) => pattern.test(entry.signal));
  }
}
```
