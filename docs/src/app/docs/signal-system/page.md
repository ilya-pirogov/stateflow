---
title: Signal System
description: Guaranteed handling and comprehensive feedback through StateFlow's signal architecture
---

Signals are the only way to change state, and every signal gets an explicit result: committed, ignored, rejected,
failed, or pending until a declared transition ends. {% .lead %}

The examples on this page share one player:

```typescript
const playerSignals = {
  play: defineSignal("play"),
  pause: defineSignal("pause"),
  setVolume: defineSignal<{ level: number }>("setVolume"),
  seek: defineSignal<{ by: "time"; time: number } | { by: "frame"; frame: number }>("seek"),
};

const playback = defineState<{ position: number; volume: number }>()
  .name("playback")
  .signals(playerSignals)
  .variant("paused", { initial: true })
  .variant("playing")
  .build();

const app = { playback: { position: 0, volume: 1 } };
applyFlow(app, [playback], () => {});
```

## Signal Architecture

### Signals as Commands

A signal is a request, not a mutation: the reducers of the variants the target is in decide what it does, and the
caller learns the decision from the result.

```typescript
async function setVolume(level: number) {
  await using send = await lock(app);
  const result = await send(playerSignals.setVolume({ level })).done();
  if (result.kind === ResultKind.Rejected) {
    console.error(`volume change rejected: ${result.message}`);
  }
}
```

### Dispatching: `lock()` + `send()`

Signals go through a lock. `lock()` is exclusive and served in call order, waits for a pending transition, and
returns the `send` of the critical section; `await using` releases it at the end of the scope:

```typescript
async function playFrom(time: number) {
  await using send = await lock(app);
  await send(playerSignals.seek({ by: "time", time })).done();
  await send(playerSignals.play()).expect(ResultKind.OK).done();
}
```

`.expect()` on a pending (`InTransition`) result is checked when the transition ends, at `.done()`: a send that may
start a transition chains `.done()`. A bare `dispatch()` is deprecated: it throws while a lock is held or a
transition is pending, and remains for synchronous teardown, bootstrap before any lock exists, and the abort of a
transition whose lock another caller holds.

### Type-Safe Payloads

A signal's payload is typed at the factory and at every reducer that takes it. A union payload gives one factory
that takes any member, and the reducer narrows it by its discriminant:

```typescript
defineFlow(playback.paused, {
  play: (p) => playback.playing(p),
  setVolume: (p, { level }) =>
    level < 0 || level > 1 ? StateResult.rejected("volume is between 0 and 1") : { ...p, volume: level },
  seek: (p, s) => ({ ...p, position: s.by === "time" ? s.time : s.frame / 25 }),
});

playerSignals.seek({ by: "frame", frame: 50 });
// playerSignals.seek({ by: "time" }); does not compile: time is missing
```

### Signals Match by Name

A state lists the signals it takes with `.signals()`, each under its name, and its reducers are keyed the same way:
a reducer runs for the signal whose name is its key, so two definitions that share a name are one signal to the
reducers. `build()` throws when a key of `.signals()` is not the name of the signal under it. A nested state lists
its own signals, and a signal reaches only the variants that have a reducer of its name.

## Guaranteed Handling

### Explicit Results

Every dispatch returns a result, also when nothing happens:

```typescript
async function togglePlay() {
  await using send = await lock(app);
  const result = await send(playerSignals.play()).done();

  switch (result.kind) {
    case ResultKind.OK:
      console.log("playing");
      break;
    case ResultKind.Ignored:
      console.log(`nothing to do: ${result.message}`);
      break;
    case ResultKind.Rejected:
      console.warn(`refused: ${result.message}`);
      break;
    case ResultKind.Error:
      console.error(result.error);
      break;
    // No InTransition: done() resolves a pending transition to its end.
  }
}
```

### Signal Routing

A signal reaches the reducers of the variants the target is in now. A variant without a reducer for it ignores it:

```typescript
defineFlow(playback.playing, {
  pause: (p) => playback.paused(p),
  seek: (p, s) => ({ ...p, position: s.by === "time" ? s.time : s.frame / 25 }),
  // no play: a play while playing is Ignored
});
```

