---
title: Architecture Guide
description: Patterns for building scalable StateFlow applications
---

Patterns for large StateFlow applications, such as media players and real-time clients: how to organize signals and states, where each kind of work belongs, and how resources live and end with the states that hold them. {% .lead %}

## Signal Organization at Scale

### Grouping Signals

Group signals by domain. Each state lists the group it takes. A reducer runs for the signal whose name is its key, so each key is its signal's name (`build()` throws for one that is not), and names stay unique across the groups of one flow: two signals that shared a name would run each other's reducers.

```typescript
const signals = {
  connection: {
    connect: defineSignal<{ url: string }>("connect"),
    disconnect: defineSignal("disconnect"),
  },
  media: {
    loadMedia: defineSignal<{ url: string }>("loadMedia"),
    mediaError: defineSignal<{ code: number; message: string }>("mediaError"),
  },
  playback: {
    play: defineSignal("play"),
    pause: defineSignal("pause"),
    seek: defineSignal<{ position: number; precise?: boolean }>("seek"),
    tick: defineSignal<{ currentTime: number }>("tick"),
  },
};
```

A payload may be a union, `defineSignal<{ by: "time"; time: number } | { by: "frame"; frame: number }>("seekTo")`: the factory takes any member, and a reducer narrows the payload by its discriminant.

### Naming Conventions

- A request names the action: `connect`, `loadMedia`, `seek`.
- A fact from the world names the event: `mediaError`, `tick`, `streamAdded`.
- A named result names what the world produced: `opened`, `loaded`.

## Multi-State Applications

### Coordinated States

An application is a set of focused states, each with its own signals, reducers and handlers. Declaring the flow's definitions on each state, `defineState<Props, AppStates>()`, types `ctx.read` by name:

```typescript
/** The app's socket: disposing it closes it. */
interface Socket extends Disposable {
  send(data: string): void;
  onDrop(listener: () => void): void;
}

type AppStates = { connection: typeof connectionState; media: typeof mediaState; playback: typeof playbackState };

function parseOpened(data: unknown): { socket: DisposableBox<Socket> } {
  const socket = (data as { socket?: unknown } | null)?.socket;
  if (!(socket instanceof DisposableBox)) {
    throw new TypeError("opened takes the socket in a DisposableBox");
  }
  return { socket };
}

function parseLoaded(data: unknown): { duration: number } {
  const duration = (data as { duration?: unknown } | null)?.duration;
  if (typeof duration !== "number" || duration < 0) {
    throw new TypeError("loaded takes a duration in seconds");
  }
  return { duration };
}

const connectionState = defineState<
  { url: string; retryCount: number; socket: DisposableBox<Socket> | null; reason: string | null },
  AppStates
>()
  .name("connection")
  .signals(signals.connection)
  .variant("disconnected", { initial: true })
  .variant("connecting", { transitional: true })
  .variant("connected", { async: true, results: { opened: parseOpened } })
  .variant("failed")
  .build();

const mediaState = defineState<{ url: string; duration: number }, AppStates>()
  .name("media")
  .signals(signals.media)
  .variant("idle", { initial: true })
  .variant("loading", { transitional: true })
  .variant("ready", { async: true, results: { loaded: parseLoaded } })
  .variant("error")
  .build();

const playbackState = defineState<{ position: number; duration: number }, AppStates>()
  .name("playback")
  .signals(signals.playback)
  .variant("stopped", { initial: true })
  .variant("playing")
  .variant("paused")
  .build();
```

### Rules Over Several States

A reducer reads the other states, as they were before the signal, through `ctx`. A rule over several states is a plain function of `ctx`, which every reducer it concerns calls; `isIn` checks a variant by name:

