---
title: State Consistency
description: How StateFlow guarantees consistent state through immutability and type safety
---

A target's state changes only through signals, one dispatch at a time. The reducers decide before any handler touches the world, a step commits whole or not at all, and a refused step leaves the state where its reducer said. Instances are deep-frozen, and the types check payloads and props at compile time. {% .lead %}

## Immutability

### Frozen Instances

Every instance is frozen deeply when it is built, so a committed state never changes (see [Boxing Live Resources](/docs/boxing-live-resources) for what the freeze keeps and refuses). A reducer answers with a new instance or new props, and the instance it was given stays as it was:

```typescript
const playbackSignals = { seek: defineSignal<{ position: number }>("seek") };

const playbackState = defineState<{ position: number; duration: number }>()
  .name("playback")
  .signals(playbackSignals)
  .variant("playing", { initial: true })
  .build();

defineFlow(playbackState.playing, {
  seek: (state, { position }) => ({ ...state, position }),
});

const before = playbackState.playing({ position: 30, duration: 180 });
// before.position = 45; // a type error, and a TypeError at run time in strict-mode code
```

A reducer that returns the instance it was given changes nothing and runs no handler. With `equalAnswers: "value"` in the flow's config, an answer of the same variant with equal props counts as that instance too.

### A Frozen Context

A reducer's third argument, `ctx`, is frozen. It reads the other top-level states as they were before the signal, by definition (`accountState(ctx)`) or by name (`ctx.read("account")`), and a nested state reads its parent through `ctx.parent` and its key through `ctx.key`. A write to it throws in strict-mode code, which modules and classes are, and the throw is the reducer's Error. A reducer decides its own node only.

## Atomic Steps

### One Dispatch at a Time

Callers send through a lock: `lock(target)` queues them in the order they called, and while a declared transition is pending, the holder's sends queue behind it and are reduced in order after it ends. A bare `dispatch` throws under a held lock or a pending transition. So dispatches on one target do not interleave: only an abort reaches a pending transition.

### Decide, Check, Apply, Commit

A dispatch runs in this order:

1. **Decide.** Every reducer the signal reaches, top-level or nested, runs on the frozen snapshot from before the signal, so none sees another's answer. Their verdicts merge: a Rejected or an Error refuses the dispatch, and the answers compose into one next snapshot. With no answer, the result is Ignored.
2. **Check.** Before any handler runs, the plan is refused with an Error when an answer breaks a rule: a parent replaced or removed a child whose own reducer answered too; a node would be left in a transitional variant; a node would enter an asynchronous variant other than at the end of a declared transition; two reducers declared a transition; the states the dispatch may commit hold one `DisposableBox` in two places or one already disposed, or a transition's end holds a box its temp drops (see [DisposableBox](/docs/boxing-live-resources#disposable-box)).
3. **Apply.** Exit handlers run (children first, later siblings first), then update handlers, then enter handlers (parents first). The named results the update and enter handlers return fold into their nodes, every other state with a result reducer of that name answers, and the handlers of the nodes those answers change run in a further round. When the fold and the answers leave one `DisposableBox` in two places, or place one already disposed, the step is refused before its commit.
4. **Commit.** Every top-level state that changed is set on the target.
5. **After the commit.** The commit delegates run, then the commit handlers, then the engine disposes the `DisposableBox`es the step carried that the committed states no longer hold.

Observers, watches, events and `subscribeFlow` subscribers are told after the commit set every state, and their callbacks run on later turns of the flow's timers. A throw from any of them is reported, in the log entry or with `console.error`, and cannot break the commit.

An exit, update or enter handler's Rejected or throw refuses the step: the other handlers of its phase still run, the later phases and the commit do not, and the result is that refusal (an Error for a throw). Nothing undoes what the handlers that ran did: the step's `AbortSignal` tells the enter and update handlers, the step's commit delegates are dropped, and the `DisposableBox`es it carried go with those of the step into failed after it, which keeps those it commits.