## Comprehensive Feedback

### Result Metadata

A result carries what the caller needs to act on it:

```typescript
async function seekAndReport(time: number) {
  await using send = await lock(app);
  const result = await send(playerSignals.seek({ by: "time", time })).done();

  if (result.kind === ResultKind.Error) {
    console.error(result.error); // the Error
  } else if (result.kind === ResultKind.Rejected) {
    console.warn(result.message); // the refusal's message
  }
  // After a declared transition, startedAt is the dispatch and finishedAt the end.
  console.log(`took ${result.finishedAt - result.startedAt} ms`);
}
```

### Result Merging

A signal runs every reducer it reaches, each on the snapshot from before the signal, in the order the states were
given to `applyFlow`, a parent before its nested states. Their verdicts merge into one result:

1. **Rejected or Error**: any reducer that refuses refuses the dispatch, nothing commits and no handler runs. Of
   several refusals the first Rejected wins, and an Error wins over any Rejected; two Errors join into one whose
   error is an `AggregateError` of both.
2. **InTransition**: a reducer declared a transition, at most one per dispatch over the whole tree; `done()`
   resolves to the end it reaches.
3. **OK**: at least one reducer answered, and every answer commits together, in one step.
4. **Ignored**: no reducer answered.

The handlers run after the reducers accept, before the commit. An exit, update or enter handler's Rejected or throw
refuses the step too: nothing commits, unless a reducer declared a failed state, and the result is that refusal.

### One Signal for the Whole Tree

A signal runs every reducer in the target's tree that its variant declares, top-level and nested. A nested reducer
gets its parent's instance as `ctx.parent` and its key in the parent's `Items` as `ctx.key`, so an element picks
itself by a key in the payload:

```typescript
const trackSignals = { mute: defineSignal<{ key: string }>("mute") };

const track = defineState<{ muted: boolean }>()
  .name("track")
  .signals(trackSignals)
  .variant("live", { initial: true })
  .build();

// mute reaches every live track; only the one under `key` changes, and only its flag: an update.
defineFlow(track.live, {
  mute: (t, { key }, ctx) => (ctx.key === key ? { ...t, muted: true } : StateResult.ignored()),
});
```

A child's answer lands at its position in its parent's answer, so a parent reducer and a child reducer may both
answer one signal as long as the parent keeps the child. A parent that replaced or removed a child whose own reducer
answered too is an Error: two reducers would decide one state.

### Asynchronous Signal Handling

An entry that waits for the world is declared twice: on the variant, with `{ async: true }`, and by the reducer
that enters it, with `StateResult.transition(next, temp, failed, { timeoutMs })`. The temp state commits at once,
and the transition handlers of the asynchronous variants the end enters are the work. The work succeeds or refuses,
never chooses a state: success commits next, with the named results the work returned folded in; the first
Rejected, Error or throw, or the timeout, commits failed, which takes the failure through its `[FAILURE]` reducer.

