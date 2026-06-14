---
title: Media Player Example
description: Complete implementation of a media player using StateFlow
---

This comprehensive example demonstrates how to build a fully-featured media player using StateFlow. The implementation showcases state consistency guarantees, signal handling with comprehensive feedback, and clear state visibility throughout the application lifecycle. {% .lead %}

## Overview

The media player implementation demonstrates several key StateFlow concepts working together in a real-world scenario. The player manages multiple interconnected states including playback control, volume management, buffering status, and error handling. Each state transition is carefully validated, side effects are properly managed, and the entire system maintains consistency even during complex operations like seeking or handling network interruptions.

## State Architecture

The media player consists of four primary state definitions that work together to manage the complete player functionality.

{% callout title="Snippets are shown out of execution order" %}
The state definitions below reference `mediaSignals` via `.signals(mediaSignals)`, but `mediaSignals` is defined in the [Signal Definitions](#signal-definitions) section further down. In real code `mediaSignals` must be declared **before** any state that wires it in — otherwise you hit a temporal dead zone (`Cannot access 'mediaSignals' before initialization`). Treat the Signal Definitions block as appearing first.
{% /callout %}

### Playback State

The playback state manages the core player lifecycle, tracking position, duration, and playback status. Each variant represents a distinct phase in the media lifecycle, from initial loading through active playback to completion.

```typescript
const playbackState = defineState<{
  position: number;      // Current playback position in seconds
  duration: number;      // Total media duration in seconds
  playbackRate: number;  // Playback speed multiplier
  mediaUrl?: string;     // Currently loaded media URL
  lastError?: Error;     // Most recent error if any
}>()
  .name("playback")
  .signals(mediaSignals)
  .variant("idle", true)
  .variant("loading")
  .variant("ready")
  .variant("playing")
  .variant("paused")
  .variant("ended")
  .variant("error")
  .stringRepr(state => {
    const base = `${state.position.toFixed(1)}/${state.duration.toFixed(1)}s`;
    if (state.playbackRate !== 1) {
      return `${base} @${state.playbackRate}x`;
    }
    if (state.lastError) {
      return `${base} - Error: ${state.lastError.message}`;
    }
    return base;
  })
  .build();
```

### Volume State

Volume management includes mute functionality with memory of previous volume levels, enabling smooth user experience when toggling mute status.

```typescript
const volumeState = defineState<{
  level: number;        // Volume level 0.0 to 1.0
  muted: boolean;       // Current mute status
  previousLevel: number; // Remembered level for unmute
}>()
  .name("volume")
  .signals(mediaSignals)
  .variant("audible", true)
  .variant("muted")
  .stringRepr(state => 
    state.muted ? "muted" : `${Math.round(state.level * 100)}%`
  )
  .build();
```

### Buffer State

Buffer state tracks media loading progress and readiness, providing visibility into network operations and enabling responsive UI updates.

```typescript
const bufferState = defineState<{
  bufferedRanges: Array<{ start: number; end: number }>;
  isBuffering: boolean;
  bufferHealth: number; // 0.0 to 1.0 indicating buffer sufficiency
}>()
  .name("buffer")
  .signals(mediaSignals)
  .variant("empty", true)
  .variant("buffering")
  .variant("sufficient")
  .variant("starving")
  .stringRepr(state => {
    const total = state.bufferedRanges.reduce(
      (sum, range) => sum + (range.end - range.start), 0
    );
    return `${total.toFixed(1)}s buffered (health: ${state.bufferHealth.toFixed(2)})`;
  })
  .build();
```

### UI State

UI state manages the player interface visibility and interaction modes, ensuring consistent user experience across different player states.

```typescript
const uiState = defineState<{
  controlsVisible: boolean;
  seekPreview?: number;    // Preview position during seek
  volumeSliderVisible: boolean;
  lastInteraction: number; // Timestamp of last user interaction
}>()
  .name("ui")
  .signals(mediaSignals)
  .variant("hidden", true)
  .variant("visible")
  .variant("seeking")
  .variant("adjustingVolume")
  .stringRepr(state => 
    state.controlsVisible ? "controls visible" : "controls hidden"
  )
  .build();
```

## Signal Definitions

Signals provide the controlled interface for all state modifications. Each signal is carefully designed to carry the necessary information while maintaining type safety.

```typescript
const mediaSignals = {
  // Media lifecycle signals
  load: defineSignal<{
    url: string;
    autoplay?: boolean;
  }>("load"),
  
  play: defineSignal("play"),
  pause: defineSignal("pause"),
  stop: defineSignal("stop"),
  
  // Playback control signals
  seek: defineSignal<{
    position: number;
    preview?: boolean; // True for preview during drag
  }>("seek"),
  
  setPlaybackRate: defineSignal<{
    rate: number;
  }>("setPlaybackRate"),
  
  // Volume control signals
  setVolume: defineSignal<{
    level: number;
  }>("setVolume"),
  
  mute: defineSignal("mute"),
  unmute: defineSignal("unmute"),
  toggleMute: defineSignal("toggleMute"),
  
  // Buffer management signals
  bufferUpdate: defineSignal<{
    ranges: Array<{ start: number; end: number }>;
    health: number;
  }>("bufferUpdate"),
  
  // UI interaction signals
  showControls: defineSignal("showControls"),
  hideControls: defineSignal("hideControls"),
  startSeeking: defineSignal("startSeeking"),
  endSeeking: defineSignal("endSeeking"),
  
  // Error handling signals
  handleError: defineSignal<{
    error: Error;
    recoverable: boolean;
  }>("handleError"),
  
  retry: defineSignal("retry"),
  
  // Progress update signal
  timeUpdate: defineSignal<{
    position: number;
    buffered: Array<{ start: number; end: number }>;
  }>("timeUpdate")
};
```

## State Flows

State flows define the valid transitions and business logic for each state variant. These flows ensure that the player behaves correctly in all situations.

### Playback State Flows

```typescript
defineFlow(playbackState.idle, {
  load: (state, signal) => playbackState.loading({
    ...state,
    mediaUrl: signal.url,
    position: 0,
    duration: 0,
    lastError: undefined
  }),
  
  play: () => Result.reject("No media loaded"),
  seek: () => Result.reject("No media loaded")
});

defineFlow(playbackState.loading, {
  handleError: (state, signal) => playbackState.error({
    ...state,
    lastError: signal.error
  }),
  
  bufferUpdate: (state, signal) => {
    // Transition to ready when we have initial buffer
    if (signal.health > 0.2 && signal.ranges.length > 0) {
      const duration = Math.max(...signal.ranges.map(r => r.end));
      return playbackState.ready({
        ...state,
        duration,
        position: 0
      });
    }
    return Result.ignore("Insufficient buffer");
  }
});

defineFlow(playbackState.ready, {
  play: (state) => playbackState.playing(state),
  
  seek: (state, signal) => {
    if (signal.position < 0 || signal.position > state.duration) {
      return Result.reject(`Invalid seek position: ${signal.position}`);
    }
    return { ...state, position: signal.position };
  }
});

defineFlow(playbackState.playing, {
  pause: (state) => playbackState.paused(state),
  
  stop: () => playbackState.idle({
    position: 0,
    duration: 0,
    playbackRate: 1,
    mediaUrl: undefined
  }),
  
  timeUpdate: (state, signal) => {
    const newState = { ...state, position: signal.position };
    
    // Check if playback has ended
    if (signal.position >= state.duration - 0.1) {
      return playbackState.ended(newState);
    }
    
    return newState;
  },
  
  seek: (state, signal) => {
    if (signal.position < 0 || signal.position > state.duration) {
      return Result.reject("Seek position out of range");
    }
    return { ...state, position: signal.position };
  },
  
  setPlaybackRate: (state, signal) => {
    if (signal.rate < 0.25 || signal.rate > 4.0) {
      return Result.reject("Playback rate must be between 0.25 and 4.0");
    }
    return { ...state, playbackRate: signal.rate };
  }
});

defineFlow(playbackState.error, {
  retry: (state) => {
    if (!state.mediaUrl) {
      return Result.reject("No media URL to retry");
    }
    return playbackState.loading({
      ...state,
      lastError: undefined
    });
  },
  
  load: (state, signal) => playbackState.loading({
    ...state,
    mediaUrl: signal.url,
    lastError: undefined
  })
});
```

### Volume State Flows

```typescript
defineFlow(volumeState.audible, {
  setVolume: (state, signal) => {
    if (signal.level < 0 || signal.level > 1) {
      return Result.reject("Volume must be between 0 and 1");
    }
    
    return {
      ...state,
      level: signal.level,
      previousLevel: state.level > 0 ? state.level : state.previousLevel
    };
  },
  
  mute: (state) => volumeState.muted({
    ...state,
    muted: true,
    previousLevel: state.level
  }),
  
  toggleMute: (state) => volumeState.muted({
    ...state,
    muted: true,
    previousLevel: state.level
  })
});

defineFlow(volumeState.muted, {
  unmute: (state) => volumeState.audible({
    ...state,
    muted: false,
    level: state.previousLevel
  }),
  
  toggleMute: (state) => volumeState.audible({
    ...state,
    muted: false,
    level: state.previousLevel
  }),
  
  setVolume: (state, signal) => {
    // Setting volume while muted unmutes and sets new volume
    if (signal.level < 0 || signal.level > 1) {
      return Result.reject("Volume must be between 0 and 1");
    }
    
    return volumeState.audible({
      ...state,
      muted: false,
      level: signal.level
    });
  }
});
```

## Application Integration

The media player integrates with the DOM through StateFlow's handler system, managing side effects and ensuring proper cleanup.

```typescript
interface MediaPlayerApp {
  playback: Infer<typeof playbackState>;
  volume: Infer<typeof volumeState>;
  buffer: Infer<typeof bufferState>;
  ui: Infer<typeof uiState>;
  
  // Non-state properties
  element: HTMLVideoElement;
  updateInterval?: number;
}

const player: MediaPlayerApp = {
  playback: {
    position: 0,
    duration: 0,
    playbackRate: 1
  },
  volume: {
    level: 0.7,
    muted: false,
    previousLevel: 0.7
  },
  buffer: {
    bufferedRanges: [],
    isBuffering: false,
    bufferHealth: 0
  },
  ui: {
    controlsVisible: false,
    volumeSliderVisible: false,
    lastInteraction: Date.now()
  },
  element: document.querySelector('#video-player') as HTMLVideoElement
};

applyFlow(
  player,
  [playbackState, volumeState, bufferState, uiState],
  (sm) => {
    // Playback state handlers
    sm.addEnterHandler(playbackState.loading, (state) => {
      return Result.transition(async () => {
        try {
          player.element.src = state.mediaUrl!;
          player.element.load(); // HTMLMediaElement.load() returns void — nothing to await
          
          // Start monitoring buffer
          startBufferMonitoring();
          
          return Result.ok();
        } catch (error) {
          // Resolving the transition to an error result rolls the state back;
          // dispatch cannot be called while a transition is in progress
          return Result.error(error);
        }
      }, 30000); // 30 second timeout for loading
    });
    
    sm.addEnterHandler(playbackState.playing, (state) => {
      // State handlers must return a Result synchronously; async work goes
      // inside Result.transition
      return Result.transition(async () => {
        try {
          await player.element.play();
          player.element.playbackRate = state.playbackRate;
          startProgressTracking();
          return Result.ok();
        } catch (error) {
          return Result.error(error);
        }
      });
    });
    
    sm.addExitHandler(playbackState.playing, () => {
      player.element.pause();
      stopProgressTracking();
      return Result.ok();
    });
    
    sm.addUpdateHandler(playbackState.playing, (state) => {
      // Handle seek while playing
      if (Math.abs(player.element.currentTime - state.position) > 0.5) {
        player.element.currentTime = state.position;
      }
      
      // Update playback rate if changed
      if (player.element.playbackRate !== state.playbackRate) {
        player.element.playbackRate = state.playbackRate;
      }
      
      return Result.ok();
    });
    
    // Volume state handlers
    sm.addUpdateHandler(volumeState.audible, (state) => {
      player.element.volume = state.level;
      player.element.muted = false;
      updateVolumeDisplay(state.level);
      return Result.ok();
    });
    
    sm.addEnterHandler(volumeState.muted, () => {
      player.element.muted = true;
      updateVolumeDisplay(0);
      return Result.ok();
    });
    
    // Buffer monitoring.
    // Side-effect handlers run synchronously BEFORE the transition flag is set, so a
    // reentrant bare dispatch() here does NOT throw. The cleaner follow-up pattern is to
    // return Result.enqueue(signal), which queues the signal to run after this dispatch
    // cycle commits instead of recursing inline.
    sm.addEnterHandler(bufferState.starving, () => {
      // Pause playback if buffer is critically low
      if (player.playback[Symbol.toStringTag] === "playback.playing") {
        dispatch(player, mediaSignals.pause());
        showBufferingIndicator();
      }
      return Result.ok();
    });
    
    sm.addExitHandler(bufferState.starving, () => {
      hideBufferingIndicator();
      // Auto-resume if we were playing
      if (player.playback[Symbol.toStringTag] === "playback.paused") {
        dispatch(player, mediaSignals.play());
      }
      return Result.ok();
    });
  },
  {
    logHandlers: [createMediaPlayerLogger()]
  }
);
```

## Helper Functions

Supporting functions manage the media element interaction and UI updates.

```typescript
function startProgressTracking() {
  player.updateInterval = window.setInterval(async () => {
    const element = player.element;
    
    // Build buffered ranges
    const buffered: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < element.buffered.length; i++) {
      buffered.push({
        start: element.buffered.start(i),
        end: element.buffered.end(i)
      });
    }
    
    // Acquire a lock so these periodic dispatches queue behind any in-flight
    // transition instead of throwing. The second argument to send() mutes logging.
    await using send = await lock(player);
    
    // Dispatch time update (muted to avoid log spam)
    await send(mediaSignals.timeUpdate({
      position: element.currentTime,
      buffered
    }), true).done();
    
    // Update buffer health
    const bufferAhead = calculateBufferAhead(
      element.currentTime,
      buffered
    );
    const health = Math.min(bufferAhead / 10, 1); // 10 seconds = full health
    
    await send(mediaSignals.bufferUpdate({
      ranges: buffered,
      health
    }), true).done();
  }, 250); // Update 4 times per second
}

function stopProgressTracking() {
  if (player.updateInterval) {
    clearInterval(player.updateInterval);
    player.updateInterval = undefined;
  }
}

function calculateBufferAhead(
  position: number,
  ranges: Array<{ start: number; end: number }>
): number {
  for (const range of ranges) {
    if (position >= range.start && position <= range.end) {
      return range.end - position;
    }
  }
  return 0;
}

function createMediaPlayerLogger(): StateFlowLogHandler {
  return (entry) => {
    // A rejected result reliably stringifies as "Rejected: <message>", so that prefix is
    // safe to match. An Error result, however, stringifies as String(error) (e.g.
    // "TypeError: ...") — it is NOT prefixed with "Error", so `finalResult.includes("Error")`
    // would both miss real errors and false-match any message that merely mentions "error".
    // The log entry carries no ResultKind, so detect failures structurally: any handler whose
    // recorded result is not an OK/Ignored marker is a problem. (If you have the Result in hand
    // at the dispatch site, check `result.kind === ResultKind.Error` directly instead.)
    const isRejected = entry.finalResult.startsWith("Rejected");
    const hasFailedHandler = entry.handlerResults.some(
      (h) => !/^(OK|Ignored)/.test(h.result)
    );

    const icon = hasFailedHandler && !isRejected ? "❌" :
                 isRejected ? "⚠️" :
                 entry.signal.includes("play") ? "▶️" :
                 entry.signal.includes("pause") ? "⏸️" :
                 entry.signal.includes("volume") ? "🔊" : "🎬";
    
    console.log(
      `${icon} ${entry.signal} → ${entry.finalResult}`,
      entry.stateChanges.length > 0 ? 
        entry.stateChanges.map(c => `${c.stateName}: ${String(c.newState)}`) :
        "No state changes"
    );
  };
}
```

## Usage Examples

The media player provides a clean API for common operations while maintaining state consistency.

```typescript
// Load and play media. Acquire a lock so the signals queue: lock() drains any
// in-flight transition for us, and `load` then `play` run in order even though each
// drives an async transition.
async function loadAndPlay(url: string) {
  await using send = await lock(player);

  await send(mediaSignals.load({ url, autoplay: true }))
    .expect(ResultKind.OK, ResultKind.Ignored)
    .done();
  await send(mediaSignals.play())
    .expect(ResultKind.OK, ResultKind.Ignored)
    .done();
  // lock released automatically at scope exit
}

// Seek with preview
async function handleSeekStart() {
  await using send = await lock(player);
  await send(mediaSignals.startSeeking()).expect(ResultKind.OK, ResultKind.Ignored).done();
}

async function handleSeekDrag(position: number) {
  await using send = await lock(player);
  await send(mediaSignals.seek({ position, preview: true }))
    .expect(ResultKind.OK, ResultKind.Ignored)
    .done();
}

async function handleSeekEnd(position: number) {
  await using send = await lock(player);
  await send(mediaSignals.seek({ position })).expect(ResultKind.OK, ResultKind.Ignored).done();
  await send(mediaSignals.endSeeking()).expect(ResultKind.OK, ResultKind.Ignored).done();
}

// Volume control with keyboard
async function handleVolumeKeys(event: KeyboardEvent) {
  const current = player.volume.level;
  await using send = await lock(player);
  
  switch (event.key) {
    case "ArrowUp":
      await send(mediaSignals.setVolume({ level: Math.min(current + 0.1, 1) }))
        .expect(ResultKind.OK, ResultKind.Ignored)
        .done();
      break;
      
    case "ArrowDown":
      await send(mediaSignals.setVolume({ level: Math.max(current - 0.1, 0) }))
        .expect(ResultKind.OK, ResultKind.Ignored)
        .done();
      break;
      
    case "m":
      await send(mediaSignals.toggleMute()).expect(ResultKind.OK, ResultKind.Ignored).done();
      break;
  }
}

// Error recovery
function setupErrorRecovery() {
  observe(
    player,
    [playbackState.error],
    async (state) => {
      console.error("Playback error:", state.lastError);
      
      // Auto-retry after 3 seconds for network errors
      if (state.lastError?.message.includes("network")) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        await using send = await lock(player);
        await send(mediaSignals.retry()).expect(ResultKind.OK, ResultKind.Ignored).done();
      }
    }
  );
}
```

## Testing the Media Player

StateFlow's predictable architecture makes testing straightforward. `createMediaPlayer` and `createMockVideoElement` below are illustrative test stubs that wire up a player against a fake `<video>` element.

```typescript
describe("Media Player", () => {
  let player: MediaPlayerApp;
  let mockElement: HTMLVideoElement;
  
  beforeEach(() => {
    mockElement = createMockVideoElement();
    player = createMediaPlayer(mockElement);
  });
  
  it("should handle play/pause cycle", async () => {
    // Acquire a lock so every signal queues behind the previous transition instead of
    // throwing "States are in transitioning". The `loading` and `playing` enter handlers
    // each return Result.transition, so their dispatches resolve as InTransition; awaiting
    // .done() drains the transition before the next signal runs.
    await using send = await lock(player);

    // Load media — idle -> loading (the loading enter handler runs an async transition)
    await send(mediaSignals.load({ url: "test.mp4" })).done();
    expect(player.playback[Symbol.toStringTag]).toBe("playback.loading");

    // Buffer fills enough to become ready — loading -> ready
    await send(mediaSignals.bufferUpdate({
      ranges: [{ start: 0, end: 120 }],
      health: 1
    })).done();
    expect(player.playback[Symbol.toStringTag]).toBe("playback.ready");

    // Play — ready -> playing. The enter handler transitions, so the immediate result is
    // InTransition; .done() resolves it to OK and commits the `playing` state.
    const playResult = send(mediaSignals.play());
    expect(playResult.kind).toBe(ResultKind.InTransition);
    expect((await playResult.done()).kind).toBe(ResultKind.OK);
    expect(player.playback[Symbol.toStringTag]).toBe("playback.playing");

    // Pause — playing -> paused (synchronous, resolves OK)
    const pauseResult = await send(mediaSignals.pause()).done();
    expect(pauseResult.kind).toBe(ResultKind.OK);
    expect(player.playback[Symbol.toStringTag]).toBe("playback.paused");
  });
  
  it("should enforce volume constraints", async () => {
    await using send = await lock(player);

    // Valid volume (synchronous prop update — resolves OK)
    const validResult = await send(mediaSignals.setVolume({ level: 0.5 })).done();
    expect(validResult.kind).toBe(ResultKind.OK);
    expect(player.volume.level).toBe(0.5);
    
    // Invalid volume — rejected, so don't .expect(OK) here; assert the kind directly
    const invalidResult = await send(mediaSignals.setVolume({ level: 1.5 })).done();
    expect(invalidResult.kind).toBe(ResultKind.Rejected);
    expect(player.volume.level).toBe(0.5); // Unchanged
  });
  
  it("should handle seek validation", async () => {
    await using send = await lock(player);

    // Load media, then let the buffer fill — bufferUpdate sets duration from the ranges
    // (Math.max of range ends) and moves loading -> ready. State instances are frozen, so
    // duration is set through the flow rather than by mutating player.playback directly.
    await send(mediaSignals.load({ url: "test.mp4" })).done();
    await send(mediaSignals.bufferUpdate({
      ranges: [{ start: 0, end: 120 }],
      health: 1
    })).done();
    expect(player.playback.duration).toBe(120);
    
    // Valid seek (synchronous prop update — resolves OK)
    const validSeek = await send(mediaSignals.seek({ position: 60 })).done();
    expect(validSeek.kind).toBe(ResultKind.OK);
    
    // Invalid seek — rejected, so assert the kind directly rather than .expect(OK)
    const invalidSeek = await send(mediaSignals.seek({ position: 150 })).done();
    expect(invalidSeek.kind).toBe(ResultKind.Rejected);
  });
});
```

This media player example demonstrates how StateFlow's architecture provides a robust foundation for complex stateful applications. The combination of immutable states, controlled transitions through signals, and comprehensive feedback ensures that the player behaves predictably while maintaining consistency throughout its lifecycle.