```typescript
// Playback needs a connection and loaded media.
function playbackRefusal(ctx: ReducerContext<AppStates>): StateResult | null {
  if (!isIn(ctx.read("connection"), "connected")) {
    return StateResult.rejected("cannot play while disconnected");
  }
  if (!isIn(ctx.read("media"), "ready")) {
    return StateResult.rejected("media not ready for playback");
  }
  return null;
}

// Loading is a declared transition; its work reports the duration as ready's named result loaded.
defineFlow(mediaState.idle, {
  loadMedia: (s, { url }) =>
    StateResult.transition(mediaState.ready({ ...s, url }), mediaState.loading({ ...s, url }), mediaState.error({ ...s, url })),
});
defineFlow(mediaState.ready, {}, { loaded: (s, { duration }) => ({ ...s, duration }) });

defineFlow(
  playbackState.stopped,
  { play: (s, _, ctx) => playbackRefusal(ctx) ?? playbackState.playing(s) },
  // loaded is a fact of the flow: a stopped playback takes it in the step that folds it into media.
  { loaded: (s, { duration }: { duration: number }) => ({ ...s, duration }) },
);
defineFlow(playbackState.paused, { play: (s, _, ctx) => playbackRefusal(ctx) ?? playbackState.playing(s) });
defineFlow(playbackState.playing, {
  pause: (s) => playbackState.paused(s),
  tick: (s, { currentTime }) => ({ ...s, position: currentTime }),
});
```

Every reducer of one signal runs on the same snapshot, so none sees another's answer to that signal. When one fact must move several states, each state has its own reducer for the signal that carries it, or a result reducer for the named result that carries it: a result reducer under a name its variant does not declare takes another state's result of that name in the step it folds in. One definition of a flow declares each result name; `applyFlow` throws for a second one.

### State Machines with Complex Transitions

A reducer branches on the signal and the state:

```typescript
const downloadSignals = {
  pauseDownload: defineSignal("pauseDownload"),
  progress: defineSignal<{ progress: number; bytes: number }>("progress"),
  networkError: defineSignal<{ message: string; recoverable: boolean }>("networkError"),
};

const downloadState = defineState<{
  url: string;
  progress: number;
  bytes: number;
  resumeFrom: number | null;
  error: string | null;
}>()
  .name("download")
  .signals(downloadSignals)
  .variant("idle", { initial: true })
  .variant("downloading")
  .variant("paused")
  .variant("completed")
  .variant("failed")
  .build();

defineFlow(downloadState.downloading, {
  pauseDownload: (s) => downloadState.paused({ ...s, resumeFrom: s.bytes }),
  progress: (s, { progress, bytes }) =>
    progress >= 100 ? downloadState.completed({ ...s, progress: 100, bytes }) : { ...s, progress, bytes },
  networkError: (s, { message, recoverable }) =>
    recoverable
      ? downloadState.paused({ ...s, resumeFrom: s.bytes, error: message })
      : downloadState.failed({ ...s, error: message }),
});
```

### Composition in Depth

A prop may hold another state's instance, or an `Items` of them: nested states, with their own signals, reducers and handlers. The parent decides its children: its instance says which children exist and in which variants, and the engine enters, exits and updates them as the parent's instance changes.

```typescript
const producerSignals = { pauseProducer: defineSignal<{ key: string }>("pauseProducer") };

const producer = defineState<{ track: Box<MediaStreamTrack>; paused: boolean }>()
  .name("producer")
  .signals(producerSignals)
  .variant("active", { initial: true })
  .build();

const transport = defineState<{ socket: Box<WebSocket> | null }>()
  .name("transport")
  .variant("closed", { initial: true })
  .variant("open")
  .build();

const sessionSignals = {
  addProducer: defineSignal<{ key: string; track: Box<MediaStreamTrack> }>("addProducer"),
  close: defineSignal("close"),
};

const session = defineState<{ transport: InstanceOf<typeof transport>; producers: Items<typeof producer> }>()
  .name("session")
  .signals(sessionSignals)
  .variant("idle", { initial: true })
  .variant("active")
  .build();

defineFlow(producer.active, {
  pauseProducer: (p, { key }, ctx) => (ctx.key === key ? { ...p, paused: true } : p),
});
defineFlow(session.active, {
  addProducer: (s, { key, track }) =>
    session.active({ ...s, producers: s.producers.with(key, producer.active({ track, paused: false })) }),
  // An empty map takes every producer out of its variant; the transport stays closed, as a new instance.
  close: () => session.idle({ transport: transport.closed({ socket: null }), producers: producer.items() }),
});
```

On `close`, the exits run children first and later siblings first: the producers, the last added first, then the session. Then the transport, kept in `closed` as a new instance, gets its update, and the session enters `idle`: updates and enters run after every exit, parents first. A node that changes only because a child changed gets no call of its own, so `pauseProducer` runs the producer's handlers and none of the session's.