```typescript
const searchSignals = {
  find: defineSignal<{ query: string }>("find"),
  cancel: defineSignal("cancel"),
};

type Hit = { id: string; title: string };
type SearchProps = { query: string; hits: readonly Hit[]; reason: string | null };

const search = defineState<SearchProps>()
  .name("search")
  .signals(searchSignals)
  .variant("idle", { initial: true })
  .variant("loading", { transitional: true })
  .variant("loaded", { async: true, results: { fetched: (data) => parseHits(data) } }) // parseHits returns { hits }
  .variant("failed")
  .build();

defineFlow(search.idle, {
  find: (s, { query }) =>
    StateResult.transition(
      search.loaded({ query, hits: [], reason: null }),
      search.loading({ ...s, query }),
      search.failed({ ...s, query }),
      { timeoutMs: 10_000 },
    ),
});
// loading's reducer for cancel is the abort reducer: it lets a caller abort the request.
defineFlow(search.loading, { cancel: (s) => search.idle({ ...s, reason: null }) });
defineFlow(search.loaded, {}, { fetched: (s, { hits }) => ({ ...s, hits }) });
defineFlow(search.failed, {}, { [FAILURE]: (s, { reason }) => ({ ...s, reason: reason ?? null }) });

const finder = { search: { query: "", hits: [], reason: null } as SearchProps };

applyFlow(finder, [search], (sm) => {
  // The work. Its fifth argument is the transition's AbortSignal, which fetch takes.
  sm.addTransitionHandler(search.loaded, async (next, snapshot, prev, key, signal) => {
    const response = await fetch(`/api/search?q=${encodeURIComponent(next.query)}`, { signal });
    signal.throwIfAborted();
    if (!response.ok) {
      return HandlerResult.rejected(`HTTP ${response.status}`);
    }
    return search.loaded.results.fetched(await response.json());
  });
});

async function find(query: string) {
  await using send = await lock(finder);
  const pending = send(searchSignals.find({ query })); // InTransition: search.loading is committed
  const outcome = await pending.done();
  if (outcome.kind !== ResultKind.OK) {
    console.warn(`search failed: ${finder.search.reason}`); // search.failed is committed
  }
}
```

A transition handler is an abortable API: it passes the signal on to what can be cancelled (`fetch`,
`addEventListener(..., { signal })`), listens for `abort` on what cannot, calls `signal.throwIfAborted()` after each
await, and joins conditions of its own with `AbortSignal.any([signal, own.signal])`. The signal aborts whenever the
work's result will not commit, and its `reason` is a `TransitionAborted` whose `kind` says why:

| `kind` | When | Message |
|---|---|---|
| `aborted` | an abort of the transition was accepted | `aborted by <signal>` |
| `timeout` | the work outlasted `timeoutMs`; failed has committed | `<path> did not reach <variant> within <ms> ms` |
| `disposed` | `disposeFlow` ran during the work | `flow disposed` |
| `failed` | a handler of the work refused, or the end step did not commit; failed has committed | `failed: <the refusal's message>` |

On every kind the handler releases what it acquired, except a `DisposableBox` it returns in a named result, which
the engine disposes unless a committed state holds it. When next commits, the signal never aborts, and whatever the
handler returns or throws after an abort is dropped.

