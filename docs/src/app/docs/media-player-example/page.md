---
title: Media Player Example
description: Complete implementation of a media player using StateFlow
---

A media player built on StateFlow: four states share one set of signals, loading and starting playback are declared transitions, the element's facts reach props as named results, a failure's reason arrives through `FAILURE`, and the player publishes events of its own. Every call to the element sits in a handler, so a test runs the whole player with every handler switched off. {% .lead %}

## Signal Definitions

Every state lists the signals it takes, so they come first:

```typescript
type Range = { start: number; end: number };

const mediaSignals = {
  load: defineSignal<{ url: string }>("load"),
  play: defineSignal("play"),
  pause: defineSignal("pause"),
  stop: defineSignal("stop"),
  retry: defineSignal("retry"),
  seek: defineSignal<{ position: number; preview?: boolean }>("seek"),
  setPlaybackRate: defineSignal<{ rate: number }>("setPlaybackRate"),
  setVolume: defineSignal<{ level: number }>("setVolume"),
  mute: defineSignal("mute"),
  unmute: defineSignal("unmute"),
  toggleMute: defineSignal("toggleMute"),
  timeUpdate: defineSignal<{ position: number }>("timeUpdate"),
  bufferUpdate: defineSignal<{ ranges: Range[]; health: number }>("bufferUpdate"),
  handleError: defineSignal<{ message: string }>("handleError"),
  showControls: defineSignal("showControls"),
  hideControls: defineSignal("hideControls"),
  startSeeking: defineSignal("startSeeking"),
  endSeeking: defineSignal("endSeeking"),
};
```

## State Architecture

### Playback

Playback runs from loading to the end. Two variants are transitional: `loading` and `starting` hold the player only while a declared transition's work runs. Two are asynchronous: `ready` and `playing` are entered only at the end of a declared transition, once the element did its work. `ready` declares two named results: `loaded`, the duration the element reports, and `tracking`, the ticker that reports progress while media is attached, in a `DisposableBox` that the engine disposes once a committed step drops it.

```typescript
function parseLoaded(data: unknown): { duration: number } {
  const duration = (data as { duration?: unknown } | null)?.duration;
  if (typeof duration !== "number" || !(duration >= 0)) {
    throw new TypeError("loaded takes a duration in seconds");
  }
  return { duration };
}

function parseTracking(data: unknown): { ticker: DisposableBox<Ticker> } {
  const ticker = (data as { ticker?: unknown } | null)?.ticker;
  if (!(ticker instanceof DisposableBox)) {
    throw new TypeError("tracking takes the ticker in a DisposableBox");
  }
  return { ticker };
}

const playbackState = defineState<{
  position: number; // seconds
  duration: number; // seconds
  playbackRate: number;
  stalled: boolean; // playing, but the buffer is starving
  mediaUrl: string | null;
  lastError: string | null; // why the last load, play or playback failed
  ticker: DisposableBox<Ticker> | null;
}>()
  .name("playback")
  .signals(mediaSignals)
  .variant("idle", { initial: true })
  .variant("loading", { transitional: true })
  .variant("ready", { async: true, results: { loaded: parseLoaded, tracking: parseTracking } })
  .variant("starting", { transitional: true })
  .variant("playing", { async: true })
  .variant("paused")
  .variant("ended")
  .variant("error")
  .stringRepr((s) => {
    const base = `${s.position.toFixed(1)}/${s.duration.toFixed(1)}s`;
    if (s.lastError !== null) {
      return `${base} - ${s.lastError}`;
    }
    return s.playbackRate === 1 ? base : `${base} @${s.playbackRate}x`;
  })
  .build();
```

### Volume, Buffer and Controls

