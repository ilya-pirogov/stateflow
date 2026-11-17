---
title: Core Concepts
description: Understanding StateFlow's fundamental architecture
---

StateFlow splits state logic in two: pure reducers decide where a target goes, and handlers apply that decision to
the world. This page walks through the pieces with one running example: a document editor that saves. {% .lead %}

_The snippets share one setup. Names such as `upload` or `showError` stand for the application's own code._

## The Model in One Paragraph

A signal asks a target to change. The reducers of the variants the target is in decide, purely and synchronously,
where it goes, and where it lands when entering fails. Handlers attached to variants make the effects: enter, exit
and update handlers inside the step, transition handlers as the work of an entry that waits for the world, commit
handlers after the commit. A handler never chooses a state: it succeeds or refuses. Data reaches props in two ways:
from the caller in a signal's payload, and from the world in a handler's named result, which a result reducer folds
into props. The kind and reason of a failure reach the failed state the same way, through the built-in `FAILURE`
result. With every handler switched off, the whole flow runs with no handler's effect, and mocks supply the world's
answers.

## Signals

A signal is a typed command, and the only way to ask for a change. A union payload gives one factory that takes
any member:

```typescript
const docSignals = {
  edit: defineSignal<{ text: string }>("edit"),
  save: defineSignal("save"),
  cancel: defineSignal("cancel"),
};

const insert = defineSignal<{ kind: "text"; text: string } | { kind: "image"; url: string }>("insert");

docSignals.edit({ text: "Hello" });
insert({ kind: "image", url: "https://example.com/cat.png" });
```

A state lists the signals it takes, each under its name, and a reducer runs for the signal whose name is its key.

## States