## The Reducer Decides, the Handler Applies

The decision, validation and resolution live in the pure reducers, and the handlers only apply what the reducers resolved. A request the flow does not approve never reaches an effect:

```typescript
type Quality = { name: string; url: string };

type PlayerProps = {
  qualities: Quality[];
  preferredQuality: string | null;
  currentSourceUrl: string | null;
  pendingSourceUrl: string | null; // the source the reducer approved, for the handler to load
};

const qualitySignals = {
  setQuality: defineSignal<{ name: string }>("setQuality"),
  qualitiesLoaded: defineSignal<{ list: Quality[] }>("qualitiesLoaded"),
  srcLoaded: defineSignal<{ url: string }>("srcLoaded"),
};

const playerState = defineState<PlayerProps>()
  .name("player")
  .signals(qualitySignals)
  .variant("playing", { initial: true })
  .build();

// Decide, validate and resolve from the state's own props: the source to load, null for nothing to do, or the
// refusal.
function resolvePendingSource(s: PlayerProps): string | null | StateResult {
  if (s.preferredQuality === null) {
    return null;
  }
  const q = s.qualities.find((x) => x.name === s.preferredQuality);
  if (q === undefined) {
    // A loaded list without the name is an invalid request; a list not loaded yet keeps the preference for later.
    return s.qualities.length > 0 ? StateResult.rejected(`unknown quality: ${s.preferredQuality}`) : null;
  }
  return q.url === s.currentSourceUrl ? null : q.url;
}

defineFlow(playerState.playing, {
  // The request: a refusal goes back to the caller, and the resolved source goes on the pending prop.
  setQuality: (s, { name }) => {
    const next = { ...s, preferredQuality: name };
    const url = resolvePendingSource(next);
    return url instanceof StateResult ? url : { ...next, pendingSourceUrl: url };
  },
  // The authoritative data: a stale preference must not refuse a fresh list, so it stays unapplied.
  qualitiesLoaded: (s, { list }) => {
    const next = { ...s, qualities: list };
    const url = resolvePendingSource(next);
    return { ...next, pendingSourceUrl: url instanceof StateResult ? null : url };
  },
  // The record: the element loaded the source, which clears the pending prop, so the load does not fire again.
  srcLoaded: (s, { url }) => ({ ...s, currentSourceUrl: url, pendingSourceUrl: null }),
});

// The handler loads only what the reducer resolved; the element's load event sends srcLoaded.
sm.addUpdateHandler(playerState.playing, (s, snapshot, prev) => {
  if (s.pendingSourceUrl !== null && s.pendingSourceUrl !== prev.pendingSourceUrl) {
    loadSource(s.pendingSourceUrl);
  }
  return HandlerResult.ok();
});
```

- **Reject or wait on "not found":** reject only when the list is loaded and the name is absent; while the list loads, keep the preference.
- **Data updates do not refuse:** a reducer that takes the system's own data maps a refusal to "nothing to apply".
- **No reload loop:** the effect keys on the resolved prop, and the record signal clears it.

## Where Each Kind of Work Belongs

| You want to… | Use | When it runs |
|---|---|---|
| Decide the next state, validate, resolve | a reducer (pure) | first, before any effect |
| Hold a rule over several states | a plain function the reducers call on `ctx` | inside each reducer |
| Apply a state to the world on entry, exit or update | an enter, exit or update handler | before the commit; a Rejected or a throw refuses the step |
| Bring the world's data into props | a named result, folded by the variant's result reducer | after the enter phase, before the commit |
| Release what a refused step made | the step's `AbortSignal` (enter and update handlers) | when the step does not commit |
| Release what a step replaces | a commit delegate, `HandlerResult.ok().onCommit(fn)`, or a `DisposableBox` | after the commit |
| Tell the application that a state was entered | a commit handler | right after the commit; cannot fail |
| Publish an event of the target | `sm.defineEvent` | a later timer turn after the commit |
| Wait for the world on entry | an `{ async: true }` variant, entered by `StateResult.transition(next, temp, failed)`; the work is its transition handlers | temp at once; next or failed when the work settles or times out |
| React to committed variants | `observe()` | a later timer turn |
| React to any condition over the flow | `watch()` | a later timer turn |
| See every change | `subscribeFlow()` | a timer turn per change |
| Follow up on another target | `lock(otherTarget)` and `send` | in order, under that target's lock |
| Wait until the flow is quiet | `settled(target)` | after every delivery and the locks they asked for |