```typescript
const volumeState = defineState<{ level: number; muted: boolean; previousLevel: number }>()
  .name("volume")
  .signals(mediaSignals)
  .variant("audible", { initial: true })
  .variant("muted")
  .stringRepr((s) => (s.muted ? "muted" : `${Math.round(s.level * 100)}%`))
  .build();

const bufferState = defineState<{ bufferedRanges: Range[]; isBuffering: boolean; bufferHealth: number }>()
  .name("buffer")
  .signals(mediaSignals)
  .variant("empty", { initial: true })
  .variant("buffering")
  .variant("sufficient")
  .variant("starving")
  .stringRepr((s) => `health ${s.bufferHealth.toFixed(2)}`)
  .build();

const uiState = defineState<{ seekPreview: number | null }>()
  .name("ui")
  .signals(mediaSignals)
  .variant("hidden", { initial: true })
  .variant("visible")
  .variant("seeking")
  .stringRepr((s) => (s.seekPreview === null ? "" : `preview at ${s.seekPreview}s`))
  .build();
```

## State Flows

### Playback

Loading and starting wait for the element, so they are declared transitions into asynchronous variants: the reducer names next, temp and failed, the engine commits temp at once, and the transition handler of the variant entered does the work (see [The Player](#the-player)). The work only succeeds or refuses; where the player goes in either case is the reducer's decision. The reason of a refusal reaches `lastError` through the `[FAILURE]` reducers of `error` and `paused`, the two failed states.

```typescript
type PlaybackProps = Infer<typeof playbackState>;

// loading commits at once; ready commits, the duration folded in, when the load's work returns loaded; error commits,
// with the reason, when the work fails or times out.
const loadTransition = (s: PlaybackProps) =>
  StateResult.transition(playbackState.ready(s), playbackState.loading(s), playbackState.error(s), { timeoutMs: 30_000 });

// starting commits at once; playing follows when the element plays, and paused, with the reason, when it refuses.
const playTransition = (s: PlaybackProps) =>
  StateResult.transition(
    playbackState.playing({ ...s, stalled: false, lastError: null }),
    playbackState.starting(s),
    playbackState.paused(s),
    { timeoutMs: 5_000 },
  );

const recordFailure = (s: PlaybackProps, { reason }: { reason?: string }) => ({ ...s, lastError: reason ?? null });

// idle drops the ticker, which the engine then disposes.
const stop = () =>
  playbackState.idle({ position: 0, duration: 0, playbackRate: 1, stalled: false, mediaUrl: null, lastError: null, ticker: null });

// A preview moves the controls' preview (see the ui flows), not the playback.
const seek = (s: PlaybackProps, { position, preview }: { position: number; preview?: boolean }) => {
  if (preview === true) {
    return StateResult.ignored("a preview does not move the playback");
  }
  if (position < 0 || position > s.duration) {
    return StateResult.rejected(`invalid seek position: ${position}`);
  }
  return { ...s, position };
};

defineFlow(playbackState.idle, {
  load: (s, { url }) => loadTransition({ ...s, mediaUrl: url, position: 0, duration: 0, lastError: null }),
  play: () => StateResult.rejected("no media loaded"),
  seek: () => StateResult.rejected("no media loaded"),
});

// A transitional variant's reducers are abort reducers: dispatch(player, stop(), { abort: true }) cancels a load.
defineFlow(playbackState.loading, { stop });

defineFlow(
  playbackState.ready,
  { play: (s) => playTransition(s), stop, seek },
  {
    loaded: (s, { duration }) => ({ ...s, duration }),
    tracking: (s, { ticker }) => ({ ...s, ticker }),
  },
);

// A pause while the element starts aborts the play: dispatch(player, pause(), { abort: true }).
defineFlow(playbackState.starting, { pause: (s) => playbackState.paused(s) });

defineFlow(playbackState.playing, {
  pause: (s) => playbackState.paused({ ...s, stalled: false }),
  stop,
  seek,
  timeUpdate: (s, { position }) =>
    s.duration > 0 && position >= s.duration - 0.1
      ? playbackState.ended({ ...s, position, stalled: false, ticker: null })
      : { ...s, position },
  // The playback follows the buffer: the same signal reaches both states, which read it the same way.
  bufferUpdate: (s, { health }) =>
    isStarving(health) === s.stalled ? StateResult.ignored("stall unchanged") : { ...s, stalled: isStarving(health) },
  setPlaybackRate: (s, { rate }) =>
    rate < 0.25 || rate > 4 ? StateResult.rejected("the rate must be between 0.25 and 4") : { ...s, playbackRate: rate },
  handleError: (s, { message }) => playbackState.error({ ...s, stalled: false, ticker: null, lastError: message }),
});

defineFlow(playbackState.paused, { play: (s) => playTransition(s), stop, seek }, { [FAILURE]: recordFailure });

defineFlow(
  playbackState.error,
  {
    retry: (s) => (s.mediaUrl === null ? StateResult.rejected("no media to retry") : loadTransition({ ...s, lastError: null })),
    load: (s, { url }) => loadTransition({ ...s, mediaUrl: url, lastError: null }),
  },
  { [FAILURE]: recordFailure },
);

defineFlow(playbackState.ended, { stop });
```

### Buffer

The buffer's variant follows its health, and playback follows the buffer. One signal, `bufferUpdate`, reaches both states, and every reducer reads the snapshot from before the signal, so neither sees the other's answer. The rule they share is a plain function, which both call on the signal:

```typescript
type BufferProps = Infer<typeof bufferState>;

/** A buffer with less than a tenth of its target ahead is starving. */
const isStarving = (health: number) => health < 0.1;

const bufferReducer = (s: BufferProps, { ranges, health }: { ranges: Range[]; health: number }) => {
  const next = { ...s, bufferedRanges: ranges, bufferHealth: health, isBuffering: health < 1 };
  if (ranges.length === 0) {
    return bufferState.empty(next);
  }
  if (isStarving(health)) {
    return bufferState.starving(next);
  }
  return health < 0.5 ? bufferState.buffering(next) : bufferState.sufficient(next);
};

defineFlow(bufferState.empty, { bufferUpdate: bufferReducer });
defineFlow(bufferState.buffering, { bufferUpdate: bufferReducer });
defineFlow(bufferState.sufficient, { bufferUpdate: bufferReducer });
defineFlow(bufferState.starving, { bufferUpdate: bufferReducer });
```

### Volume and Controls

```typescript
const checkLevel = (level: number) => (level < 0 || level > 1 ? StateResult.rejected("the volume must be between 0 and 1") : null);

defineFlow(volumeState.audible, {
  setVolume: (s, { level }) =>
    checkLevel(level) ?? { ...s, level, previousLevel: s.level > 0 ? s.level : s.previousLevel },
  mute: (s) => volumeState.muted({ ...s, muted: true, previousLevel: s.level }),
  toggleMute: (s) => volumeState.muted({ ...s, muted: true, previousLevel: s.level }),
});

defineFlow(volumeState.muted, {
  unmute: (s) => volumeState.audible({ ...s, muted: false, level: s.previousLevel }),
  toggleMute: (s) => volumeState.audible({ ...s, muted: false, level: s.previousLevel }),
  // A new volume while muted unmutes.
  setVolume: (s, { level }) => checkLevel(level) ?? volumeState.audible({ ...s, muted: false, level }),
});

defineFlow(uiState.hidden, { showControls: (s) => uiState.visible(s) });
defineFlow(uiState.visible, {
  hideControls: (s) => uiState.hidden(s),
  startSeeking: (s) => uiState.seeking({ ...s, seekPreview: null }),
});
defineFlow(uiState.seeking, {
  // A preview moves the preview; the final seek ends the seeking.
  seek: (s, { position, preview }) => (preview === true ? { ...s, seekPreview: position } : uiState.visible({ ...s, seekPreview: null })),
  endSeeking: (s) => uiState.visible({ ...s, seekPreview: null }),
});
```

## The Player

The player is the flow's target: it holds one prop per state, the element it drives, and the events it emits. All of its state lives in StateFlow, every call to the element sits in a handler, and its public events are defined with the flow:

```typescript
import { EventEmitter } from "events";

/** Whether a commit moved a state into `variant`: true when `cur` is in it and `prev` was not. */
const entered = (cur: object, prev: object, variant: StateVariant) => stateVar(cur) === variant && stateVar(prev) !== variant;

class MediaPlayer extends EventEmitter {
  readonly playback = {
    position: 0,
    duration: 0,
    playbackRate: 1,
    stalled: false,
    mediaUrl: null as string | null,
    lastError: null as string | null,
    ticker: null as DisposableBox<Ticker> | null,
  };
  readonly volume = { level: 0.7, muted: false, previousLevel: 0.7 };
  readonly buffer = { bufferedRanges: [] as Range[], isBuffering: false, bufferHealth: 0 };
  readonly ui = { seekPreview: null as number | null };

  constructor(readonly element: HTMLVideoElement) {
    super();
    applyFlow(
      this,
      [playbackState, bufferState, volumeState, uiState],
      (sm) => {
        // The load's work: it reports the duration as ready's named result; the element's error, the 30 s timeout
        // or a stop's abort commits another state, and waitForEvent rejects on the signal's abort.
        sm.addTransitionHandler(playbackState.ready, async (next, snapshot, prev, key, signal) => {
          this.element.src = next.mediaUrl ?? "";
          this.element.load();
          await waitForEvent(this.element, "loadedmetadata", signal);
          return playbackState.ready.results.loaded({ duration: this.element.duration });
        });

        // Entering ready starts the ticker. If the step does not commit, the engine disposes it with the dropped
        // named result; once committed, it is disposed by the step that drops it: stop, the end, an error.
        sm.addEnterHandler(playbackState.ready, () =>
          playbackState.ready.results.tracking({ ticker: DisposableBox.of(new Ticker(this)) }),
        );

        // A temp's commit handler runs before its work, and its exit handler on every end that leaves it.
        sm.addCommitHandler(playbackState.loading, () => showLoadingSpinner());
        sm.addExitHandler(playbackState.loading, () => {
          hideLoadingSpinner();
          return HandlerResult.ok();
        });

        sm.addEnterHandler(playbackState.idle, () => {
          this.element.removeAttribute("src");
          this.element.load(); // detaches the old media
          return HandlerResult.ok();
        });
        sm.addEnterHandler(playbackState.error, () => {
          this.element.removeAttribute("src");
          return HandlerResult.ok();
        });

        // The play's work. play() cannot be cancelled, so the handler pauses the element on every abort: a pause
        // while it is pending, the timeout, a failure. Once playing commits, the signal never aborts.
        sm.addTransitionHandler(playbackState.playing, async (next, snapshot, prev, key, signal) => {
          signal.addEventListener("abort", () => this.element.pause(), { once: true });
          await this.element.play(); // rejects when the browser refuses to play
          signal.throwIfAborted();
          this.element.playbackRate = next.playbackRate;
          return HandlerResult.ok();
        });

        sm.addEnterHandler(playbackState.paused, () => {
          this.element.pause();
          return HandlerResult.ok();
        });

        sm.addUpdateHandler(playbackState.playing, (s, snapshot, prev) => {
          if (Math.abs(this.element.currentTime - s.position) > 0.5) {
            this.element.currentTime = s.position;
          }
          this.element.playbackRate = s.playbackRate;
          if (s.stalled !== prev.stalled) {
            setBufferingIndicator(s.stalled);
          }
          return HandlerResult.ok();
        });

        sm.addUpdateHandler(volumeState.audible, (s) => {
          this.element.volume = s.level;
          this.element.muted = false;
          return HandlerResult.ok();
        });
        sm.addEnterHandler(volumeState.audible, (s) => {
          this.element.volume = s.level;
          this.element.muted = false;
          return HandlerResult.ok();
        });
        sm.addEnterHandler(volumeState.muted, () => {
          this.element.muted = true;
          return HandlerResult.ok();
        });

        // The player's public events: emitted through its own emit, on a timer turn after the commit.
        sm.defineEvent("loaded", (cur, prev) => entered(cur.playback, prev.playback, playbackState.ready), (cur) => cur.playback.duration);
        sm.defineEvent("ended", (cur, prev) => entered(cur.playback, prev.playback, playbackState.ended));
        sm.defineEvent("failed", (cur, prev) => entered(cur.playback, prev.playback, playbackState.error), (cur) => cur.playback.lastError);
      },
      { logHandlers: [mediaPlayerLog] },
    );
  }
}
```

## Helper Functions

```typescript
/** Reports the element's position and buffer to the player four times a second, until it is disposed. */
class Ticker implements Disposable {
  readonly #interval: ReturnType<typeof setInterval>;

  constructor(player: MediaPlayer) {
    this.#interval = setInterval(() => void reportProgress(player), 250);
  }

  [Symbol.dispose](): void {
    clearInterval(this.#interval);
  }
}

async function reportProgress(player: MediaPlayer): Promise<void> {
  const { buffered, currentTime } = player.element;
  const ranges: Range[] = [];
  for (let i = 0; i < buffered.length; i += 1) {
    ranges.push({ start: buffered.start(i), end: buffered.end(i) });
  }
  const current = ranges.find((r) => currentTime >= r.start && currentTime <= r.end);
  const health = Math.min((current === undefined ? 0 : current.end - currentTime) / 10, 1); // 10 s ahead is full health

  // The lock queues these sends behind a pending transition; muted, they write no log entry.
  await using send = await lock(player);
  await send(mediaSignals.timeUpdate({ position: currentTime }), { mute: true }).done();
  await send(mediaSignals.bufferUpdate({ ranges, health }), { mute: true }).done();
}

/** Resolves on `event`; rejects on the element's error event, or when `signal` aborts. */
function waitForEvent(element: HTMLMediaElement, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      element.removeEventListener(event, onEvent);
      element.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(element.error ?? new Error("media error"));
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    element.addEventListener(event, onEvent);
    element.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

/** Logs each entry, with the handler results that did not succeed. */
const mediaPlayerLog: StateFlowLogHandler = (entry) => {
  const failures = entry.handlerResults.filter((h) => !/^(OK|Ignored)\b/.test(h.result));
  console.log(entry.message, ...(failures.length > 0 ? [failures] : []));
};
```

## Usage Examples

```typescript
const player = new MediaPlayer(document.querySelector("video") as HTMLVideoElement);

player.on("loaded", (duration: number) => console.log(`loaded, ${duration}s`));
player.on("failed", (reason: string | null) => console.error("playback failed:", reason));

// Load, then play, under one lock: the second send queues behind the first one's transition.
async function loadAndPlay(url: string): Promise<void> {
  await using send = await lock(player);
  await send(mediaSignals.load({ url })).expect(ResultKind.OK).done();
  await send(mediaSignals.play()).expect(ResultKind.OK).done();
}

// A pause while the element starts aborts the play: the abort skips the lock that the pending play holds.
function handlePauseClick(): void {
  dispatch(player, mediaSignals.pause(), { abort: true });
}

async function handleSeekDrag(position: number): Promise<void> {
  await using send = await lock(player);
  send(mediaSignals.seek({ position, preview: true }));
}

async function handleSeekEnd(position: number): Promise<void> {
  await using send = await lock(player);
  send(mediaSignals.seek({ position })).expect(ResultKind.OK);
}

async function handleVolumeKeys(event: KeyboardEvent): Promise<void> {
  await using send = await lock(player);
  const level = player.volume.level;
  if (event.key === "ArrowUp") {
    send(mediaSignals.setVolume({ level: Math.min(level + 0.1, 1) }));
  } else if (event.key === "ArrowDown") {
    send(mediaSignals.setVolume({ level: Math.max(level - 0.1, 0) }));
  } else if (event.key === "m") {
    send(mediaSignals.toggleMute());
  }
}

// Retry a network failure after 3 seconds.
using recovery = observe(player, [playbackState.error], async (state) => {
  if (state.lastError?.includes("network")) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await using send = await lock(player);
    await send(mediaSignals.retry()).done();
  }
});

// Tear down: no exit handler runs, so the element is detached here; disposeFlow disposes the ticker.
async function closePlayer(): Promise<void> {
  disposeFlow(player);
  player.element.removeAttribute("src");
  await settled(player); // the events of the last commits have been emitted
}
```

## Testing the Media Player

With every handler off, the player never touches its element, and a transition mock gives the element's answer where a test needs one. A declared transition without a mock has no work, so its next commits inside the send:

```typescript
describe("media player", () => {
  let player: MediaPlayer;

  beforeEach(() => {
    setHandlersDisabled(true);
    player = new MediaPlayer({} as HTMLVideoElement);
  });

  afterEach(() => {
    setHandlersDisabled(false);
  });

  it("loads with the duration the element reports, then plays and pauses", async () => {
    using mocks = mockHandlers(playbackState.ready, {
      transition: async () => playbackState.ready.results.loaded({ duration: 120 }),
    });
    await using send = await lock(player);

    // load declares a transition with work, the mock: loading commits at once.
    const loading = send(mediaSignals.load({ url: "test.mp4" }));
    expect(loading.kind).toBe(ResultKind.InTransition);
    expect(stateVar(player.playback)).toBe(playbackState.loading);

    expect((await loading.done()).kind).toBe(ResultKind.OK);
    expect(stateVar(player.playback)).toBe(playbackState.ready);
    expect(player.playback.duration).toBe(120);

    // play has no work with every handler off: starting, then playing, inside the send.
    expect(send(mediaSignals.play()).kind).toBe(ResultKind.OK);
    expect(stateVar(player.playback)).toBe(playbackState.playing);

    expect(send(mediaSignals.pause()).kind).toBe(ResultKind.OK);
    expect(stateVar(player.playback)).toBe(playbackState.paused);
  });

  it("a refused play lands in paused, with the reason", async () => {
    using mocks = mockHandlers(playbackState.playing, {
      transition: async () => HandlerResult.rejected("autoplay refused"),
    });
    await using send = await lock(player);
    await send(mediaSignals.load({ url: "test.mp4" })).done();

    const playing = await send(mediaSignals.play()).done();

    expect(playing.kind).toBe(ResultKind.Rejected);
    expect(stateVar(player.playback)).toBe(playbackState.paused);
    expect(player.playback.lastError).toBe("autoplay refused");
  });

  it("emits ended once playback reaches the end", async () => {
    using mocks = mockHandlers(playbackState.ready, {
      transition: async () => playbackState.ready.results.loaded({ duration: 120 }),
    });
    const ended = vi.fn();
    player.on("ended", ended);

    {
      await using send = await lock(player);
      await send(mediaSignals.load({ url: "test.mp4" })).done();
      send(mediaSignals.play());
      send(mediaSignals.timeUpdate({ position: 120 }));
    }
    await settled(player);

    expect(stateVar(player.playback)).toBe(playbackState.ended);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("refuses a volume out of range, and changes nothing", async () => {
    await using send = await lock(player);

    expect(send(mediaSignals.setVolume({ level: 0.5 })).kind).toBe(ResultKind.OK);
    expect(send(mediaSignals.setVolume({ level: 1.5 })).kind).toBe(ResultKind.Rejected);
    expect(player.volume.level).toBe(0.5);
  });

  it("a preview seek moves the preview, and the final seek the playback", async () => {
    using mocks = mockHandlers(playbackState.ready, {
      transition: async () => playbackState.ready.results.loaded({ duration: 120 }),
    });
    await using send = await lock(player);
    await send(mediaSignals.load({ url: "test.mp4" })).done();
    send(mediaSignals.showControls());
    send(mediaSignals.startSeeking());

    send(mediaSignals.seek({ position: 60, preview: true }));
    expect(player.ui.seekPreview).toBe(60);
    expect(player.playback.position).toBe(0);

    send(mediaSignals.seek({ position: 60 }));
    expect(stateVar(player.ui)).toBe(uiState.visible);
    expect(player.playback.position).toBe(60);
  });
});
```