```typescript
const sessionSignals = { start: defineSignal("start") };

const playback = defineState<{ position: number }>()
  .name("playback")
  .signals(sessionSignals)
  .variant("paused", { initial: true })
  .variant("playing")
  .build();

const buffer = defineState<{ level: number }>()
  .name("buffer")
  .signals(sessionSignals)
  .variant("empty", { initial: true })
  .variant("filling")
  .build();

defineFlow(playback.paused, { start: (s) => playback.playing(s) });
defineFlow(buffer.empty, { start: (s) => buffer.filling(s) });

const session = { playback: { position: 0 }, buffer: { level: 0 } };

applyFlow(session, [playback, buffer], (sm) => {
  sm.addEnterHandler(buffer.filling, () => HandlerResult.rejected("no network"));
});

await using send = await lock(session);
const result = send(sessionSignals.start());

result.kind === ResultKind.Rejected; // true: buffer's enter handler refused the step
String(session.playback); // "playback.paused(position=0)": nothing committed
```

### The Step's AbortSignal

Enter and update handlers get the step's `AbortSignal` as their fifth argument. It aborts when the step does not commit, whatever stopped it: a handler refused or threw, a named result did not fold, another state's answer to one failed, the named results broke a `DisposableBox` rule. Once the step commits, it never aborts. A handler that makes something listens to it and releases what it made in that call. Its listeners run inside the dispatch, so, like handlers, they must not dispatch to or dispose their own target synchronously.

```typescript
type Poll = { stop(): void };

const pollSignals = { watch: defineSignal<{ url: string }>("watch") };

const poller = defineState<{ url: string; poll: Box<Poll> | null }>()
  .name("poller")
  .signals(pollSignals)
  .variant("idle", { initial: true })
  .variant("polling", { results: { started: (data) => data as { poll: Box<Poll> } } })
  .build();

defineFlow(poller.idle, { watch: (s, { url }) => poller.polling({ ...s, url }) });
defineFlow(poller.polling, { watch: (s, { url }) => ({ ...s, url }) }, { started: (s, { poll }) => ({ ...s, poll }) });

const monitor = { poller: { url: "", poll: null } };

applyFlow(monitor, [poller], (sm) => {
  sm.addEnterHandler(poller.polling, (s, snapshot, prev, key, signal) => {
    const poll = startPoll(s.url);
    // The step may still be refused by a later handler: then the poll never reaches props.
    signal.addEventListener("abort", () => poll.stop(), { once: true });
    return poller.polling.results.started({ poll: Box.of(poll) });
  });
});
```

### Releases After the Commit

A handler that replaces a resource must not release the old one before the commit: a later handler may still refuse the step, and the state would keep the old resource released. It attaches the release to the OK it returns, as a commit delegate:

```typescript
sm.addUpdateHandler(poller.polling, (s, snapshot, prev, key, signal) => {
  const poll = startPoll(s.url);
  signal.addEventListener("abort", () => poll.stop(), { once: true });
  // The old poll stops once the step commits; a refused step stops the new one and keeps the old.
  return poller.polling.results.started({ poll: Box.of(poll) }).onCommit(() => prev.poll?.deref().stop());
});
```

`onCommit(...delegates)` works on every result, plain or named, and keeps its kind. The delegates of a step run right after its commit, before its commit handlers, in the order of the handler calls that returned them, whatever their results' kind: an Ignored's in a step that commits, a Rejected's in a failed step, which commits whatever its handlers return. A step that does not commit drops them. A delegate is synchronous and its return value is ignored. A throw is logged as a `commit` handler result named by the handler that returned it, and the next delegate still runs.