A state is a set of named variants over one props type. Every instance is a deep-frozen snapshot, and a live
resource goes in a `Box` (see [Live Resources](#live-resources)).

```typescript
type DocProps = { text: string; revision: number; reason: string | null };

const doc = defineState<DocProps>()
  .name("doc")
  .signals(docSignals)
  .variant("editing", { initial: true })
  .variant("saving", { transitional: true })
  .variant("saved", { async: true, results: { stored: (data) => data as { revision: number } } })
  .variant("failed")
  .stringRepr((d) => `rev ${d.revision}, ${d.text.length} chars`)
  .build();
```

- `{ initial: true }` marks the variant `applyFlow` starts the state in.
- `{ transitional: true }` marks a variant held only as the temporary state of a declared transition.
- `{ async: true }` marks a variant entered only at the end of a declared transition, after the work its
  transition handlers do.
- `results` declares the variant's named results, each with the parser of its data.

## Flows

`defineFlow` gives a variant its reducers: pure, synchronous functions from the instance and the payload to what
the instance becomes.

```typescript
const editing = (d: DocProps, text: string) => doc.editing({ ...d, text, reason: null });

defineFlow(doc.editing, {
  edit: (d, { text }) => ({ ...d, text }),
  // An entry that waits for the world names all three ends: saving commits at once, then saved, or failed.
  save: (d) => StateResult.transition(doc.saved(d), doc.saving(d), doc.failed(d), { timeoutMs: 10_000 }),
});

// saving's reducer is an abort reducer: cancel during a save stops it.
defineFlow(doc.saving, { cancel: (d) => doc.editing(d) });

defineFlow(
  doc.saved,
  { edit: (d, { text }) => editing(d, text) },
  { stored: (d, { revision }) => ({ ...d, revision }) },
);

// failed takes the reason of the failure through the built-in FAILURE result.
defineFlow(
  doc.failed,
  { edit: (d, { text }) => editing(d, text) },
  { [FAILURE]: (d, { reason }) => ({ ...d, reason: reason ?? null }) },
);
```

- A reducer returns props, which keep the variant; an instance of its own state; or a `StateResult`: `ok`,
  `transition`, `ignored`, `rejected` or `error`.
- Every reducer the signal reaches runs, all on the frozen snapshot from before the signal, and their verdicts
  merge: a Rejected or Error from any of them refuses the dispatch, and nothing commits.
- A signal no reducer takes is Ignored, and a reducer that returns the instance it was given changes nothing. With
  `equalAnswers: "value"`, a next of the same variant with equal props changes nothing either (see
  [applyFlow](/docs/api-reference#apply-flow)).
- A variant's reducers are defined once.

## Reading Other States

A reducer reads another top-level state of the flow by name with `ctx.read`, in the snapshot from before the
signal, and checks its variant by name with `isIn`. Declaring the flow's definitions as the state's second type
argument types both, so a state module needs only a type import of the others:

```typescript
type EditorStates = { doc: typeof doc; toolbar: typeof toolbar };

const toolbar = defineState<{ shared: boolean }, EditorStates>()
  .name("toolbar")
  .signals({ share: defineSignal("share") })
  .variant("ready", { initial: true })
  .build();

defineFlow(toolbar.ready, {
  share: (t, _signal, ctx) => (isIn(ctx.read("doc"), "saved") ? { shared: true } : StateResult.rejected("save first")),
});
```

A rule over several states is a plain function of `ctx` that every reducer needing it calls.

## Handlers

`applyFlow` puts the states on a target and registers the handlers. Every effect lives in a handler attached to a
variant:

```typescript
import { EventEmitter } from "events";

class Editor extends EventEmitter {
  doc: DocProps = { text: "", revision: 0, reason: null };
  toolbar = { shared: false }; // the toolbar state of "Reading Other States" above

  constructor() {
    super();
    applyFlow(this, [doc, toolbar], (sm) => {
      // The work of the entry into saved. Its signal aborts whenever its result will not commit.
      sm.addTransitionHandler(doc.saved, async (next, snapshot, prev, key, signal) => {
        const { revision } = await upload(next.text, { signal });
        signal.throwIfAborted();
        return doc.saved.results.stored({ revision });
      });

      // Events to the application, right after the commit.
      sm.addCommitHandler(doc.failed, (d) => {
        showError(d.reason);
      });

      // A public event of the flow, emitted through the target's own emit().
      sm.defineEvent("saved", (cur, prev) => cur.doc.revision !== prev.doc.revision, (cur) => cur.doc.revision);
    });
  }
}
```

| Adder | Runs |
|---|---|
| `addEnterHandler` | when a step enters the variant |
| `addExitHandler` | when a step leaves it |
| `addUpdateHandler` | when a reducer gives it a new instance of the same variant |
| `addTransitionHandler` | as the work of a declared transition into an asynchronous variant; returns a promise |
| `addCommitHandler` | right after the commit, wherever an enter handler runs; cannot refuse |

Every handler gets `(state, snapshot, prev, key)`: the instance it is about (for an exit, the instance it leaves),
the frozen snapshot of the step, the previous instance, and a nested state's key. Enter, exit and update handlers
run inside the step, before the commit, and are synchronous; a Rejected or a throw from one refuses the step, and
nothing commits unless the reducer declared a failed state. Nothing undoes what the handlers that ran did, so two
tools keep a refused step from leaking into the world:

- **The step's AbortSignal**, the fifth argument of an enter or update handler, aborts when the step does not
  commit, and never once it committed. The handler releases there what it made.
- **Commit delegates** run right after the commit, and a step that does not commit drops them:
  `HandlerResult.ok().onCommit(release)`. A handler that replaces a resource releases the old one in a delegate.

```typescript
type Poll = { stop(): void };

const feed = defineState<{ url: string; poll: Box<Poll> | null }>()
  .name("feed")
  .signals({ retarget: defineSignal<{ url: string }>("retarget") })
  .variant("live", { initial: true, results: { polled: (data) => data as { poll: Box<Poll> } } })
  .build();

defineFlow(feed.live, { retarget: (f, { url }) => ({ ...f, url }) }, { polled: (f, { poll }) => ({ ...f, poll }) });

const reader = { feed: { url: "", poll: null } };
applyFlow(reader, [feed], (sm) => {
  sm.addUpdateHandler(feed.live, (f, snapshot, prev, key, signal) => {
    const poll = startPoll(f.url);
    // The step did not commit: the new poll stops.
    signal.addEventListener("abort", () => poll.stop());
    // It committed: the old one stops.
    return feed.live.results.polled({ poll: Box.of(poll) }).onCommit(() => prev.poll?.deref().stop());
  });
});
```

## Results

Every dispatch returns a `Result`, so no signal fails silently:

```typescript
async function save(editor: Editor) {
  await using send = await lock(editor);
  const outcome = await send(docSignals.save()).done();
  if (outcome.kind !== ResultKind.OK) {
    showError(editor.doc.reason);
  }
}
```

| Kind | Meaning |
|---|---|
| `OK` | The signal committed, or a declared transition reached its next. |
| `Ignored` | No reducer took the signal. |
| `InTransition` | A declared transition is pending; `done()` resolves to its end. |
| `Rejected` | A reducer or a handler refused; nothing committed, or the declared failed states did. |
| `Error` | A reducer or a handler threw or broke a rule; as for Rejected. |

A reducer returns a `StateResult` (or props or an instance bare); a handler returns a `HandlerResult`: `ok`,
`ignored`, `rejected`, `error`, or a named result of its variant, such as `doc.saved.results.stored({ revision })`.
`.expect(...kinds)` throws for another kind, checked at `.done()` on a pending result.

## Lock: The Dispatch Pathway

`lock()` and its `send()` are the way to dispatch. A lock is exclusive and served in the order `lock()` was called;
`await using` releases it at the end of the scope:

```typescript
const editor = new Editor();

{
  await using send = await lock(editor);
  await send(docSignals.edit({ text: "Hello" })).done();
  await send(docSignals.save()).done();
}
```

While a declared transition is pending, the holder's sends queue behind it and are reduced in order after its end,
and the release waits until no transition is pending. A bare `dispatch()` is deprecated: it throws while a lock is
held or a transition is pending, and remains for synchronous teardown, bootstrap before any lock exists, and the
abort of a transition whose lock another caller holds.

## Transitions and Failed

A handler never chooses the next state: it applies the decision or refuses it. Where the target goes when a handler
refuses is part of the reducer's answer too:

- **`failed`.** `StateResult.ok(next, failed)` names where the node goes when a handler of the step refuses: an
  instance of the node's state. Without it, nothing commits.
- **`FAILURE`.** What led to the failure reaches the failed state through a result the engine delivers: any variant
  takes it with a result reducer keyed by the exported symbol `FAILURE`, `(state, { kind, reason, error, data }) => props`.
  `kind` is `rejected`, `error`, `timeout` or `aborted` (see [Failed](/docs/api-reference#failed)); `data` is the
  record a handler gave with its refusal, `HandlerResult.rejected(message, data)`, if it gave one.
- **No rollback.** The step into failed calls the handlers of the nodes it changes, as any step does: where it
  leaves the instance the refused step left, that exit runs again, so an exit's immediate effect must bear a second
  call; where it holds the instance the refused step entered or updated, that enter or update runs again; a node the
  failed keeps as the same instance gets no call. The refused step's enter and update handlers release what they
  made when its AbortSignal aborts, before the step into failed makes its calls.
- **The floor.** The step into failed commits whatever its own handlers return; a refusal there makes the result
  an Error.
- **The asynchronous mark.** `{ async: true }` says, where the state is defined, that entering the variant waits for
  the world. A node enters it only as the `next` of a declared transition, and only it takes transition handlers.
- **A declared transition.** `StateResult.transition(next, temp, failed, { timeoutMs })` names all three ends. Temp
  commits at once; the transition handlers of the asynchronous variants the end enters are the work, started
  together with one AbortSignal. When the work succeeds, its named results fold into next and next commits; when
  it refuses, fails or times out, failed commits. One declared transition per dispatch, over the whole tree.
- **The transition's AbortSignal** aborts whenever the work's result will not commit, with a `TransitionAborted`
  whose `kind` is `aborted`, `timeout`, `disposed` or `failed`. On every kind the handler releases what it acquired,
  except a `DisposableBox` it returns in a named result, which the engine disposes unless a committed state holds it.
- **An abort.** `send(signal, { abort: true })` runs the signal's reducers on the committed snapshot, which holds
  temp; when they commit something, the work's signal aborts and their states commit. So a transitional variant's
  reducers, such as `saving`'s `cancel` above, are abort reducers.

## Nested States

A prop may hold another state's instance, or an `Items` of them (a map, or a set keyed by each element). Those are
nested states: the engine finds them by value, with nothing to declare, and they take signals and run handlers
like top-level states.

```typescript
type Track = { id: string };

const producerSignals = { pause: defineSignal<{ key: string }>("pause") };

const producer = defineState<{ track: Box<Track>; paused: boolean }>()
  .name("producer")
  .signals(producerSignals)
  .variant("active", { initial: true })
  .build();

const media = defineState<{ producers: Items<typeof producer> }>()
  .name("media")
  .signals({ addTrack: defineSignal<{ key: string; track: Track }>("addTrack") })
  .variant("idle", { initial: true })
  .build();

// The parent decides its children: a new key enters, a removed one exits.
defineFlow(media.idle, {
  addTrack: (m, { key, track }) => ({
    producers: m.producers.with(key, producer.active({ track: Box.of(track), paused: false })),
  }),
});

// One signal reaches every reducer in the tree; each producer picks itself by its key.
defineFlow(producer.active, {
  pause: (p, { key }, ctx) => (ctx.key === key ? { ...p, paused: true } : StateResult.ignored()),
});
```

- The parent's instance says which children exist and in which variants; the engine compares the old and the new
  tree position by position and runs the children's enter, exit and update handlers. Exits run children first;
  enters and updates run parents first.
- A nested reducer gets its parent's instance as `ctx.parent` and its key as `ctx.key`; a nested handler gets the
  key as its fourth argument.
- A child's answer lands at its position in its parent's answer. A parent that replaced or removed a child whose
  own reducer answered too is an Error.
- A declared transition of a nested state lifts into its parents: their temp, next and failed hold the child's.

## Observability

Observation cannot break a commit: every observer, event, watch and subscriber is told after the commit set every
state, its callback runs on a later turn of the flow's timers, and nothing it throws reaches the dispatch.

```typescript
editor.on("saved", (revision: number) => console.log(`saved as revision ${revision}`));

// A variant observer: the callback gets the committed instance.
using saved = observe(editor, [doc.saved], (d) => console.log(`saved: ${d.text}`));

// A watch: any condition over the flow's states, attached and released at any time.
using typing = watch(
  editor,
  (cur, prev) => cur.doc.text !== prev.doc.text,
  (cur) => console.log(`${cur.doc.text.length} chars`),
);

// Every committed change, nested nodes included.
using changes = subscribeFlow(editor, (change) => console.log(`${change.stateName}: ${change.nextVariant}`));

// Resolves once everything above has been delivered.
await settled(editor);
```

- `observe(target, variants, callback, compare?)` tells of each node that changes into one of the variants,
  top-level or nested, with the node's path.
- An event, `sm.defineEvent(name, changed, payload?)`, is part of the flow: after each commit `changed(cur, prev)`
  decides, and the target's own `emit` fires it.
- `watch(target, changed, callback)` is the same test with a callback, for code outside the flow.
- `subscribeFlow(target, subscriber)` delivers one `FlowChange` per changed node.
- `settled(target)` waits until no delivery is left, the locks those deliveries asked for were served, and no
  transition is pending.

Observers keep running with handlers off, so a change of the world belongs in a handler, not in an observer.

## Live Resources

Props are data, deep-frozen. A live resource (a socket, a `MediaStream`, a DOM element) goes in a `Box`: a reducer
may place it but not read it, since `Box.deref()` throws inside a reducer. A `DisposableBox` holds a value with
`Symbol.dispose` or `Symbol.asyncDispose`, which the engine disposes: after every step, each box the step carried
that the committed states no longer hold, a refused step's together with the step into failed after it, and at
`disposeFlow` every box the final states hold. A dispatch that would hold one box in two places, or one already
disposed, is an Error before any handler runs, and a step whose named results would is refused before its commit. See
[Boxing live resources](/docs/boxing-live-resources) and [DisposableBox](/docs/api-reference#disposable-box).

```typescript
// The engine disposes the old subscription once a step commits the new one, and the new one if the step does not.
type Subscription = { [Symbol.dispose](): void };

type Sub = { sub: DisposableBox<Subscription> };

const presence = defineState<{ room: string; sub: DisposableBox<Subscription> | null }>()
  .name("presence")
  .signals({ join: defineSignal<{ room: string }>("join") })
  .variant("online", { initial: true, results: { subscribed: (data) => data as Sub } })
  .build();

defineFlow(
  presence.online,
  { join: (p, { room }) => ({ ...p, room }) },
  { subscribed: (p, { sub }) => ({ ...p, sub }) },
);

const lobby = { presence: { room: "", sub: null } };
applyFlow(lobby, [presence], (sm) => {
  sm.addUpdateHandler(presence.online, (p) =>
    presence.online.results.subscribed({ sub: DisposableBox.of(subscribe(p.room)) }),
  );
});
```

## Simulation

With effects only in handlers, a whole target runs with every handler switched off: `setHandlersDisabled(true)`
keeps reducers, commits, observers and the log, and stops every handler; the engine still disposes the
`DisposableBox`es that steps drop. `mockHandlers` supplies the world's answers for one variant, whether the switch
is on or not:

```typescript
using stored = mockHandlers(doc.saved, { transition: async () => doc.saved.results.stored({ revision: 7 }) });
setHandlersDisabled(true);
try {
  const sim = new Editor();
  await using send = await lock(sim);
  await send(docSignals.save()).done();
  // sim.doc is doc.saved at revision 7, and no handler touched the world.
} finally {
  setHandlersDisabled(false);
}
```

See [setHandlersDisabled](/docs/api-reference#set-handlers-disabled) for what such a run does not cover, and
[Testing](/docs/testing) for the patterns.
