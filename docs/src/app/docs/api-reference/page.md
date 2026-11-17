---
title: API Reference
description: Complete API documentation for StateFlow
---

Every export of `@state-flow/core`: its shape, what it does, and the rules it enforces. {% .lead %}

## Core Functions

{% callout title="About the examples" %}
The examples are fragments. Names such as `app`, `signals` or `fetchManifest` stand for the application's own
definitions and functions. Signature blocks give an API's shape in shorthand.
{% /callout %}

### defineSignal

Creates a signal factory: the function that builds the signals a target is sent.

```typescript {% shorthand=true %}
function defineSignal<TArgs extends Record<string, unknown> | void = void>(
  name: string,
  stringRepr?: (args: TArgs) => string,
): SignalDefinition<TArgs>
```

- `name` keys the reducers that take the signal, and names it in log entries and in messages such as
  `aborted by <name>`.
- `stringRepr` is the payload's string form inside the signal's own, `name{payload}`; `serializeDebug` by default.
- `TArgs` is the payload: an object type, or `void` for none. A union of object types gives one factory that
  takes any member, and a reducer narrows the payload by its discriminant. A union of an object type with `void`
  (`{ reason: string } | void`) gives a signal without a payload.

```typescript
const refresh = defineSignal("refresh");
const assign = defineSignal<{ userId: string }>("assign");
const seek = defineSignal<{ by: "time"; time: number } | { by: "frame"; frame: number }>("seek");
const query = defineSignal<{ text: string; filters: string[] }>("query", (q) => `${q.text} +${q.filters.length}`);

refresh();
assign({ userId: "u1" });
seek({ by: "frame", frame: 25 });
query({ text: "cats", filters: ["new"] });
```

A state lists the signals it takes with `.signals({ ... })`, each under its own name, and a reducer runs for the
signal whose name is its key: two definitions with one name are one signal to the reducers.

### defineState

Starts a state definition.

```typescript {% shorthand=true %}
function defineState<TProps, TDefs = any>(): StateBuilder
```