A transition's temp step and its end each run their own handlers' delegates, and a transition handler's delegates run when the end step commits, before the end step's own; an end that does not commit drops them. A `DisposableBox` is the other way to release after the commit: the engine disposes it once the committed states no longer hold it (see [Boxing Live Resources](/docs/boxing-live-resources#disposable-box)).

### Failure States

A reducer names where a node goes when its step is refused: `failed`, an instance of the node's state, the second argument of `StateResult.ok` or the third of `StateResult.transition`. Without it, a refused step commits nothing. With it, the failed step follows in the same dispatch, from the instances before the signal (or a transition's committed temp) to the failed instances. The reason reaches the failed state through the built-in `FAILURE` result, which a variant takes with a result reducer keyed `[FAILURE]`:

```typescript
const playSignals = { play: defineSignal("play") };

const player = defineState<{ position: number; reason: string | null }>()
  .name("player")
  .signals(playSignals)
  .variant("paused", { initial: true })
  .variant("starting", { transitional: true }) // held only while play's work runs
  .variant("playing", { async: true }) // entered only at the end of a declared transition
  .variant("blocked")
  .build();

defineFlow(player.paused, {
  play: (s) => StateResult.transition(player.playing(s), player.starting(s), player.blocked(s)),
});
// blocked takes the reason of the failure.
defineFlow(player.blocked, {}, { [FAILURE]: (s, { reason }) => ({ ...s, reason: reason ?? null }) });

const media = { player: { position: 0, reason: null } };

applyFlow(media, [player], (sm) => {
  // The work: its result picks between playing and blocked.
  sm.addTransitionHandler(player.playing, async (next, snapshot, prev, key, signal) => {
    const started = await startMediaPlayback({ signal });
    return started ? HandlerResult.ok() : HandlerResult.rejected("playback was not allowed");
  });

  // Runs in every step that leaves the temp: playing, blocked, an abort's step; after a refused end step, again in
  // the failed end.
  sm.addExitHandler(player.starting, () => {
    hideSpinner();
    return HandlerResult.ok();
  });

  // A commit handler sees the committed instance, FAILURE folded in; an enter handler sees blocked as the reducer
  // declared it, before the fold.
  sm.addCommitHandler(player.blocked, (s) => showReason(s.reason));
});
```

The rules of the failed step:

- **It is the floor.** Its own handlers cannot stop its commit: when they refuse, it commits anyway, and the result is an Error.
- **Nothing is rolled back.** It calls the handlers of the nodes it changes, as any step does: where it leaves the instance the refused step left, that exit runs again; where it holds the instance the refused step entered or updated, that enter or update runs again; and a node the failed keeps as the same instance gets no call.
- **`FAILURE` carries the cause.** Every node it enters or updates whose variant has a `[FAILURE]` reducer gets `{ kind, reason, error, data }`: `kind` is `rejected`, `error`, `timeout` or `aborted`, `reason` the refusal's message or the error's, `error` the Error, and `data` the record a handler gave with its Rejected (`HandlerResult.rejected(message, data)`), when it gave one, so a failed state can decide from data rather than from text.

```typescript
const roomSignals = { switchOn: defineSignal("switchOn") };

const lamp = defineState<{ watts: number }>()
  .name("lamp")
  .variant("off", { initial: true })
  .variant("on")
  .build();

const room = defineState<{ lamp: InstanceOf<typeof lamp> }>()
  .name("room")
  .signals(roomSignals)
  .variant("dark", { initial: true })
  .variant("lit")
  .variant("broken")
  .build();

defineFlow(room.dark, {
  // broken keeps the lamp the room had, which the failed step gives no call. A `lamp.on(...)` instance put in both next
  // and failed would be entered again by the failed step.
  switchOn: (s) => StateResult.ok(room.lit({ lamp: lamp.on({ watts: 60 }) }), room.broken(s)),
});
```

An exit handler runs in every step that leaves its instance, a refused one included, so one dispatch may call it twice: in the refused step and in the failed step that leaves the same instance. An enter or update handler likewise runs again in the failed step that holds the instance the refused step entered or updated, once the refused step's `AbortSignal` aborted. The refused step drops the first call's delegates, and the second call's run at the failed commit. What an exit does at once must therefore bear a second call; a release that must happen once goes in its commit delegate, or the resource sits in a `DisposableBox`.

### Transitional and Asynchronous Variants

A variant declared with `{ transitional: true }` commits only as the temp of a declared transition. An answer that would leave a node in one, as next, as failed, or by keeping it during an abort, is an Error, and `applyFlow` refuses an initial state that holds one. So a node leaves it when its transition ends: to next, to failed, or by an abort reducer. Its reducers are the abort reducers of the transitions that pass through it.

A variant declared with `{ async: true }` is entered only as the next of a declared transition, whose work is the variant's transition handlers; only it takes transition handlers. An ok answer, a temp or a failed that enters one is an Error, and `applyFlow` refuses an initial state that holds one. The mark decides, not the registered handlers, so the check is the same with handlers off and with mocks. A transition whose end enters no asynchronous variant with a transition handler has no work, and its next commits inside the send.

One dispatch declares at most one transition: a target has one pending transition, with one lock, one abort and one timeout. Two reducers that declare one for the same signal are an Error.

### Parent and Child Conflicts

A nested state is decided by its own reducer, and its answer lands at its position in its parent's answer. A parent that keeps the child (the same instance, through `...s`) or does not answer composes with any answer of the child. A parent that replaces or removes a child whose own reducer answered the same signal is an Error, and nothing commits: two reducers would decide one state.

```typescript
const mediaSignals = { mute: defineSignal("mute"), close: defineSignal("close") };

const producer = defineState<{ id: string }>()
  .name("producer")
  .signals(mediaSignals)
  .variant("live", { initial: true })
  .variant("muted")
  .build();

const mediaState = defineState<{ muted: boolean; producers: Items<typeof producer> }>()
  .name("media")
  .signals(mediaSignals)
  .variant("active", { initial: true })
  .variant("idle")
  .build();

defineFlow(producer.live, { mute: (p) => producer.muted(p) });
defineFlow(mediaState.active, {
  // Keeps every producer as it is, so each producer's own answer to mute composes with this one.
  mute: (s) => ({ ...s, muted: true }),
  // Removes every producer: an Error if a producer's reducer also answers close.
  close: () => mediaState.idle({ muted: false, producers: producer.items() }),
});
```

## Type Safety

`Infer` gives a definition's or a variant's props, and `InstanceOf` the type of its instances:

```typescript
const connectionState = defineState<{ url: string; errorCount: number }>()
  .name("connection")
  .variant("active", { initial: true })
  .build();

type ConnectionProps = Infer<typeof connectionState>; // { url: string; errorCount: number }
type Connection = InstanceOf<typeof connectionState>;
```

A signal's payload is typed: a missing field, a field of the wrong type or an unknown field does not compile. A union payload gives one factory that takes any member, and a reducer narrows the payload by its discriminant. A payload that may be absent, `{ reason: string } | void`, makes a signal that takes none:

```typescript
const configSignals = {
  updateConfig: defineSignal<{ timeout: number; retryLimit: number }>("updateConfig"),
};
// configSignals.updateConfig({ timeout: 5000 }); // error: retryLimit is missing

const seek = defineSignal<{ by: "time"; time: number } | { by: "frame"; frame: number }>("seek");
seek({ by: "frame", frame: 25 });
// seek({ by: "time", frame: 25 }); // error: time is missing

const clip = defineState<{ at: number }>().name("clip").signals({ seek }).variant("paused", { initial: true }).build();

defineFlow(clip.paused, { seek: (c, s) => ({ ...c, at: s.by === "time" ? s.time : s.frame / 25 }) });
```

## Validation in Reducers

A reducer refuses what its state cannot take, before any handler runs:

```typescript
const audioSignals = { setVolume: defineSignal<{ level: number }>("setVolume") };

const audio = defineState<{ volume: number; muted: boolean }>()
  .name("audio")
  .signals(audioSignals)
  .variant("playing", { initial: true })
  .build();

defineFlow(audio.playing, {
  setVolume: (s, { level }) => {
    if (level < 0 || level > 1) {
      return StateResult.rejected("volume must be between 0 and 1");
    }
    if (s.muted && level > 0) {
      return StateResult.rejected("cannot set volume while muted");
    }
    return { ...s, volume: level };
  },
});
```

An invariant that several reducers could break is a plain function they all call on what they are about to return, and a rule over several states reads the others through `ctx`. Declaring the flow's definitions on the state, `defineState<Props, Defs>()` with a type-only `Defs`, types `ctx.read` by name, and `isIn` checks a variant by name, so a state module reads a sibling without importing its definition:

```typescript
type GameDefs = { board: typeof board; piece: typeof piece };

const gameSignals = { move: defineSignal<{ dx: number; dy: number }>("move") };

const board = defineState<{ size: number }, GameDefs>()
  .name("board")
  .variant("open", { initial: true })
  .variant("locked")
  .build();

const piece = defineState<{ x: number; y: number }, GameDefs>()
  .name("piece")
  .signals(gameSignals)
  .variant("placed", { initial: true })
  .build();

// Whichever reducer moves the piece, it stays on the board.
function onBoard(next: { x: number; y: number }, size: number): { x: number; y: number } | StateResult {
  const inside = next.x >= 0 && next.x < size && next.y >= 0 && next.y < size;
  return inside ? next : StateResult.rejected("the move leaves the board");
}

defineFlow(piece.placed, {
  move: (p, { dx, dy }, ctx) => {
    const b = ctx.read("board");
    if (isIn(b, "locked")) {
      return StateResult.rejected("the board is locked");
    }
    return onBoard({ x: p.x + dx, y: p.y + dy }, b.size);
  },
});
```