Handlers read their arguments, never the target:

```typescript
sm.addUpdateHandler(playbackState.playing, (state, snapshot) => {
  video.currentTime = state.position; // the new value of this step
  const media = mediaState(snapshot); // a sibling's new value, from the step's snapshot
  video.title = media.url;
  return HandlerResult.ok();
});
```

- **The arguments are the step's values.** During a handler the target still holds the values from before the commit; `state` and `snapshot` hold the new ones.
- **A resource belongs to the state that holds it.** It is acquired by a handler of that variant (the transition handler, for an entry that waits for it), enters props as a named result in a `Box`, and is released when a committed step drops it. An event from the resource becomes a signal, sent through a lock, never a write from its callback.
- **Handlers apply; reducers decide.** A check that must refuse a signal belongs in a reducer, which refuses before any effect.

## Resource Management

### Acquire on Entry, Release on Drop

Connecting is a declared transition: the work of the transition into `connected` opens the socket, which enters props as a named result in a `DisposableBox`. The engine disposes it once no committed state holds it: after the step that drops it, at `disposeFlow`, and when the transition ends without committing it. `auth.token`, `openSocket` and `probeDuration` are the application's, and each rejects when the signal aborts:

```typescript
const connect = (s: Infer<typeof connectionState>, url: string) =>
  StateResult.transition(
    connectionState.connected({ ...s, url, socket: null, reason: null }),
    connectionState.connecting({ ...s, url }),
    connectionState.failed({ ...s, url, retryCount: s.retryCount + 1 }),
    { timeoutMs: 5000 },
  );

defineFlow(connectionState.disconnected, { connect: (s, { url }) => connect(s, url) });
defineFlow(
  connectionState.failed,
  { connect: (s, { url }) => connect(s, url) },
  { [FAILURE]: (s, { reason }) => ({ ...s, reason: reason ?? null }) },
);
// connecting's reducer is the abort reducer: disconnect while the socket opens.
defineFlow(connectionState.connecting, { disconnect: (s) => connectionState.disconnected(s) });
defineFlow(
  connectionState.connected,
  { disconnect: (s) => connectionState.disconnected({ ...s, socket: null }) },
  { opened: (s, { socket }) => ({ ...s, socket }) },
);

const app = {
  connection: { url: "", retryCount: 0, socket: null, reason: null },
  media: { url: "", duration: 0 },
  playback: { position: 0, duration: 0 },
};

applyFlow(app, [connectionState, mediaState, playbackState], (sm) => {
  sm.addTransitionHandler(connectionState.connected, async (next, snapshot, prev, key, signal) => {
    const token = await auth.token({ signal });
    const socket = await openSocket(next.url, token, { signal });
    // In a DisposableBox the socket is the engine's: it disposes it at every end that does not commit it.
    return connectionState.connected.results.opened({ socket: DisposableBox.of(socket) });
  });

  // The load's work; playback takes the result it returns, as its result reducer above says.
  sm.addTransitionHandler(mediaState.ready, async (next, snapshot, prev, key, signal) =>
    mediaState.ready.results.loaded({ duration: await probeDuration(next.url, { signal }) }),
  );

  // A drop is a fact from the world: it becomes a signal, sent through a lock.
  sm.addCommitHandler(connectionState.connected, (s) => {
    s.socket?.deref().onDrop(async () => {
      await using send = await lock(app);
      await send(signals.connection.disconnect()).done();
    });
  });

  // The temp's exit handler runs in every step that leaves it: the end, the failed end, an abort's step. After a
  // refused end step it runs again in the failed end, so hiding twice must be harmless.
  sm.addExitHandler(connectionState.connecting, () => {
    hideConnectingIndicator();
    return HandlerResult.ok();
  });
});
```

### Replacing a Resource

A handler that replaces a resource keeps the old one until the step commits. With a plain `Box`, it releases the old one in a commit delegate, and the new one when the step's signal aborts:

```typescript
type Decoder = { close(): void };

function parseDecoding(data: unknown): { decoder: Box<Decoder> } {
  const decoder = (data as { decoder?: unknown } | null)?.decoder;
  if (!isBox(decoder)) {
    throw new TypeError("decoding takes the decoder in a Box");
  }
  return { decoder: decoder as Box<Decoder> };
}

const stream = defineState<{ codec: string; decoder: Box<Decoder> | null }>()
  .name("stream")
  .signals({ setCodec: defineSignal<{ codec: string }>("setCodec") })
  .variant("live", { initial: true, results: { decoding: parseDecoding } })
  .build();

defineFlow(stream.live, { setCodec: (s, { codec }) => ({ ...s, codec }) }, { decoding: (s, { decoder }) => ({ ...s, decoder }) });

sm.addUpdateHandler(stream.live, (s, snapshot, prev, key, signal) => {
  const decoder = createDecoder(s.codec);
  signal.addEventListener("abort", () => decoder.close(), { once: true });
  return stream.live.results.decoding({ decoder: Box.of(decoder) }).onCommit(() => prev.decoder?.deref().close());
});
```

With a `DisposableBox`, the engine does both. An exit handler runs in every step that leaves its instance, so a refused step and the failed step after it may both call it: what it does at once must bear a second call, and a release that must happen once goes in its commit delegate or in a `DisposableBox` (see [Releases After the Commit](/docs/state-consistency#releases-after-the-commit)).

### Disposal

`disposeFlow(target)` tears the flow down: no exit handler runs, every `DisposableBox` the final states hold is disposed, a pending transition ends with an Error and its work's signal aborts (kind `disposed`), and from then on every send answers `Rejected`, whatever its lock: one taken before, one still waiting, or one asked for afterwards. `settled(target)` then waits for the deliveries set before it, such as the events of the last commits; an observer's or a watch's callback among them is dropped, since `disposeFlow` removed it:

```typescript
class VideoPlayerApplication implements AsyncDisposable {
  readonly connection = { url: "", retryCount: 0, socket: null as DisposableBox<Socket> | null, reason: null as string | null };
  readonly #observers: Disposable[] = [];

  constructor() {
    applyFlow(this, [connectionState], (sm) => {
      // the handlers of the connection, as above
    });

    this.#observers.push(observe(this, [connectionState.failed], (s) => console.warn("connection failed:", s.reason)));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const observer of this.#observers) {
      observer[Symbol.dispose]();
    }
    disposeFlow(this); // closes the socket, which a DisposableBox holds
    await settled(this);
  }
}

// The caller owns the player: `await using player = new VideoPlayerApplication();`
```

## Integration Patterns

### Services

A handler reaches a service by closure: its second argument is the step's snapshot, not a context. Registering the handlers of each concern in a function of its own keeps one initializer short:

```typescript
interface Services {
  analytics: { track(event: string, data: Record<string, unknown>): void };
}

function registerAnalytics(sm: StateManager, services: Services): void {
  // An event to the outside belongs to a commit handler: it runs after the commit and cannot fail it.
  sm.addCommitHandler(playbackState.playing, (state, snapshot) => {
    services.analytics.track("playback_started", { url: mediaState(snapshot).url, position: state.position });
  });
}
```

### Events In and Out

Events from the outside become signals, sent through a lock so that they queue behind a pending transition. What the states mean for the outside world is done by handlers:

```typescript
function forwardVideoEvents(target: { playback: Infer<typeof playbackState> }, video: HTMLVideoElement): void {
  video.addEventListener("pause", async () => {
    await using send = await lock(target);
    await send(signals.playback.pause()).done();
  });
  video.addEventListener("timeupdate", async () => {
    await using send = await lock(target);
    // muted: no log entry for a signal four times a second
    await send(signals.playback.tick({ currentTime: video.currentTime }), { mute: true }).done();
  });
}

function applyToVideo(sm: StateManager, video: HTMLVideoElement): void {
  sm.addEnterHandler(playbackState.paused, () => {
    video.pause();
    return HandlerResult.ok();
  });
}
```

A target that emits events of its own defines them with the flow, `sm.defineEvent(name, changed, payload?)`, and the engine calls the target's `emit` after the commits that change what the event reports (see [State Visibility](/docs/state-visibility#events-of-the-target)).

## Performance

- **Observe narrowly.** An observer names its variants, and its compare decides which changes reach its callback, so an expensive callback runs only for the changes it needs.
- **Count equal answers as no change.** With `equalAnswers: "value"` in the flow's config, a reducer answer of its node's variant with equal props counts as the node's instance, so no handler runs and nothing commits there; the price is a walk of the props for such answers.
- **Mute what is frequent.** `send(signal, { mute: true })` writes no log entry.
- **Know the price of `DisposableBox`.** Until the process makes its first one, a dispatch skips the box checks and scans. From then on, every dispatch reads the props of every node of the states it may commit: on Node 24, a bare dispatch of a six-prop state with a nested state and a box takes about 9% longer than one with no box made (see [DisposableBox](/docs/api-reference#disposable-box)).

```typescript
// Hands the latest instance of each variant to `handle` once per microtask.
class BatchedObserver<S> {
  readonly #pending = new Map<string, S>();
  #scheduled = false;

  constructor(private readonly handle: (state: S) => void) {}

  readonly onChange = (state: S): void => {
    this.#pending.set(String(stateVar(state)), state);
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => this.#flush());
    }
  };

  #flush(): void {
    for (const state of this.#pending.values()) {
      this.handle(state);
    }
    this.#pending.clear();
    this.#scheduled = false;
  }
}

const batched = new BatchedObserver((state: InstanceOf<typeof mediaState>) => renderMedia(state));
using mediaObserver = observe(app, [mediaState.ready, mediaState.error], batched.onChange, (prev, cur) => prev.url !== cur.url);
```

### Validation at the Boundary

A state's parser gets what a factory is given and returns the props, a plain object; a throw from it is the reducer's Error. A schema library's parse fits, as does a hand-written check:

```typescript
type TrackProps = { id: string; kind: "audio" | "video"; bitrate: number };

const trackState = defineState<TrackProps>()
  .name("track")
  .variant("ready", { initial: true })
  .parser((value) => {
    const { id, kind, bitrate } = value as Partial<TrackProps>;
    if (typeof id !== "string" || (kind !== "audio" && kind !== "video") || !(typeof bitrate === "number" && bitrate > 0)) {
      throw new TypeError(`invalid track: ${serializeDebug(value)}`);
    }
    return { id, kind, bitrate };
  })
  .build();
```

## Error Handling and Recovery

A failure is a state of its own: the reducer names it, and the reason reaches it through `FAILURE` (see [Acquire on Entry, Release on Drop](#acquire-on-entry-release-on-drop)). Degradation that the reducers can decide from the data is a variant too:

```typescript
type QualityLevel = { name: string; bitrate: number };

const adaptiveSignals = {
  networkDegraded: defineSignal<{ bandwidth: number; reason: string }>("networkDegraded"),
  networkImproved: defineSignal<{ bandwidth: number }>("networkImproved"),
};

const adaptiveQuality = defineState<{ current: QualityLevel; available: QualityLevel[]; note: string | null }>()
  .name("adaptiveQuality")
  .signals(adaptiveSignals)
  .variant("auto", { initial: true })
  .variant("degraded")
  .variant("unavailable")
  .build();

// The best level that fits the bandwidth, if any.
const bestFor = (levels: QualityLevel[], bandwidth: number): QualityLevel | undefined =>
  levels.filter((level) => level.bitrate <= bandwidth).sort((a, b) => b.bitrate - a.bitrate)[0];

defineFlow(adaptiveQuality.auto, {
  networkDegraded: (s, { bandwidth, reason }) => {
    const fallback = bestFor(s.available, bandwidth);
    return fallback === undefined
      ? adaptiveQuality.unavailable({ ...s, note: "no level fits the network" })
      : adaptiveQuality.degraded({ ...s, current: fallback, note: `downgraded: ${reason}` });
  },
});

defineFlow(adaptiveQuality.degraded, {
  networkImproved: (s, { bandwidth }) => {
    const better = bestFor(s.available, bandwidth);
    return better !== undefined && better.bitrate > s.current.bitrate
      ? adaptiveQuality.auto({ ...s, current: better, note: null })
      : StateResult.ignored("no better level");
  },
});
```