While the transition is pending, the lock holder's other sends queue behind it and run after the end, in order;
only an abort passes. `find` holds the lock while it waits, so a cancel button aborts through a bare dispatch:
`dispatch(finder, searchSignals.cancel(), { abort: true })`. The abort is accepted because the committed `loading`
has a reducer for `cancel` that commits something: the work's signal aborts with `aborted by cancel`, the engine
waits for the work to settle (no longer than what is left of its timeout), drops its result, and commits `idle`;
the find's `done()` resolves to Rejected `aborted by cancel`. An abort whose reducers change nothing is Rejected,
and the transition continues. See [StateResult.transition](/docs/api-reference#state-result-transition) for every
outcome.

## Signal Validation

### Parameter Validation

A reducer checks the payload against the state before it decides:

```typescript
const formSignals = { submit: defineSignal<{ email: string; password: string }>("submit") };

const form = defineState<{ email: string; attempts: number }>()
  .name("form")
  .signals(formSignals)
  .variant("editing", { initial: true })
  .variant("submitted")
  .build();

defineFlow(form.editing, {
  submit: (f, { email, password }) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return StateResult.rejected("invalid email");
    }
    if (password.length < 8) {
      return StateResult.rejected("the password needs 8 characters");
    }
    if (f.attempts >= 3) {
      return StateResult.rejected("too many attempts");
    }
    return form.submitted({ email, attempts: f.attempts + 1 });
  },
});
```

### Cross-State Validation

A reducer reads the other top-level states of the flow by name through `ctx.read`, in the snapshot from before the
signal, and checks their variants by name with `isIn`. The flow's definitions, given as the state's second type
argument, type both:

```typescript
type ShopStates = { account: typeof account; order: typeof order };

const account = defineState<{ verified: boolean }, ShopStates>()
  .name("account")
  .variant("guest", { initial: true })
  .variant("member")
  .build();

const order = defineState<{ items: number }, ShopStates>()
  .name("order")
  .signals({ checkout: defineSignal("checkout") })
  .variant("draft", { initial: true })
  .variant("placed")
  .build();

defineFlow(order.draft, {
  checkout: (o, _signal, ctx) => {
    const buyer = ctx.read("account");
    if (!isIn(buyer, "member") || !buyer.verified) {
      return StateResult.rejected("a verified account places orders");
    }
    return o.items === 0 ? StateResult.rejected("the order is empty") : order.placed(o);
  },
});
```

Every reducer reads the snapshot from before the signal, so none sees another reducer's answer to the same signal:
a rule over several states is a plain function of `ctx` that each reducer needing it calls.

## Signal Patterns

### Command and Query Separation

Signals are commands. Reading state needs no signal: the target holds the committed instances, and observers,
events and watches report changes.

```typescript
const recorderSignals = {
  start: defineSignal("start"),
  stop: defineSignal("stop"),
  setQuality: defineSignal<{ quality: "high" | "medium" | "low" }>("setQuality"),
};
```

### Signal Composition

Several signals under one lock run in order, with no other caller between them:

```typescript
async function seekThenPlay(time: number) {
  await using send = await lock(app);
  const seeked = await send(playerSignals.seek({ by: "time", time })).done();
  return seeked.kind === ResultKind.OK ? send(playerSignals.play()).done() : seeked;
}
```

### Follow-ups Belong to the Same Dispatch

A handler never sends a follow-up signal to its own target: a synchronous dispatch from inside the target's dispatch
throws. A follow-up change is part of the same dispatch instead:

- **A reducer** returns the final state directly: the next state is a pure function of the current one and the
  payload.
- **Every state the signal concerns has a reducer for it.** A signal reaches every state that lists it, so when a
  fact moves two states, each has a reducer for that fact.
- **A parent decides its nested states.** Its reducer returns the children as they must be, and the engine enters,
  exits and updates them in the same step.
- **An entry that waits for the world** is a declared transition, whose end, next or failed, is the follow-up.
- **A named result is a fact of the flow.** When the world's answer moves two states, the state whose handler
  returns it folds it, and the other has a result reducer of the same name, which takes it in the same step.
- **A fact from the world** that arrives later (a socket closed, a track ended) is sent as a new signal by whoever
  receives it, through `lock()`, after the dispatch that started the work returned.
- **A cross-target follow-up** takes the other target's lock: `await using send = await lock(other)`.

```typescript
// The source becoming ready moves both states.
const sourceSignals = { sourceReady: defineSignal<{ url: string }>("sourceReady") };

const source = defineState<{ url: string }>()
  .name("source")
  .signals(sourceSignals)
  .variant("loading", { initial: true })
  .variant("ready")
  .build();

const screen = defineState<{ visible: boolean }>()
  .name("screen")
  .signals(sourceSignals)
  .variant("waiting", { initial: true })
  .variant("showing")
  .build();

defineFlow(source.loading, { sourceReady: (s, { url }) => source.ready({ ...s, url }) });
defineFlow(screen.waiting, { sourceReady: (s) => screen.showing({ ...s, visible: true }) });
```

### Error Recovery Signals

Recovery is a signal like any other, with reducers on the failed variant:

```typescript
const recoverySignals = {
  retry: defineSignal<{ attempt: number }>("retry"),
  useCache: defineSignal("useCache"),
  reset: defineSignal("reset"),
};

const api = defineState<{ data: string | null; cached: string | null; attempt: number }>()
  .name("api")
  .signals(recoverySignals)
  .variant("idle", { initial: true })
  .variant("fetching")
  .variant("ready")
  .variant("failed")
  .build();

defineFlow(api.failed, {
  retry: (a, { attempt }) => (attempt > 3 ? StateResult.rejected("no more retries") : api.fetching({ ...a, attempt })),
  useCache: (a) => (a.cached === null ? StateResult.rejected("nothing cached") : api.ready({ ...a, data: a.cached })),
  reset: () => api.idle({ data: null, cached: null, attempt: 0 }),
});
```