`TProps` is the props type every variant shares. `TDefs` names the flow's definitions by state name
(`defineState<Props, PlayerStates>()`, a type-only import), which types `ctx.read` in the state's reducers (see
[Signal reducers](#signal-reducers)).

Builder methods:
- `.name(name)`: the target's property that holds the state, and its name in logs. Required.
- `.signals(signals)`: the signals the state takes, each under its name. Optional: a state without signals has
  no signal reducers.
- `.variant(name, options?)`: adds a variant.
- `.parser(fn)`: builds the props from what a factory is given. It must return a plain object (prototype
  `Object.prototype` or `null`), or the factory throws.
- `.stringRepr(fn)`: the string form of an instance's props, for `String(instance)` and the log.
- `.build()`: returns the definition.

```typescript {% unchecked="the options of .variant(), a type the engine does not export" %}
interface VariantOptions {
  initial?: boolean;      // the variant applyFlow starts the state in; one per state
  transitional?: boolean; // commits only as the temp of a declared transition
  async?: boolean;        // entered only as the next of a declared transition
  results?: Record<string, (data: unknown) => unknown>; // named results: name -> the parser of its data
}
```

- **`transitional`**: a reducer's answer that would leave a node in this variant is an Error, so a node leaves it
  when its transition ends: at next, at failed, or by an abort reducer. Its reducers are the abort reducers of the
  transitions that pass through it (see [Aborting a transition](#aborting-a-transition)). Its entry is synchronous.
- **`async`**: the variant's entry waits for the world. A node enters it only as the `next` of a declared
  transition, whose work is the variant's transition handlers. An ok answer, a temp or a failed that enters it is
  an Error, and `applyFlow` throws for an initial instance that holds one at any depth. Written as the literal
  `true`, the mark is in the variant's type, so `addTransitionHandler` and a transition mock compile only for
  such a variant.
- **`results`**: the variant's named results, the way the world's data reaches props. `build()` puts a factory per
  name on the variant: `driverState.active.results.loaded(data)` runs the parser at once (invalid data throws) and
  returns a [HandlerResult](#handler-result) that only this variant's enter, update and transition handlers may
  return. Each declared result needs a result reducer (see [defineFlow](#define-flow)). Every other state with a
  result reducer of that name takes the result too, so one definition of a flow declares a name.

`variant()` throws for a second initial variant, for `initial` with `transitional` or `async`, and for
`transitional` with `async`. `build()` throws when the state has no name or no variant, a variant is named
`items`, or a key of `.signals()` is not the name of the signal under it.

The definition holds a factory per variant: `taskState.draft(props)` builds a deep-frozen instance. A top-level
state's definition, called, reads its instance in a snapshot (`taskState(snapshot)`) or in the snapshot a reducer
runs on (`taskState(ctx)`), and throws when the snapshot holds no instance of this definition under its name.
`taskState.items(options?)` builds an empty [Items](#items).

```typescript
type TaskProps = { title: string; assignee: string | null; priority: "low" | "medium" | "high" };

const taskSignals = { assign, setPriority: defineSignal<{ priority: TaskProps["priority"] }>("setPriority") };

const taskState = defineState<TaskProps>()
  .name("task")
  .signals(taskSignals)
  .variant("draft", { initial: true })
  .variant("assigned")
  .stringRepr((t) => `${t.title} (${t.priority})`)
  // A parser gets what the factory was given and returns the props, here with defaults.
  .parser((obj) => {
    const o = obj as Partial<TaskProps>;
    return { title: o.title ?? "Untitled", assignee: o.assignee ?? null, priority: o.priority ?? "medium" };
  })
  .build();

type Manifest = { url: string; tracks: string[] };

const playerSignals = {
  play: defineSignal<{ url: string }>("play"),
  stop: defineSignal("stop"),
};

// A transitional variant, and an asynchronous one with a named result whose parser checks the world's data.
const driverState = defineState<{ url: string; manifest: Manifest | null; reason: string | null }>()
  .name("driver")
  .signals(playerSignals)
  .variant("idle", { initial: true })
  .variant("activating", { transitional: true })
  .variant("active", { async: true, results: { loaded: (data) => parseLoaded(data) } }) // returns { manifest }
  .variant("failed")
  .build();
```

### Items

A prop of a state may hold an instance of another state, or an `Items` of them: these are nested states.
Nothing declares them: the engine finds instances and Items in props by value, at any depth of the tree, and
nested states take signals and run handlers like top-level ones.

```typescript {% shorthand=true %}
class Items<TDef, K = string> implements ReadonlyMap<K, InstanceOf<TDef>> {
  with(key: K, item: InstanceOf<TDef>): Items<TDef, K>; // a map
  with(item: InstanceOf<TDef>): Items<TDef, K>;         // a keyed set
  without(key: K): Items<TDef, K>;
  // and ReadonlyMap's size, get, has, keys, values, entries, forEach and iterator
}

function definitionOf(items: Items): StateDefinition // the definition it holds instances of, an empty one's too
```

- `def.items()` builds an empty map of `def`'s instances; `def.items({ key: (item) => item.id })` an empty keyed
  set, which files each element under its key.
- An Items is immutable and reads as a `ReadonlyMap` in insertion order. `with` and `without` return a new one;
  `with` on a taken key keeps its place. A map takes `with(key, item)` only, a keyed set `with(item)` only, and
  both throw for an instance of another definition.

Rules of nested states:
- A nested state goes directly in a prop, as an instance or an Items. One inside other data (an array, a plain
  object, a `FrozenMap`, a `FrozenSet`) is refused when the instance holding it is built; the content of a `Box`
  is not looked at.
- The parent decides its children. After a dispatch the engine compares the old and the new tree position by
  position (props, then keys): the same variant with a new instance is an update, another variant an exit and an
  enter, a new position an enter (`prev` undefined), and a gone one an exit of it and of everything below it. The
  same instance runs nothing, and a node that changed only because a nested state in it changed gets no call.
- Exits run children first and later siblings first; updates and enters run parents first. The top-level states
  take their turns in the flow's order.
- The nested states of an initial instance get no enter, as the initial instance gets none.
- An element of a keyed set whose reducer changes its key is an Error.
- Logs and handler results name a nested node by its path: `media.transport`, `media.producers[cam]`.

```typescript
type Track = { id: string };
type RtpProducer = { close(): void };
type WireSocket = { close(): void };

const producerSignals = { pause: defineSignal<{ key: string }>("pause") };

const producer = defineState<{ track: Box<Track>; rtp: Box<RtpProducer> | null; paused: boolean }>()
  .name("producer")
  .signals(producerSignals)
  .variant("creating", { transitional: true })
  .variant("active", { async: true, results: { created: (data) => data as { rtp: Box<RtpProducer> } } })
  .variant("failed")
  .build();

// A state without signals, held once inside media.
const transport = defineState<{ socket: Box<WireSocket> | null }>()
  .name("transport")
  .variant("closed", { initial: true })
  .variant("open", { async: true, results: { opened: (data) => data as { socket: Box<WireSocket> } } })
  .build();

// The parent: its nested states are ordinary props.
const media = defineState<{ transport: InstanceOf<typeof transport>; producers: Items<typeof producer> }>()
  .name("media")
  .variant("idle", { initial: true })
  .variant("active")
  .build();

const session = {
  media: { transport: transport.closed({ socket: null }), producers: producer.items() },
};
applyFlow(session, [media], () => {});
```

### defineFlow

Defines the reducers of a variant, once: a second call on one variant throws.

```typescript {% shorthand=true %}
function defineFlow(variant, signalReducers): void;                 // a state that takes signals
function defineFlow(variant, signalReducers, resultReducers): void; // result reducers after the signal reducers
function defineFlow(variant, resultReducers): void;                 // a state without signals
```

What it takes follows the variant's definition: signal reducers when the state takes signals, then result
reducers, required when the variant declares named results. Two kinds of result reducer need no declaration: one
keyed `[FAILURE]`, which takes the failure that led to a failed state (see [Failed](#failed)), and one under
another state's result name, which takes that state's result (see [Result reducers](#result-reducers)). A variant
with neither signals nor named results takes the `[FAILURE]` reducer, and any other state's beside it.

#### Signal reducers

A signal reducer is `(state, signal, ctx) => props | instance | StateResult`: `state` is the instance the signal
reaches, typed as its props, `signal` the payload, and `ctx` a frozen `ReducerContext`:

```typescript {% shorthand=true %}
interface ReducerContext<TDefs = any> {
  readonly parent: StateInstance | undefined; // the parent's instance; undefined at the top level
  readonly key: unknown; // the key in the parent's Items; undefined at the top level and for a single nested state
  read(name: keyof TDefs): StateInstance; // a top-level state of the flow by name, typed by TDefs
}
```

- `ctx.read(name)` reads a top-level state of the flow in the reducer's snapshot, typed by the definitions the
  state declares (`defineState<Props, Defs>()`), and `isIn(instance, ...variants)` checks its variant by name: a
  state module reads a sibling with only a type import of its definition. A name the flow has no state of throws
  `No state <name> in the flow`, which is the reducer's Error.
- A top-level state's definition called on `ctx` reads that state too: `power(ctx).on`.
- A nested reducer reads its parent as `ctx.parent`, and its key only as `ctx.key`.

A reducer returns one of:
- props, which keep the node's variant;
- an instance of its own state, of any variant: the same as `StateResult.ok(instance)`;
- `StateResult.ok(next, failed?)` (see [Failed](#failed));
- `StateResult.transition(next, temp, failed, options?)`, an entry that waits for the world (see
  [StateResult.transition](#state-result-transition));
- `StateResult.ignored(message?)`, `StateResult.rejected(message)` or `StateResult.error(error)`; a throw is an
  Error.

Anything else (undefined, a `HandlerResult`, a promise, an instance of another state) is an Error.

**One signal, one snapshot.** A signal runs every reducer it reaches, top-level and nested, all on the frozen
snapshot from before the signal: no reducer sees another's answer to the same signal. Their verdicts merge (see
[Result](#result)): a Rejected or Error from any reducer refuses the dispatch, and nothing commits; otherwise every
answer commits together, in one step. With no answer the result is Ignored, `no reducer for <signal> in
<variants>` when no variant has a reducer for it. A reducer that returns the instance it was given changes
nothing, and with [`equalAnswers: "value"`](#apply-flow) neither does a next of its variant with equal props.
Two reducers that declare a transition in one dispatch are an Error.

**Children's answers land in their parent's.** A nested reducer's answer is put at its position in its parent's
answer. A parent that kept the child (the same object, through `...s`) or did not answer takes the child's answer.
A parent that replaced or removed a child whose own reducer answered too is an Error: two reducers would decide
one state.

**Pure and synchronous.** A dispatch, a `disposeFlow` or a `Box.deref()` inside a reducer throws, and a write to
`ctx` throws in strict-mode code; each is the reducer's Error. A returned promise is an Error.

```typescript
defineFlow(taskState.draft, {
  assign: (state, { userId }) =>
    userId === "" ? StateResult.rejected("a user id is required") : taskState.assigned({ ...state, assignee: userId }),
  setPriority: (state, { priority }) => ({ ...state, priority }),
});

// A nested reducer picks itself by its key: pause reaches every active producer.
defineFlow(
  producer.active,
  { pause: (p, { key }, ctx) => (ctx.key === key ? { ...p, paused: true } : StateResult.ignored()) },
  { created: (p, { rtp }) => ({ ...p, rtp }) },
);
```

A sibling read by name, in a module that imports only the types of the other definitions:

```typescript
type Defs = { safety: typeof safety; trigger: typeof trigger };
const gunSignals = { arm: defineSignal("arm"), fire: defineSignal("fire") };

const safety = defineState<{ armedBy: string }, Defs>()
  .name("safety")
  .signals(gunSignals)
  .variant("on", { initial: true })
  .variant("off")
  .build();

const trigger = defineState<{ shots: number }, Defs>()
  .name("trigger")
  .signals(gunSignals)
  .variant("idle", { initial: true })
  .variant("fired")
  .build();

defineFlow(trigger.idle, {
  fire: (s, _signal, ctx) => (isIn(ctx.read("safety"), "off") ? trigger.fired({ shots: s.shots + 1 }) : s),
});
```

#### Result reducers

A result reducer is `(next, data, ctx) => props | instance`: it folds a named result's data into the instance
being entered or updated, typed as its props, and returns props or an instance of the same variant.

An enter, update or transition handler of a variant may return one of its named results. A transition handler's
result folds into next before the transition's end step. An enter or update handler's result folds after the
enter phase into the instance the handler entered or updated, in the order the handlers returned them, the
update handlers' first, each on the last fold: those handlers saw the instance as the reducer declared it, and the
commit, the commit handlers and the observers see it folded. `ctx` reads the step's target as folded so far. In a
step into failed, the `[FAILURE]` result folds first.

A fold that cannot happen refuses the step as a handler's refusal does (see [Failed](#failed)): a named result of
another variant, a name without a reducer, or a reducer that returns another variant, throws, returns a promise or
changes a nested state.

**A named result is a fact of the flow.** A result reducer under a name its variant does not declare takes
another state's result of that name: `(state, data, ctx) => props | instance | StateResult`, with `data` typed
`never`, so the reducer writes out the type the declaring state's parser returns. When a handler returns a named
result, its own node folds it; then, in the same step, every node of every other state whose variant has such a
reducer runs it on the snapshot the step started from, as a signal's reducers run on the snapshot before the
signal. The answers commit with the step:
- Props, an instance of the node's own state or `StateResult.ok(next)` is an answer, and an Ignored answers
  nothing. A Rejected, an Error or a throw refuses the step; a transition or a failed is an Error.
- The step runs the handlers of the nodes the answers change: a transition's end step with its own, and after an
  enter or update handler's result a further round of the same step, exits, then updates, then enters, whose own
  named results are taken in turn; the step commits once nothing more takes one.
- The rules of a signal's answers hold, and an answer for a node the step, or an earlier result's answer, changed
  already is an Error, since two answers would decide one state. So is an answer at or below a transition's
  declaring node in its temp step, unless its next and failed both keep that node.
- In a step into failed, which commits whatever happens, a result whose answers refuse is left out and its Error
  joins the result. `FAILURE` is no named result: only the nodes of the step into failed take it.

```typescript
defineFlow(transport.open, { opened: (t, { socket }) => ({ ...t, socket }) });

// Another state takes the driver's loaded result in the step it folds in.
const tracksState = defineState<{ list: string[] }>()
  .name("tracks")
  .signals(playerSignals)
  .variant("none", { initial: true })
  .variant("listed")
  .build();

defineFlow(tracksState.none, {}, {
  loaded: (t, { manifest }: { manifest: Manifest }) => tracksState.listed({ list: manifest.tracks }),
});
```

### applyFlow

Puts the states on a target, and registers the flow's handlers and events.

```typescript {% shorthand=true %}
function applyFlow(
  target: object,
  states: StateDefinition[],
  initializer: (sm: StateManager) => void,
  config?: FlowConfig,
): void
```

The target holds each state's initial props under the state's name; `applyFlow` replaces them with an instance
of the initial variant, or with the instance `start` gives under the state's name. No handler runs for it, and its nested states get no enter. The order of `states` is the
order in which the reducers run and the states' handlers take their turns in each phase.

`applyFlow` throws for an argument that is not a state definition, a state whose props the target lacks, an
initial instance that holds a transitional variant at any depth, or an asynchronous one unless `start` gave it, two definitions that declare
named results of one name (among the states and the nested states their initial instances hold; a definition a
node first holds later is not seen), and an event on a target without an `emit` method.

`FlowConfig`, every field optional:
- `logHandlers: StateFlowLogHandler[]`: the flow's log handlers; absent or empty means `consoleLogHandler`.
- `timers: { setTimeout(callback, ms), clearTimeout(handle) }`: what every timer of the flow goes through: a
  transition's timeout, an accepted abort's wait, the deliveries of observers, events, watches and subscribers,
  and the waits of `settled`. Absent means the global functions, looked up at each call, so fake timers installed
  after `applyFlow` apply. The engine calls them as methods of the object: for the global functions, pass
  `globalThis` or functions bound to it. A callback must run after `setTimeout` returns, and `clearTimeout` must
  ignore a handle whose timer ran or was cleared. A simulation passes its own to control time (see
  [Testing](/docs/testing#controlling-time)).
- `equalAnswers: "identity" | "value"`: when a reducer's answer counts as no change; `"identity"` by default.
- `start: { [stateName]: instance }`: states to start from, for tests and tools that begin in the middle of a
  session (see [applyFlow](#apply-flow)).

**Equal answers.** With `equalAnswers: "value"`, a next of the given instance's variant whose props equal its
props counts as that instance: no handler runs and nothing commits there, and observers, subscribers and the log
see no change. Props are equal when they have the same own enumerable keys and equal values under each. Two values
are equal when they are `===` (so `NaN` never is), and otherwise only as follows:

| Both values are | Equal when |
|---|---|
| `Box`es | they wrap the same value (`Box.equals`) |
| `FrozenSet`s | each has every element of the other, by the set's own lookup |
| `FrozenMap`s | each has every key of the other, with equal values |
| arrays | they have one length and equal elements at each position, a hole equal only to a hole |
| plain records | they have the same own enumerable keys and equal values under each |

A nested state, an `Items` and any other object are equal only when `===`. A temp and a failed compare by
identity in either mode, so a failed with equal props still takes `[FAILURE]`. `"value"` costs one walk of the
props for each answer whose next is another instance of its node's variant.

**Starting from given states.** Under a state's name, `start` gives the instance the flow takes as that state's
committed one, in place of the initial variant built from the target's props. The target still needs props under
that name, and a state not named in `start` starts from them as usual:

```typescript
const manifest: Manifest = { url: "https://example.com/a", tracks: ["video"] };
const resumed = { driver: { url: "", manifest: null, reason: null } };

applyFlow(resumed, [driverState], () => {}, {
  start: { driver: driverState.active({ url: "https://example.com/a", manifest, reason: null }) },
});
```

Nothing runs for the start: no handler, no log entry, no enter of any variant, so the instance may be in an
asynchronous variant, with no transition pending. Events and watches compare the first commit with it. The checks
of an initial instance that still apply: a variant marked transitional is refused (a temp without that mark is an
ordinary state), and two definitions that declare named results of one name are refused. Nothing else is checked:
a name that matches no state of the flow is ignored, and an instance of another definition is taken as it is. Its
`DisposableBox`es follow the rules of [DisposableBox](#disposable-box): a box given to two flows is disposed by the
first to drop it.

#### Handlers

The initializer gets a `StateManager`, the only place to register handlers and events:

```typescript {% shorthand=true %}
interface StateManager<TStates> {
  addEnterHandler(variant, handler: EnterHandler, context?): void;
  addExitHandler(variant, handler: StateHandler, context?): void;
  addUpdateHandler(variant, handler: UpdateHandler, context?): void;
  addTransitionHandler(variant, handler: TransitionHandler, context?): void; // an asynchronous variant only
  addCommitHandler(variant, handler: CommitHandler, context?): void;
  defineEvent(name, changed, payload?): void; // see Events below
}
```

- An **enter** handler runs when a step enters `variant`: from another variant of its state (`prev` is the
  instance it replaces), or, for a nested state, at a position that held none or held another definition (`prev`
  undefined). It runs in every step that enters the instance, a refused one included, so one dispatch may call it
  twice (see [Failed](#failed)).
- An **exit** handler runs when a step leaves it: for another variant, or for a nested state whose position
  empties or another definition takes. It runs in every step that leaves the instance, a refused one included, so
  one dispatch may call it twice.
- An **update** handler runs when a reducer gives the node a new instance of the same variant; as an enter
  handler, it may run twice in one dispatch.
- A **transition** handler is the work of a declared transition whose end enters `variant`, an asynchronous
  variant (see [StateResult.transition](#state-result-transition)); the adder throws for any other variant, whose
  type it refuses too.
- A **commit** handler runs right after the commit, wherever an enter handler of `variant` runs, also on a
  transition's temp, before its work starts. It is meant for events to the application.

`context` is the handler's `this`, and its name joins the callback's in log entries. A handler registered on a
variant of a nested state runs for every node of the tree in that variant. Every adder registers whether
[setHandlersDisabled](#set-handlers-disabled) is on or not.

```typescript {% shorthand=true %}
type EnterHandler<V> = (state, snapshot, prev, key, signal: AbortSignal) => HandlerResult<V>;  // plain, or named of V
type UpdateHandler<V> = (state, snapshot, prev, key, signal: AbortSignal) => HandlerResult<V>; // plain, or named of V
type StateHandler<V> = (state, snapshot, prev, key) => HandlerResult;                          // exit: plain only
type TransitionHandler<V> = (next, snapshot, prev, key, signal: AbortSignal) => Promise<HandlerResult<V>>;
type CommitHandler<V> = (state, snapshot, prev, key) => void;
```

| Handler | `state` | `prev` |
|---|---|---|
| enter | the instance entered, as its reducer declared it | the instance it replaced; undefined at a new position |
| exit | the instance left | the same instance |
| update | the new instance, as its reducer declared it | the old instance |
| transition | `next`, as its reducer declared it | the instance the node holds while the work runs; undefined at a new position |
| commit | the instance entered, with its named results folded | as enter |

`key` is the node's key in its parent's `Items`, undefined at the top level and for a single nested state.
`snapshot` is the frozen snapshot of every top-level state as the step prepared it, as it committed for a commit
handler: a sibling's new value is read there, not off the target, which holds the old values until the commit.

`signal`, the fifth argument of an enter or update handler, is the step's AbortSignal, shared by every enter and
update handler of the step. It aborts when the step does not commit, whatever kept it from committing: a handler
refused or threw, a named result did not fold, another state's answer to it failed, the named results broke a
[DisposableBox](#disposable-box) rule, or a throw stopped the step. Nothing undoes what the handler did, and a
handle it returned in a named result is in no state, so on the abort the handler releases what it made in that
call. Once the step commits the signal never aborts, also in a step into
failed. An exit handler gets no signal: it releases, and makes nothing. A transition handler's signal is
its transition's.

A step runs in this order:
1. the reducers, pure;
2. the exit handlers, then the update handlers, then the enter handlers;
3. the fold of the named results, and the other states' answers to them, whose handlers run in a further round;
   a [DisposableBox](#disposable-box) they leave in two places, or a disposed one they place, refuses the step;
4. the commit, where observers compare and events and watches decide; their callbacks run on later timer turns;
5. the [commit delegates](#commit-delegates) of the step's handler results;
6. the commit handlers;
7. the disposal of the [DisposableBoxes](#disposable-box) the step carried that the committed states no longer hold.

One variant's handlers run in registration order. Handlers apply the decision, and a failing one refuses it:
- An exit, update or enter handler's Rejected, Error or throw refuses the step. The other handlers of its phase
  still run, their failures merge in the order they were called, and nothing after the phase runs: the step's
  commit delegates are dropped. Without a failed declared, nothing commits and the result is the merged refusal;
  with one, the node goes to its failed (see [Failed](#failed)). Nothing undoes what the handlers that ran did. An
  Ignored refuses nothing.
- Enter, exit and update handlers are synchronous: a returned promise is an Error. An entry that waits for the
  world is a transition handler's.
- Only an enter, update or transition handler may return a named result, and only one of the variant it enters or
  updates.
- A commit handler cannot refuse the commit: its return value is ignored, a returned promise is not awaited, a
  throw is logged as its handler result, and a rejected promise is reported with `console.error`.
- No handler, commit delegate or listener of a step's signal may dispatch to or dispose its own target
  synchronously: that throws. A dispatch belongs after the dispatch returns, through `lock()`.

The player whose `driverState` is defined above:

```typescript
const idle = () => driverState.idle({ url: "", manifest: null, reason: null });

defineFlow(driverState.idle, {
  play: (s, { url }) =>
    StateResult.transition(
      driverState.active({ ...s, url, manifest: null, reason: null }),
      driverState.activating({ ...s, url, reason: null }),
      driverState.failed({ ...s, url, manifest: null }),
      { timeoutMs: 5000 },
    ),
});
// activating's reducer is an abort reducer: stop during play cancels it.
defineFlow(driverState.activating, { stop: idle });
defineFlow(driverState.active, { stop: idle }, { loaded: (s, { manifest }) => ({ ...s, manifest }) });
// failed takes the reason of the failure that led to it.
defineFlow(driverState.failed, { stop: idle }, { [FAILURE]: (s, { reason }) => ({ ...s, reason: reason ?? null }) });

const player = { driver: { url: "", manifest: null, reason: null } };

applyFlow(player, [driverState], (sm) => {
  // The work: the request takes the transition's signal, so an abort or the timeout cancels it.
  sm.addTransitionHandler(driverState.active, async (next, snapshot, prev, key, signal) => {
    const manifest = await fetchManifest(next.url, { signal });
    signal.throwIfAborted();
    return manifest === null ? HandlerResult.rejected("no manifest") : driverState.active.results.loaded({ manifest });
  });

  // The end's enter handlers run after the work's results folded, so the manifest is in props.
  sm.addEnterHandler(driverState.active, (s, snapshot, prev, key, signal) => {
    if (s.manifest === null) {
      return HandlerResult.rejected("no manifest to attach");
    }
    attach(s.manifest);
    // When the end step does not commit, active is never held, and no exit detaches.
    signal.addEventListener("abort", () => detach(), { once: true });
    return HandlerResult.ok();
  });
  sm.addExitHandler(driverState.active, () => {
    detach();
    return HandlerResult.ok();
  });

  sm.addCommitHandler(driverState.failed, (s) => {
    showError(s.reason);
  });
});
```

#### Events

`defineEvent` defines a public event of the flow, emitted through the target's own `emit(name, payload?)`.

```typescript {% shorthand=true %}
interface StateManager<States> {
  defineEvent(
    name: string,
    changed: (cur: States, prev: States) => boolean, // the flow's states after a commit and as of the commit before
    payload?: (cur: States) => unknown,
  ): void;
}
```

After every commit `changed` runs on the committed states and on the states as of the commit before, the initial
ones the first time. When it returns true, the event is emitted on a later turn of the flow's timers, with
`payload(cur)` when given; the events of one commit fire in definition order. The commit's log entry records each
decision under `observers`, as `event:<name>`. A throw from `changed` is that observer's error and emits nothing,
a throw from `payload` or from a listener goes to `console.error`, and nothing an event does can break the commit.
Events keep running with handlers off.

```typescript
import { EventEmitter } from "events";

class Player extends EventEmitter {
  driver = { url: "", manifest: null as Manifest | null, reason: null as string | null };
}

const shell = new Player();
applyFlow(shell, [driverState], (sm) => {
  sm.defineEvent(
    "failed",
    (cur, prev) => stateVar(cur.driver) === driverState.failed && stateVar(prev.driver) !== driverState.failed,
    (cur) => cur.driver.reason,
  );
});

shell.on("failed", (reason: string | null) => showError(reason));
```

### mockHandlers

Replaces the handlers of one variant, for tests.

```typescript {% shorthand=true %}
function mockHandlers<V>(variant: V, mocks: HandlerMocks<V>): Disposable

interface HandlerMocks<V> {
  enter?: EnterHandler<V>;
  exit?: StateHandler<V>;
  update?: UpdateHandler<V>;
  transition?: TransitionHandler<V>; // typed only for an asynchronous variant
  commit?: CommitHandler<V>;
}
```

Each given mock replaces, on every target, all handlers of its kind on `variant`, until the returned disposer runs.
A mock runs whether the handlers-off switch is on or not, with the arguments the replaced handlers would get: with
the switch off it is a partial mock (one service replaced, the others real), and with it on the only handler that
runs. A transition mock gives a transition's work to `variant` also when no transition handler is registered on
it. Registrations stay as they are, and the disposer brings them back. For a union of variants, a transition mock
is typed when every one of them is asynchronous, as one handler of the union.

A mock makes no entry asynchronous: the variant's `async` mark does, so a test checks entries as production does.
`mockHandlers` throws for a key that is not one of the five kinds, for a kind already mocked on `variant` (dispose
that mock first), and for a transition mock of a variant that is not asynchronous.

```typescript
using mocks = mockHandlers(driverState.active, {
  transition: async () => driverState.active.results.loaded({ manifest: fakeManifest }),
});
```

### setHandlersDisabled

The handlers-off switch, for simulation tests.

```typescript {% shorthand=true %}
function setHandlersDisabled(disabled: boolean): void
```

The switch is read at every handler call, so it acts on every target, also one set up before it changed. While it
is on, no enter, exit, update, transition or commit handler runs, so no commit delegate either, though
`applyFlow`'s initializer still registers them all; turned off, those registrations run again. Mocks run either
way. Reducers, the diffs of nested states, commits, observers, events, watches, subscribers and the log run as
usual. A declared transition has no work while the switch is on, unless a transition mock is in force, so its next
commits inside the send that declared it, with the props the world would fill left at their defaults. Whether an
entry is asynchronous is the variant's mark, which the switch does not change.

What a run with every handler off does not cover:
- Every declared transition reaches its next, so code that runs only after a failed end or an abort is not
  exercised; a mock that refuses reaches it (see [Testing](/docs/testing#simulating-with-handlers-off)).
- No handler refuses, so a step that a failing handler would refuse commits.
- An abort finds no transition pending, since each one ended inside its send: the abort's signal is reduced as an
  ordinary signal, and the abort reducers of a transitional variant are never reached.

The switch stops handlers only: `Box.deref()` works as without it (and still throws inside a reducer), and the
engine still disposes the [DisposableBoxes](#disposable-box) that steps drop and that `disposeFlow` finds. To check
that a run touches nothing, the target gets recording stand-ins, in its boxes as everywhere else.

```typescript
setHandlersDisabled(true);
try {
  const sim = { driver: { url: "", manifest: null, reason: null } };
  applyFlow(sim, [driverState], () => {});
  await using send = await lock(sim);
  await send(playerSignals.play({ url: "https://example.com/a" })).done();
  // String(sim.driver) is "driver.active(...)" with manifest null: no handler ran.
} finally {
  setHandlersDisabled(false);
}
```

### lock

Acquires the target's lock for a sequence of signals. Used with `await using`.

```typescript {% shorthand=true %}
async function lock(target: object, label?: string): Promise<DispatchFn>

type DispatchFn = ((signal: Signal, options?: DispatchOptions) => Result) & {
  [Symbol.asyncDispose](): Promise<void>; // releases the lock
};
```

- The claim is made synchronously, inside the call: locks are served in the order `lock()` was called (FIFO).
  The holder then waits for any pending transition before `lock()` resolves.
- `send(signal, options?)` dispatches while the lock is held. While a declared transition is pending, `send`
  queues the signal and returns a pending result: queued signals are reduced in order after the transition ends,
  and each one's `done()` resolves to its own result. `send(signal, { abort: true })` aborts the transition instead
  (see [Aborting a transition](#aborting-a-transition)).
- The release waits until no transition is pending, also one that an abort or a queued signal started, then hands
  the lock to the next caller.
- `send()` throws once the lock is released, inside a reducer, and inside the target's own dispatch, unless the flow
  is disposed (below).
- `label` buffers the section's log entries and flushes them under one console group on release.
- `lock()` rejects for a target that is no flow. Once `disposeFlow` ran, every send answers `Rejected`
  `<name> is disposed`, with no log entry and nothing dispatched, whatever its lock: one taken before, one whose wait
  for its turn or for a pending transition the dispose ended, or one asked for afterwards, which `lock()` resolves at
  once to a sender that holds no lock. No caller needs a catch, and `.expect(ResultKind.OK)` on the result throws, as
  for any kind it does not list. The release of a lock taken before still flushes the entries its label buffered.

```typescript
async function configure() {
  await using send = await lock(app, "configure");
  await send(signals.activate()).done();
  await send(signals.configure({ setting: "value" })).done();
} // the lock is released here, and the two entries log under one "configure" group
```

### dispatch

Dispatches a signal without a lock. Deprecated: `lock()` and `send()` are the way to dispatch.

```typescript {% shorthand=true %}
function dispatch(target: object, signal: Signal, options?: DispatchOptions): Result

interface DispatchOptions {
  abort?: boolean; // abort the pending declared transition with this signal
  mute?: boolean;  // write no log entry (none of a transition it declares either)
}
```

A bare `dispatch()` throws while a lock is held or a transition is pending, inside a reducer, and inside the
target's own dispatch. It remains for synchronous teardown (`beforeunload`), for bootstrap before any lock
exists, and for aborting a transition whose lock another caller holds: `dispatch(target, signal, { abort: true })`
skips the lock. With nothing pending an abort is an ordinary dispatch, except that under a held lock it returns
Rejected instead of throwing.

It returns a Result; while a declared transition runs, a pending `InTransition` result, whose `done()` resolves to
the end. `.expect()` on a pending result is checked at `.done()`, so a dispatch that may start a transition chains
`.done()`.

```typescript
window.addEventListener("beforeunload", () => {
  dispatch(app, signals.teardown());
});

// Abort a transition another caller's lock is waiting on.
dispatch(app, signals.cancel(), { abort: true });
```

### sync

Waits until no declared transition is pending on the target, also one that an abort or a queued signal starts
when the previous one ends.

```typescript {% shorthand=true %}
async function sync(target: object): Promise<void>
```

A transition handler must not await `sync()`, `lock()` or `send()` on its own target: it would wait behind its own
transition until the timeout.

```typescript
await sync(player);
console.log(String(player.driver)); // the state the transition reached
```

### settled

Waits until the flow has nothing left to deliver.

```typescript {% shorthand=true %}
async function settled(target: object): Promise<void>
```

It resolves once every delivery set on the flow's timers has run (the callbacks of observers, events and watches,
and the changes of subscribers), including the deliveries their own commits set, once the locks they asked for were
served, and once no declared transition is pending. A lock a delivery asks for synchronously is served: `lock()`
claims its place in the queue inside the call, and `settled` takes the lock after it and releases it at once. A lock
asked for after an await of the delivery's own may come later and is not waited for. With nothing to deliver, the
lock free and no transition pending, it resolves without waiting for a timer.

On a disposed flow it waits for the deliveries set before `disposeFlow`, whose observers' and watches' callbacks are
dropped since `disposeFlow` removed them, and takes no lock. It rejects for a target that is no flow, and when
`disposeFlow` runs while it waits for the lock, behind its holder or for the transition that lock waits for. A caller
that holds the target's lock must not await it: its own `lock()` would wait for that holder.

```typescript
disposeFlow(shell);
await settled(shell); // the events of the last commits have fired
```

### observe

Watches the target's states, top-level and nested, for changes into the given variants.

```typescript {% shorthand=true %}
function observe<V extends StateVariant, T extends TargetOf<V, T>>(
  target: T,
  stateVariants: V[],
  handler: (state: InstanceOfVariant<V>, path: string) => void,
  compareFn?: (prev: InstanceOfVariant<V>, curr: InstanceOfVariant<V>) => boolean,
  ctx?: object,
): Disposable
```

After each commit, every node that changed into one of `stateVariants` tells the observer: a top-level state, or a
nested state's node at any depth, such as each element of an `Items` that changed. `compareFn(prev, next)` gets
the node's instances before and after and decides whether the handler runs; by default, whenever the instance
changed. A nested node that held no instance of its state before has nothing to compare, and the handler runs. The
handler gets the committed instance and the node's path as the log names it (`media`, `media.producers[cam]`), on
a later turn of the flow's timers, if the observer is still registered then: once it is disposed, or `disposeFlow`
removed it, a handler call that an earlier commit set is dropped. A node that a commit removes tells no observer.
`ctx` names the observer in log entries, with the handler's name.

A variant of a state outside the target's flow would never fire, so such a call does not compile: the target's
type must have a prop under each variant's state name, of that state's props, or hold that state's instances below
its top-level props. The types find a nested state by its name alone, so a variant of a state that only an object
outside the flow holds compiles too, and its observer never fires. They cannot search `this` or a target typed by
a type parameter for nested states: for a nested state's variant, pass the target typed as the class
(`this as Player`).

An observer is told after the commit has set every state, so it cannot break the commit: a throw from its compare
or its handler is reported with `console.error`, and a throw from the compare is its error in the log entry.
Observers keep running with handlers off, so a change of the world belongs in a handler, not in an observer.

```typescript
const assigned = observe(app, [taskState.assigned], (task) => console.log(`assigned to ${task.assignee}`));

// A custom compare: the handler runs only when the priority changed.
using priority = observe(
  app,
  [taskState.assigned],
  (task) => console.log(`priority ${task.priority}`),
  (prev, curr) => prev.priority !== curr.priority,
);

// A nested state's variant: each producer that becomes active, with its node's path.
using producers = observe(session, [producer.active], (p, path) => console.log(`${path} is active`));

assigned[Symbol.dispose]();
```

### watch

Watches the whole flow with a predicate.

```typescript {% shorthand=true %}
function watch<T extends object>(
  target: T,
  changed: (cur: T, prev: T) => boolean,
  callback: (cur: T, prev: T) => void,
): Disposable
```

After every commit `changed(cur, prev)` runs on the committed states and on the states as of the commit before
(the states at `watch()` the first time); when it returns true, `callback(cur, prev)` runs on a later turn of the
flow's timers. The entry records each decision under `observers` as `watch:<callback name>`. A throw from `changed`
is that observer's error, a throw from `callback` goes to `console.error`, and neither can break the commit. Unlike
an [event](#events), a watch is attached and released at any time, and runs a callback instead of emitting. The
callback runs only while the watch is registered: once it is disposed, or `disposeFlow` removed it, a callback that
an earlier commit set is dropped. It throws for a target that is no flow or a disposed one.

```typescript
using w = watch(
  player,
  (cur, prev) => cur.driver.manifest !== prev.driver.manifest,
  (cur) => console.log(`manifest of ${cur.driver.url}`),
);
```

### subscribeFlow

Subscribes to every committed change on a flow, nested states included, observation-only.

```typescript {% shorthand=true %}
function subscribeFlow(target: object, subscriber: (change: FlowChange) => void): Disposable

interface FlowChange<T = unknown> {
  flowName: string;      // the target's flow name
  stateName: string;     // the state that changed; for a nested node, its instance's state
  path?: string;         // a nested node's path, e.g. "media.producers[cam]"; absent on a top-level state
  prevVariant: string;   // e.g. "paused"; "(none)" where a nested position was empty
  nextVariant: string;   // e.g. "playing"; "(none)" where a nested position empties
  prev: T;               // the instance before, frozen; undefined where a nested position was empty
  next: T;               // the instance after, frozen; undefined where a nested position empties
  signal: string;        // the string form of the signal that drove the dispatch
  dispatchOrder: number; // the dispatchOrder of the log entry of the step that committed it
}
```

One `FlowChange` is delivered per node that changed in a commit: each top-level state that changed, then each
nested node inside it that changed, in pre-order. Each change reaches each subscriber on its own turn of the flow's
timers, after the commit; a subscriber disposed meanwhile gets nothing more. A subscriber has no handle to
dispatch or change state, and its throw is reported with `console.error` without affecting the dispatch or the
other subscribers. A transition commits twice, its temp step and its end, and each delivers the changes it made.
With no subscriber, a dispatch builds no `FlowChange`.

```typescript
using sub = subscribeFlow(app, (change) => {
  console.log(`${change.path ?? change.stateName}: ${change.prevVariant} -> ${change.nextVariant}`);
});
```

### addFlowTap

Adds a tap that every flow of the page tells, for tools that record a session; application code uses
[observe, watch and subscribeFlow](/docs/state-visibility#observing-changes).

```typescript {% shorthand=true %}
function addFlowTap(tap: FlowTap): () => void // returns the function that removes the tap

type FlowTap = {
  dispatched(target: object, signal: Signal): void;
  handled(
    target: object,
    kind: "exit" | "update" | "enter" | "transition",
    call: { readonly name: string; readonly instance: StateInstance },
    result: Result,
  ): void;
  ended(target: object, step: FlowTapStep): void;
};

type FlowTapStep = {
  signal: Signal;
  abort: boolean;
  result: Result;
  transition: "temp" | "final" | "failed" | undefined;
  changes: ReadonlyArray<{ stateName: string; old: StateInstance | undefined; next: StateInstance | undefined }>;
  fired: ReadonlyArray<{ stateName: string; observerName: string }>;
  unsettled: ReadonlyArray<{ readonly name: string; readonly instance: StateInstance }>;
};
```

`dispatched` is told that `signal` is dispatched to `target`, before its reducers run: a send, a bare dispatch, a
queued send at its turn, an abort when it is sent, a muted dispatch, and one its reducers refuse or ignore.
`handled` is told what a handler of `kind` gave in `call`, one call of a step on one node: what an exit, update or
enter handler returned, or what a transition handler's promise settled to, a throw as its `Error`. A named result's
name and data are in `result.named`, and the data a refusal carries in `result.data`. `call.name` is the node's path as the log names it and `call.instance` the
instance the handler got; every handler of one call is told with the same `call` object. A commit handler is not
told, since it runs after the commit and changes no state.

`ended` is told once for every log entry a dispatch writes, a muted dispatch's too, once the step and its commit
handlers ran: inside the dispatch, but for a transition's end and an accepted abort's step, when the work settles or
the wait ends. `step.result` is what the dispatch returns, but for a temp step, which gets a Pending of the same end;
on a transition's end it is what `done()` resolves to. Every `dispatched` whose dispatch returns is followed by exactly
one `ended` with the same signal object, a refused step and a refused abort included; a transition's end adds one
more, marked final or failed; an accepted abort drops that end, and its own `ended` lists the works left unsettled; a
transition pending at `disposeFlow` gets none. A tool pairs an `ended` with its `dispatched` by the signal's identity,
and a late answer with the call an `ended` listed as unsettled by the call's. A dispatch that throws is outside this,
and so is a tap added or removed in the middle of a step.

`dispatched` and `handled` are told inside the step, before the step commits, except a late answer: one that settles once the transition
ended (its timeout, another work's refusal, an abort, `disposeFlow`) is told after that end committed. A tap is told
of every flow of the page, so it compares `target` with the one it records. While a tap is told, its dispatch or send
to that target and its `disposeFlow` of it throw, as in a handler, and the throw is reported as the tap's own: to
`console.error`, and the step and the other taps go on. A tap added or removed during a telling changes the next
telling only.

```typescript
const told: string[] = [];
const remove = addFlowTap({
  dispatched: (t, signal) => t === player && told.push(String(signal)),
  handled: (t, kind, call, result) => t === player && told.push(`${kind} ${call.name} ${ResultKind[result.kind]}`),
  ended: (t, step) => t === player && told.push(`ended ${String(step.signal)} ${ResultKind[step.result.kind]}`),
});
```

### listStates and listHandlers

List what a flow is made of, as plain data `JSON.stringify` writes as it is. Neither adds anything to a dispatch.

```typescript {% shorthand=true %}
// StateDefinition<any, never, any, any> is the type every built definition fits.
function listStates(states: readonly StateDefinition<any, never, any, any>[]): Array<{
  name: string;
  signals: string[];
  variants: Array<{
    name: string;
    initial: boolean;
    transitional: boolean;
    async: boolean;
    signals: string[];
    results: string[];
  }>;
}>

function listHandlers(target: object): Array<{ variant: string; kind: string; name: string }>
```

`listStates` lists the definitions it is given, in that order: each one's name and the signals it takes, and its
variants in the order of the definition's keys (the order of the `variant()` calls, with names that are integers
first), each with its marks (the options of `variant()`), the signals it has a reducer for, in
the order of the object given to `defineFlow` (none before `defineFlow`, and none mapped to `undefined` there), and
the named results it declares. A nested definition an instance may hold is listed only when the caller names it.
Transitions are not listed: one exists only as what a reducer returns.

`listHandlers` lists one entry per handler registered on `target`: its variant as `<state>.<variant>`, its kind
(`enter`, `exit`, `update`, `transition` or `commit`) and the name its results carry in the log. The entries are
grouped by variant in the order each was first registered on, then by kind, then in registration order. A handler
given as an anonymous function inline is named `""`, or `<context>.` when it was registered with a context. A mock
in force is not listed and hides nothing, and [setHandlersDisabled](#set-handlers-disabled) changes nothing here.
`listHandlers` throws for a target that was never applied, or whose flow was disposed.

```typescript
const mute = defineSignal("mute");
const unmute = defineSignal("unmute");
const audio = defineState<{ volume: number }>()
  .name("audio")
  .signals({ mute, unmute })
  .variant("unmuted", { initial: true })
  .variant("muted")
  .build();
defineFlow(audio.unmuted, { mute: (s) => audio.muted(s) });
defineFlow(audio.muted, { unmute: (s) => audio.unmuted(s) });

const speaker = { audio: { volume: 1 } };
applyFlow(speaker, [audio], (sm) => {
  sm.addEnterHandler(audio.muted, function silence() {
    return HandlerResult.ok();
  });
});

listStates([audio]);
// [{ name: "audio", signals: ["mute", "unmute"], variants: [
//   { name: "unmuted", initial: true, transitional: false, async: false, signals: ["mute"], results: [] },
//   { name: "muted", initial: false, transitional: false, async: false, signals: ["unmute"], results: [] } ] }]
listHandlers(speaker);
// [{ variant: "audio.muted", kind: "enter", name: "silence" }]
```

### disposeFlow

Tears a flow down.

```typescript {% shorthand=true %}
function disposeFlow(target: object): void
```

It removes the flow's handlers, observers, events, watches and state properties, then disposes every
[DisposableBox](#disposable-box) the final states hold. No handler runs, so no exit handler runs. A pending
declared transition ends with no further commit: its `done()` resolves to an Error, so do the `done()` of an abort
waiting for its work and of every signal queued behind it, and the work's signal aborts last, with a
`TransitionAborted` of kind `disposed`; the boxes of its next and of its work's results are disposed then, or as a
later result settles. From then on every send answers `Rejected` `<name> is disposed`, whatever its lock, one taken
before included, and every `lock()` still waiting, or called afterwards, gets such a sender (see [lock](#lock)).
Every other call on the target afterwards throws a `StateFlowError` `<name> is disposed [SF008] <fix>`, except [settled](#settled)
and `disposeFlow`: a second call does nothing, so a listener of the work's signal may dispose its own target. The
deliveries set before it still run: the events fire and the subscribers get their changes, while an observer's or a
watch's callback is dropped, since `disposeFlow` removed them (see [settled](#settled)).

`disposeFlow` throws inside a reducer, inside the target's own dispatch, and for a target that was never applied.

## Result API

A reducer returns a `StateResult`, a handler a `HandlerResult`, and `send()` and `dispatch()` return a `Result`.

### Result

The abstract base of every result.

```typescript {% shorthand=true %}
enum ResultKind {
  OK, Ignored, InTransition, Rejected, Error
}

abstract class Result {
  readonly kind: ResultKind;
  get message(): string | null;  // Ignored, Rejected
  get error(): Error | null;     // Error
  get code(): string | null;     // the error's code, or an engine refusal's (see Error Types); null otherwise
  get data(): Readonly<Record<string, unknown>> | undefined; // what a handler's Rejected carried; undefined otherwise
  get startedAt(): number;
  get finishedAt(): number;
  in(...kinds: ResultKind[]): boolean;
  expect(...kinds: ResultKind[]): this; // throws StateFlowError for another kind; on InTransition, checked by done()
  done(): Promise<Result>;              // a pending result's outcome; the result itself otherwise
  merge(other: Result): Result;
}
```

| Kind | Meaning |
|---|---|
| `OK` | The signal committed; or a declared transition reached its next. |
| `Ignored` | No reducer answered; nothing committed. |
| `InTransition` | The pending result of a send while a declared transition's work runs; `done()` resolves to the end it reaches. |
| `Rejected` | A reducer rejected the signal and nothing committed; or a handler of the step, or another state's reducer of a named result, rejected it, and the nodes whose reducers declared a failed went there; or, as a transition's outcome, its work or its end rejected and the node went to its failed, or an accepted abort cut it off (`aborted by <signal>`); or the send came after `disposeFlow`, whatever its lock (`<name> is disposed`), and nothing was dispatched. |
| `Error` | As Rejected, for a throw or an error: a reducer, a handler, a fold, or a rule of the dispatch, the plan's checks included; also when a failed state's own handler or result reducer failed, when the work outlasted its timeout (the error is a `TransitionAborted` of kind `timeout`), and when the flow was disposed during the transition. |

`merge(other)` combines two results into a new one: Error > Rejected > OK > Ignored. Of one kind the first wins,
except that two Ignored join their messages, and two Errors become one Error whose `error` is an `AggregateError`
of both and whose message joins theirs (`"a; b"`). The new result keeps the winner's `data`, so an Error that wins
carries none. Merging a pending result throws. The engine merges the verdicts
of the reducers of one signal, and the failures of the handlers of one phase, in the order they ran.

String forms: `OK`, `OK(loaded)` for a named result, `Ignored: <message>`, `Rejected: <message>`, and the error's
own string for an Error.

### StateResult

What a signal reducer returns.

```typescript {% shorthand=true %}
class StateResult extends Result {
  static ok(next: StateInstance, failed?: StateInstance): StateResult;
  static transition(next: StateInstance, temp: StateInstance, failed: StateInstance,
                    options?: TransitionOptions): StateResult;
  static ignored(message?: string): StateResult;
  static rejected(message: string): StateResult;
  static error(error: unknown): StateResult;
}

interface TransitionOptions {
  timeoutMs?: number; // default 500; a positive finite number up to 2_147_483_647
}
```

`ok` and `transition` take instances: a reducer answers with props by returning them bare. Their instances must be
of one definition, or they throw, which inside a reducer is the reducer's Error; an instance of a state other than
the reducer's own is an Error when the reducer returns.

```typescript
defineFlow(taskState.assigned, {
  assign: (task, { userId }) =>
    userId === task.assignee ? StateResult.ignored("assigned already") : { ...task, assignee: userId },
  setPriority: (task, { priority }) =>
    task.priority === "high" && priority !== "high"
      ? StateResult.rejected("a high priority stays high once assigned")
      : { ...task, priority },
});
```

### Failed

`failed`, in `ok` and in `transition`, is where a node goes when its entry is refused: an instance of its state.
`ok` may leave it out, and its node then stays as it was; `transition` requires it.

What led there reaches the failed state through `FAILURE`, a result the engine delivers and no variant declares:
a variant takes it with a result reducer keyed `[FAILURE]`, `(state, data: FailureData, ctx) => props | instance`,
where `FailureData` is `{ kind, reason?, error?, data? }`:

| `kind` | The failure | `reason` | `error` |
|---|---|---|---|
| `rejected` | the refusal of the step, of a transition's work or of its end step was a Rejected | the refusal's message | absent |
| `error` | that refusal was an Error: a handler threw or returned one, or a named result did not fold | the error's message | the Error; an `AggregateError` when two merged |
| `timeout` | the work outlasted `timeoutMs` | `<path> did not reach <variant> within <ms> ms [SF035] <fix>` | the `TransitionAborted` of kind `timeout` |
| `aborted` | an accepted abort's own step was refused, and the step into failed ends the transition it aborted in that transition's failed | the refusal's | the refusal's |

`data` is a frozen shallow copy of the record a handler gave with its Rejected (see [Refusal data](#refusal-data)),
as a reducer gets a signal's payload, when the refusal is one that gave it: of kind `rejected`, or `aborted` when the
abort's step was refused so. Of two Rejected that merged it is the earlier's, and there is none when an Error won.
Without data the key is absent, not `undefined`.

Every node the step into failed enters or updates, a nested state inside a failed included, folds the same data
through its variant's `[FAILURE]` reducer, before the named results its handlers return. A variant without that
reducer folds nothing, and a node the step keeps as the same instance gets nothing. `FAILURE` is a symbol of its
own, not from the global registry, so no result name and no symbol of user code (`Symbol.for("FAILURE")`
included) collides with it.

```typescript
const lampSignals = { switchOn: defineSignal("switchOn") };

const lamp = defineState<{ reason: string | null; crashed: boolean }>()
  .name("lamp")
  .signals(lampSignals)
  .variant("off", { initial: true })
  .variant("on")
  .variant("broken")
  .build();

// on's enter handler switches the bulb on; when it refuses or throws, the lamp goes to broken.
defineFlow(lamp.off, { switchOn: (s) => StateResult.ok(lamp.on(s), lamp.broken(s)) });
// broken takes the refusal's reason, and whether the handler threw rather than refused.
defineFlow(lamp.broken, {}, {
  [FAILURE]: (s, { kind, reason }) => ({ reason: reason ?? null, crashed: kind === "error" }),
});
```

For `StateResult.ok(next, failed?)`:
- A handler refuses the step with a Rejected, an Error, a throw, a promise or a fold that cannot happen. With a
  failed given, the node goes to it, and the dispatch's result is the refusal; when several nodes declared a
  failed, all of them go there, and a node without one stays as it was.
- Nothing is rolled back. The step into failed is the plain step from the instances the reducers ran on to the
  failed ones, and it calls the handlers of the nodes it changes as any step does: where it leaves the instance the
  refused step left, that exit runs again; where it holds the instance the refused step entered or updated at the
  same position, that enter or update runs again; and a node the failed keeps as the same instance gets no call, so
  one the refused step exited is not entered again. An exit's immediate effect must therefore bear a second call; a
  release that must happen once waits in a [commit delegate](#commit-delegates) or a
  [DisposableBox](#disposable-box). The refused step's enter and update handlers release what they made when its
  AbortSignal aborts, before the step into failed makes its calls.
- The step into failed is a floor: its own handlers cannot stop its commit. When they refuse, failed commits
  anyway, and the result is an Error, also when an exit that refused the step refuses again there. A result reducer
  that fails there, `[FAILURE]` included, is skipped, and its Error joins the result.

A failed is checked before any handler runs, and the dispatch is an Error when it breaks a rule: it must be of the
reducer's own state, hold no transitional variant, and enter no asynchronous one. The
[DisposableBox](#disposable-box) rules apply to the failed as to next; a box both hold stays when the failed
commits it.

A nested node's failed lands in its parent's answer, like its next.

| What happened | Where the state is | Result |
|---|---|---|
| everything passed | next | OK |
| a step's handler refused, no failed | as it was | the merged refusal |
| a step's handler refused, failed given | failed | the merged refusal |
| the work refused, or outlasted its timeout | failed | the refusal, or an Error whose error is a `TransitionAborted` of kind `timeout` |
| a handler or a result reducer of the step into failed refused | failed | the refusal merged with that Error |
| an abort was accepted | the abort reducer's state | Rejected `aborted by <signal>`; the abort's own result is its step's |
| disposeFlow ran during the work | nothing more commits | Error |

### StateResult.transition

Declares an entry that waits for the world; only a signal reducer returns it.

```typescript {% shorthand=true %}
class StateResult {
  static transition(next, temp, failed, options?): StateResult;
}
```

All three ends are required: a transition always has a state to hold while the work runs and a state to end in
when it fails. The options come fourth only.

What the engine does:
1. **Checks the plan.** `next`, `temp` and `failed` are instances of the reducer's own state; `next` and `failed`
   leave no node in a transitional variant; `temp` and `failed` enter no asynchronous variant; each end keeps the
   [DisposableBox](#disposable-box) rules, and neither next nor failed holds a box that the committed states hold
   and temp drops. One declared transition per dispatch, counted over the whole tree. A
   broken rule is an Error before any handler runs.
2. **Commits temp.** A full step commits temp at once, with the dispatch's other answers: getters, observers,
   subscribers and the log see it, and its commit handlers run. A temp that is the node's own instance
   (`def(ctx)` for a top-level state) changes nothing there. A handler that refuses this step is handled as for
   `ok` (see [Failed](#failed)), and no transition starts.
3. **Runs the work.** The work is every transition handler of every asynchronous variant the step from temp to next
   enters, the node's and its nested states', started together with one AbortSignal. A transition whose end enters
   no asynchronous variant, or none with a transition handler (handlers off and no mock included), has no work,
   and next commits inside the send that declared it.
4. **Ends at next.** Once every handler of the work settled OK or Ignored, their named results fold into next, the
   other states with result reducers of their names take them, and the end step from temp to next commits, with
   its own handlers. A refusal of the end step, or a [DisposableBox](#disposable-box) rule that the end's target,
   folded or not, breaks, takes the node to its failed; the failed end leaves temp too, so temp's exit runs again
   there, and an instance of next's that failed holds is entered or updated again.
5. **Ends at failed.** The first Rejected, Error, throw or return that is not a promise of a `HandlerResult`, or
   the timeout, ends the transition at once, whatever the other handlers give: the step from temp to failed
   commits, with the failure folded in through `[FAILURE]`.

Entry is a change of variant: `StateResult.transition(active(b), active(a), failed(a))` from `active` enters
nothing, so it has no work. An asynchronous change of props goes through a temp of another variant
(`active -> switching -> active`).

The transition handler gets `(next, snapshot, prev, key, signal)`, where `snapshot` is the end's snapshot before
any fold, and returns a promise of a `HandlerResult`: a plain one, or a named result of the variant it enters. It
never chooses a state: it only succeeds or refuses.

`send()` returns a pending `InTransition` result while the work runs; its `done()` resolves to:

| End | `done()` |
|---|---|
| next committed | OK |
| failed committed after a handler of the work refused | that handler's Rejected or Error |
| failed committed after the end step was refused | the end step's merged refusal |
| failed committed on the timeout | Error whose error is a `TransitionAborted` of kind `timeout` |
| an abort's step committed | Rejected `aborted by <signal>` |
| `disposeFlow` ran meanwhile | Error `flow disposed during the transition of <path> to <variant> [SF044] <fix>` |

While the transition is pending the target stays locked: the lock holder's sends queue and are reduced after the
end, a bare `dispatch` throws, and `lock()` callers wait. Only an abort passes.

**The AbortSignal.** The work's handlers share one signal, their fifth argument. It aborts whenever the work's
result will not commit, and its `reason` is a `TransitionAborted`:

```typescript {% shorthand=true %}
class TransitionAborted extends StateFlowError {
  readonly kind: "aborted" | "timeout" | "disposed" | "failed";
  constructor(kind: TransitionAborted["kind"], code: string, message: string);
}
```

| `kind` | When the signal aborts | Message, then ` [<its code>] <fix>` | Its code |
|---|---|---|---|
| `aborted` | an abort was accepted; before the engine waits for the work | `aborted by <signal>` | `SF040` |
| `timeout` | the work outlasted `timeoutMs`; after failed committed and the queued sends ran, up to one that starts a transition | `<path> did not reach <variant> within <ms> ms` | `SF035` |
| `disposed` | `disposeFlow` ran during the work; after the teardown | `flow disposed` | `SF046` |
| `failed` | a handler of the work refused, or the end step did not commit; after failed committed and the queued sends ran, up to one that starts a transition | `failed: <the refusal's message>` | `SF034` |

On every kind the handler releases what it acquired, except a value it returns in a `DisposableBox` of its named
result: the engine disposes that one unless a committed state holds it, also when the result settles after the
abort, so the handler wraps the value as it gets it, before any check that could throw, and returns it with no
listener. When next commits, the signal never aborts. A handler is an abortable API: it passes the signal on to
what can be cancelled (`fetch`, `addEventListener(..., { signal })`), listens for `abort` on what cannot, calls
`signal.throwIfAborted()` after each await, and joins conditions of its own with
`AbortSignal.any([signal, own.signal])`. Once the signal aborted, whatever the handler returns or throws is dropped.

```typescript
type OrderProps = { total: number; reason: string | null };
const orderSignals = { pay: defineSignal("pay") };

const orderState = defineState<OrderProps>()
  .name("order")
  .signals(orderSignals)
  .variant("confirmed", { initial: true })
  .variant("paying", { transitional: true })
  .variant("paid", { async: true })
  .variant("payFailed")
  .build();

defineFlow(orderState.confirmed, {
  pay: (s) =>
    StateResult.transition(orderState.paid(s), orderState.paying(s), orderState.payFailed(s), { timeoutMs: 10_000 }),
});
defineFlow(orderState.payFailed, {}, { [FAILURE]: (s, { reason }) => ({ ...s, reason: reason ?? null }) });

const shop = { order: { total: 40, reason: null } };
applyFlow(shop, [orderState], (sm) => {
  // A throw, a Rejected or the timeout commits payFailed, and then aborts the signal.
  sm.addTransitionHandler(orderState.paid, async (next, snapshot, prev, key, signal) => {
    await processPayment(next.total, { signal });
    signal.throwIfAborted();
    return HandlerResult.ok();
  });
});

await using pay = await lock(shop);
const paying = pay(orderSignals.pay()); // InTransition: shop.order is order.paying now
const outcome = await paying.done();    // OK once paid commits; Rejected or Error once payFailed does
```

### Aborting a transition

```typescript {% shorthand=true %}
type DispatchFn = (signal: Signal, options: { abort: true }) => Result;               // the lock holder's send
function dispatch(target: object, signal: Signal, options: { abort: true }): Result; // anyone else; skips the lock
```

An abort's reducers run on the committed snapshot, which holds the transition's temp. The abort is accepted when
they commit something and leave no node in a transitional variant. Otherwise it is refused and the transition
continues: reducers that change nothing give Rejected `<signal> changes nothing; the transition continues`,
reducers that refuse give their refusal with `; the transition continues` appended, and an answer that would leave
a transitional variant gives an Error. A second abort while one is in progress is Rejected. The timeout is not an
abort: it commits failed.

On an accepted abort the work's signal aborts with a `TransitionAborted` of kind `aborted`, the engine waits for
the work to settle, no longer than what is left of its timeout, drops what it settled to, and runs the abort's own
dispatch: its step, or a new transition its reducer declares. The original `done()` resolves to Rejected `aborted
by <signal>`, the abort's own `done()` to its step's result, and signals queued behind the transition are reduced
after that step. What the work gives after the wait ended is reported with `console.error`.

When a handler refuses the abort's step, its failed path follows as for any `ok` step, except that it does not keep
the transitional temp: where the abort's failed would keep it, the aborted transition ends in its own failed in the
same step, and that step's `FAILURE` is of kind `aborted`.

```typescript
// activating has a reducer for stop, so this abort is accepted.
await using send = await lock(player);
const playing = send(playerSignals.play({ url: "https://example.com/video" }));
const stopping = send(playerSignals.stop(), { abort: true });
await stopping.done(); // OK: idle committed once the work settled
await playing.done(); // Rejected: aborted by stop
```

### HandlerResult

What a handler returns.

```typescript {% shorthand=true %}
class HandlerResult<TVariantId extends string = never> extends Result {
  static ok(): HandlerResult;
  static ignored(message?: string): HandlerResult;
  static rejected(message: string, data?: Readonly<Record<string, unknown>>): HandlerResult;
  static error(error: unknown): HandlerResult;
  onCommit(...delegates: Array<() => void>): HandlerResult<TVariantId>;
}
```

Besides the four plain results, which fit every handler, an enter, update or transition handler may return a named
result built by its variant's factory, `driverState.active.results.loaded({ manifest })`. Its type names the
variant (`HandlerResult<"driver.active">`), so returning another state's or a sibling variant's result does not
compile, also from a class method without a return annotation: the adders type the callback by the variant
argument alone. An Ignored refuses nothing; a Rejected or an Error refuses the step.

```typescript
const studio = { media: { transport: transport.closed({ socket: null }), producers: producer.items() } };

applyFlow(studio, [media], (sm) => {
  sm.addEnterHandler(producer.active, (p) => {
    try {
      const rtp = createProducer(p.track.deref());
      return producer.active.results.created({ rtp: Box.of(rtp) });
    } catch (err) {
      return HandlerResult.error(err);
    }
  });
});
```

#### Refusal data

`HandlerResult.rejected(message, data)` refuses the step with a record of plain data beside the message, which the
failed end gets in its `FAILURE` result (see [Failed](#failed)) and a tap reads as `result.data` (see
[addFlowTap](#add-flow-tap)).

```typescript
const pageSignals = { load: defineSignal("load") };

const page = defineState<{ url: string; retryable: boolean | null }>()
  .name("page")
  .signals(pageSignals)
  .variant("blank", { initial: true })
  .variant("loading", { transitional: true })
  .variant("loaded", { async: true })
  .variant("failed")
  .build();

defineFlow(page.blank, { load: (s) => StateResult.transition(page.loaded(s), page.loading(s), page.failed(s)) });
// failed decides from the refusal's data: a page that is gone is not tried again.
defineFlow(page.failed, {}, { [FAILURE]: (s, { data }) => ({ ...s, retryable: data?.final !== true }) });

const tab = { page: { url: "https://example.com/gone", retryable: null } };

applyFlow(tab, [page], (sm) => {
  sm.addTransitionHandler(page.loaded, async (p, _snapshot, _prev, _key, signal) => {
    const response = await fetch(p.url, { signal });
    return response.ok
      ? HandlerResult.ok()
      : HandlerResult.rejected(`HTTP ${response.status}`, { final: response.status === 404 });
  });
});
```

#### Commit delegates

`result.onCommit(...delegates)` returns the result, of the same kind, with `delegates` added after the ones it
carries. When the step whose exit, update or enter handler returned the result commits, the engine calls them right
after the commit, before the commit handlers, in the order of the handler calls that returned them. A step that does
not commit drops them. So a handler that replaces a resource releases the old one in a delegate, and the new one on
its step's abort: a refused step leaves the world as it leaves the state.

- The kind does not decide: an Ignored in a step that commits runs its delegates, and so do a Rejected and an Error
  in a failed step, which commits whatever its handlers return.
- A delegate is synchronous and its return value is ignored. A throw is logged as a commit result named by the
  handler that returned it, and the next delegate still runs.
- A transition's temp step and its end each run their own handlers' delegates. A transition handler's delegates run
  when the end step commits, before the end step's own, in the order of the work's calls; an end that does not
  commit drops them.
- A handler runs in every step that makes its call, so when the failed step after a refused one leaves the
  instance the refused step left, or enters or updates again the instance it entered or updated, the second call
  returns its delegates anew, and they run at the failed commit.

```typescript
type Poll = { stop(): void };

const sourceSignals = { retarget: defineSignal<{ url: string }>("retarget") };

const source = defineState<{ url: string; poll: Box<Poll> | null }>()
  .name("source")
  .signals(sourceSignals)
  .variant("online", { initial: true, results: { polled: (data) => data as { poll: Box<Poll> } } })
  .build();

defineFlow(source.online, { retarget: (s, { url }) => ({ ...s, url }) }, { polled: (s, { poll }) => ({ ...s, poll }) });

const feed = { source: { url: "", poll: null } };
applyFlow(feed, [source], (sm) => {
  sm.addUpdateHandler(source.online, (s, snapshot, prev, key, signal) => {
    const poll = startPoll(s.url);
    // Not committed: the new poll stops. Committed: the old one stops.
    signal.addEventListener("abort", () => poll.stop());
    return source.online.results.polled({ poll: Box.of(poll) }).onCommit(() => prev.poll?.deref().stop());
  });
});
```

## Boxing & Flat State

Every constructed state is deep-frozen (see [Boxing live resources](/docs/boxing-live-resources) for the model).
A `Box` holds a live resource that cannot be frozen, such as a `MediaStream`, a socket or a DOM element; a
`DisposableBox` also lets the engine dispose it. `FrozenSet` and `FrozenMap` are the immutable collections for
data props, and nested states go in [Items](#items). An unfrozen instance of a class in a prop, a plain `Set` or
`Map` included, makes the factory throw; an `Error`, a `RegExp`, a URL or an event is frozen in place instead.

### Box

An opaque, owned handle to a live resource. Its interior is not frozen.

```typescript {% shorthand=true %}
class Box<T> {
  static of<T>(value: T, opts?: BoxOptions): Box<T>;
  deref(): T;
  equals(other: unknown): boolean;
  readonly id: string;
  readonly displayName: string;
}

interface BoxOptions {
  displayName?: string;
}
```

- **`Box.of(value, opts?)`** wraps `value` in a new `Box`. `opts.displayName` overrides the name otherwise taken
  from `value.constructor.displayName` or `.name`.
- **`deref()`** returns the wrapped value. It works in a handler of any kind, a commit delegate, an observer or an
  event, and **throws a `StateFlowError` inside a reducer**: reducers are pure and do not read live resources.
- **`equals(other)`** is true when `other` is a `Box` of the same value. It works in any scope. `Box.of` mints a
  new wrapper every time, so `===` on wrappers is no comparison of values.
- **`id`** is a per-instance identifier such as `"Box#3"`, and **`displayName`** the resolved name.
- `String(box)` is `Box(<displayName>#<n>)`, as `Box(MediaStream#3)`.

```typescript
const camera = Box.of(mediaStream);
// in a handler or an observer:
camera.deref().getTracks().forEach((t) => t.stop());
```

### DisposableBox

A `Box` of a value that has `Symbol.dispose` or `Symbol.asyncDispose`, whose value the engine disposes once no
committed state holds the box. Otherwise it is a `Box`: a reducer may place it, `deref` follows the same rules, and
`isBox` is true.

```typescript {% shorthand=true %}
class DisposableBox<T> extends Box<T> {
  static of<T>(value: T & (Disposable | AsyncDisposable), opts?: BoxOptions): DisposableBox<T>;
}
```

A box's place is an own enumerable string-keyed prop of a node: a top-level state's instance, or a nested state's
at any depth, an element of an `Items` included. The engine reads a prop through its descriptor, so no getter runs;
a symbol-keyed prop, and an array or an object inside a prop, hold none. Two boxes of one value are one box
(`equals`), so a value wrapped anew is the same box.

Before any handler runs, the engine checks each set of states the dispatch may commit, taken whole (next; a failed;
a declared transition's temp, next and failed end). The dispatch is an Error that names the places when one of them
holds one box in two places or a box the engine disposed already, or when a transition's next or failed end holds a
box that the committed states hold and its temp drops: the temp's commit would dispose it. A step other than a step
into failed is checked the same way when the named results of its handlers, a transition's work's at its end, fold
in and other states take them: when that leaves one box in two places or places a disposed one, the step is refused
before its commit, with an Error that names the places (`link.conn and gate.conn hold Box(Conn#3) when the named
results fold`). A transition's end is checked so even with nothing to fold, since its next stands on the temp as it
committed: a box the temp step's fold dropped, which the temp's commit disposed, may stand in next again
(`jib.conn holds Box(Conn#3) at the end of the transition, which the engine disposed already`).

After every step, the engine disposes each box the step carried that no node of the committed states holds after
it: the boxes of the instances the step replaced, of every instance it planned, even one a named result then folded
over, and of the named results its handlers returned, as their data or in their data's props. So a box moved to
another node, into a nested state or to another key of an `Items` stays. After a commit this runs once the step's
commit delegates and commit handlers ran. A refused step's boxes go with those of the step into failed after it,
once that step's commit delegates and commit handlers ran, or at once when it changes nothing: a box that next and
failed both hold stays, since the failed commits it, and a box only the refused step held, placed from a signal's
payload say, is disposed. A dispatch that its reducers or the plan refuse runs no step, so a box its reducers placed
stays the caller's.

A declared transition that does not reach its next disposes the boxes of that next and of its work's results,
unless a node holds them: with those of the step into failed when the temp step or the end step is refused;
otherwise as the work's signal aborts (a work refused, the fold of its results or another state's answer to them
failed, the timeout, an accepted abort, `disposeFlow`), or as a result settles later. `disposeFlow` disposes every
box the final states hold.

The engine disposes a value once, through `Symbol.dispose`, or else `Symbol.asyncDispose` without awaiting it; a
throw or a rejection goes to `console.error`. It disposes boxes also while handlers are switched off.

Until the process makes its first `DisposableBox`, the engine skips these checks and scans. From then on, each
dispatch reads the props of every node of each set of states it may commit, of the states a fold of named results
leaves, and of the states its steps change: on Node 24, a bare dispatch of a six-prop state with a nested state and
a box takes 18.9 µs, against 17.3 µs with no box made, about 9% more.

```typescript
type Connection = { send(data: string): void; [Symbol.dispose](): void };

const linkSignals = { open: defineSignal<{ url: string }>("open") };

const link = defineState<{ url: string; conn: DisposableBox<Connection> | null }>()
  .name("link")
  .signals(linkSignals)
  .variant("up", { initial: true, results: { connected: (data) => data as { conn: DisposableBox<Connection> } } })
  .build();

defineFlow(link.up, { open: (s, { url }) => ({ ...s, url }) }, { connected: (s, { conn }) => ({ ...s, conn }) });

const net = { link: { url: "", conn: null } };
applyFlow(net, [link], (sm) => {
  // The old connection is disposed once the step commits the new one, the new one when the step does not commit.
  sm.addUpdateHandler(link.up, (s) => link.up.results.connected({ conn: DisposableBox.of(openConnection(s.url)) }));
});
```

### isBox

Narrows a value to `Box<unknown>`; true for a `DisposableBox` too.

```typescript {% shorthand=true %}
function isBox(v: unknown): v is Box<unknown>;
```

### FrozenSet

An immutable `Set`. `has`, `size` and iteration work as in `Set`; `add`, `delete` and `clear` throw a
`StateFlowError`. `intersection` and `symmetricDifference` return plain, mutable `Set`s.

```typescript {% shorthand=true %}
class FrozenSet<T> extends Set<T> {
  constructor(iterable?: Iterable<T> | null);
  intersection(other: Iterable<T>): Set<T>;
  symmetricDifference(other: Iterable<T>): Set<T>;
}
```

```typescript
const tagged = defineState<{ tags: FrozenSet<string> }>().name("tagged").variant("active", { initial: true }).build();
const inst = tagged.active({ tags: new FrozenSet(["a", "b"]) });
inst.tags.has("a"); // true
```

### FrozenMap

An immutable `Map`. `get`, `has`, `size` and iteration work as in `Map`; `set`, `delete` and `clear` throw a
`StateFlowError`. It holds data: a state instance inside one is refused when the instance holding it is built.

```typescript {% shorthand=true %}
class FrozenMap<K, V> extends Map<K, V> {
  constructor(iterable?: Iterable<readonly [K, V]> | null);
}
```

```typescript
const configured = defineState<{ config: FrozenMap<string, number> }>()
  .name("configured")
  .variant("idle", { initial: true })
  .build();
const conf = configured.idle({ config: new FrozenMap([["timeout", 5000]]) });
conf.config.get("timeout"); // 5000
```

## Type Utilities

### Infer

The props of a state or a variant, or the payload of a signal.

```typescript
type Task = Infer<typeof taskState>;                  // the state's props
type AssignedTask = Infer<typeof taskState.assigned>; // the variant's props
type AssignArgs = Infer<typeof assign>;               // the signal's payload
```

### InstanceOf

The instance type of a definition, as a prop that holds a nested state takes it:

```typescript
type Transport = InstanceOf<typeof transport>;
```

### isIn

Whether an instance is in one of the named variants; the names are typed by the instance's definition.

```typescript {% shorthand=true %}
function isIn<I extends StateInstance>(instance: I, ...variants: VariantName<I>[]): boolean
```

`isIn(ctx.read("driver"), "active", "activating")` checks a sibling's variant in a reducer with no import of its
definition (see [Signal reducers](#signal-reducers)).

### stateVar, isState and isVariant

`stateVar(instance)` returns the variant of an instance, to compare with a variant of a definition:
`stateVar(app.task) === taskState.assigned`; it throws for a value that is no instance. `isState(value)` tells
whether a value is a state instance, and `isVariant(value)` whether it is a variant, such as
`taskState.assigned`.

### Exported types

For annotations: `StateDefinition`, `StateVariant`, `StateInstance`, `InstanceOf`, `Infer`, `Signal`,
`StateSignal`, `ReducerContext`, `ReducerReturn` (what a signal reducer may return), `FailureData`,
`FlowSnapshot`, `StateManager`, `ChangePredicate`, `EnterHandler`, `UpdateHandler`, `StateHandler`,
`TransitionHandler`, `CommitHandler`, `HandlerMocks`, `DispatchFn`, `DispatchOptions`, `TransitionOptions`,
`FlowConfig`, `FlowChange`, `FlowSubscriber`, `FlowTap`, `BoxOptions`, `StateFlowLogEntry` and `StateFlowLogHandler`. The
symbols: `FAILURE`, the key of a failure's result reducer, and `PARSER`, `SIGNALS`, `STRING_REPR` and `VARIANT`,
the keys of a definition's and an instance's own members.

## Log Entries

Each step writes one log entry (`StateFlowLogEntry`) to the flow's log handlers, and a refused or ignored dispatch
writes one too. A declared transition writes one entry per commit, marked `transition: "temp"`, `"final"` or
`"failed"`; an accepted abort's entry carries `aborted`, the path of the node whose transition it aborted. A handler
result's type is `enter`, `exit`, `update`, `commit` (a commit handler, or a commit delegate's throw) or
`transition`. Observers, events and watches record their decisions under `observers`. Handler results, state
changes and observers' results name a nested node by its path, as `media.producers[cam]`. See
[State visibility](/docs/state-visibility#entry-structure) for the full structure.

```typescript {% shorthand=true %}
function addGlobalLogHandler(handler: StateFlowLogHandler): () => void; // every flow's entries; returns the removal
function setConsoleLogSilenced(silenced: boolean | null): void; // mutes consoleLogHandler; null: muted under vitest
function setGlobalDispatchContextProvider(provider: () => string | null): () => void; // stamps a labeled lock's entries
function consoleLogHandler(entry: StateFlowLogEntry): void; // the default handler: one collapsed console group per entry
function serializeDebug(value: unknown): string; // the default string form of props and payloads
```

`ResultCollector`, the builder of an entry, is exported for tooling that writes entries of its own.

## Error Types

StateFlow throws its own error type for misuse of the API:

```typescript {% shorthand=true %}
class StateFlowError extends Error {
  name: "StateFlowError";
  readonly code: string; // "SF" and three digits: a key of the table
  constructor(code: string, message: string, inner?: Error | null); // inner becomes cause
}
```

Every error the engine raises has a stable `code`, never reused or renumbered, and its message is the engine's text,
then one space, the code in brackets, one space and the code's short fix:

```
Lock is held. Use `await using send = await lock(target)` for queued access [SF018] Take the lock with await lock(target) and send through it.
```

The table lives in the repository at `packages/core/src/error-codes.json`: for each code its `message` (with
`<placeholders>` for what a raise fills in), `cause` and `fix`. The package does not export it; the fixes are in the
bundle. An error's code always names its own text. An error that wraps another and embeds its text (`expect()`, a
transition's `failed` reason, an abort whose reducer failed) ends with its own code and fix and has its own `code`;
when it wraps an error, that error is its `cause`. `expect()` on a Rejected or Ignored result wraps no error and has
no cause.

```
lamp: the reducer of lamp.warming for stop returned a promise; reducers are synchronous [SF059] Return the next state synchronously; put the waiting in a transition handler.; the transition continues [SF039] Fix the reducer's error named in the message.
```

has `code` `SF039`, and its `cause` is the reducer's error, of code `SF059`. A refusal whose text the engine
writes keeps that text as its message, and its result names the code: `<name> is disposed` (`SF008`), `nothing to
abort: no transition is pending and the lock is held` (`SF017`), `an abort of <path> is already in progress`
(`SF036`), `<signal> changes nothing; the transition continues` (`SF037`), a reducer's refusal of an abort with `;
the transition continues` appended (`SF038`), `aborted by <signal>` (`SF040`) and `no reducer for <signal> in
<variants>` (`SF064`). A result a reducer or a handler built from its own text has no code. A merge keeps the
winner's code, and a merge that joins two messages (two Ignored, two Errors) the first code of the two. A log entry's
`finalResultData` carries the result's code too (see [State visibility](/docs/state-visibility#entry-structure)).
A Result keeps its code in one private field, `null` on success: one stored `null` per Result, and no other work.
A value a handler throws that has no string form becomes a plain `Error` (`a thrown value with no string form`, the
value its `cause`), not a `StateFlowError`, and has no code.

`TransitionAborted`, the reason of a transition's AbortSignal, extends it (see
[StateResult.transition](#state-result-transition)).

It is thrown, or carried by an Error result, for:
- a second `defineFlow` on one variant;
- an invalid definition: no name or variant, two initial variants, an initial transitional or asynchronous
  variant, a transitional asynchronous variant, a variant named `items`, a key of `.signals()` that is not its
  signal's name;
- a bare `dispatch()` while a lock is held or a transition is pending;
- a dispatch or `disposeFlow` inside the target's own dispatch (a handler, a commit delegate, a listener of a
  step's signal);
- a dispatch, a `disposeFlow` or a `Box.deref()` inside a reducer, and `ctx.read` of a name the flow has no state
  of (the reducer's Error);
- a plan the reducers' answers break: a failed that holds a transitional variant or enters an asynchronous one; an
  entry into an asynchronous variant outside a declared transition; two declared transitions in one dispatch; states
  the dispatch may commit that hold one `DisposableBox` in two places or one the engine disposed already, or a
  transition's end that holds a box its temp drops (an Error result);
- a step whose named results, as they fold in and other states take them, leave one `DisposableBox` in two places
  or place one the engine disposed already, and a transition's end whose target does so (an Error result);
- any call on a target that was never applied, and on a disposed one any call but `disposeFlow`, `settled`, `lock()`
  and a lock's send (see [disposeFlow](#dispose-flow));
- `addTransitionHandler` or a transition mock on a variant not declared with `{ async: true }`;
- a nested state inside data instead of directly in a prop;
- two definitions of one flow declaring named results of one name, and an event on a target without `emit`
  (`applyFlow`).
