---
title: Architecture Guide
description: Patterns for building scalable StateFlow applications
---

Advanced patterns for large-scale StateFlow applications, drawn from production systems like media players and real-time applications. {% .lead %}

## Multi-State Applications

### Coordinated State Systems

Production applications often require 7+ interconnected states working together:

```typescript
// Define related states that need to coordinate
const connectionState = defineState<{
  url: string;
  retryCount: number;
  lastError?: Error;
}>()
  .name("connection")
  .signals(signals)
  .variant("disconnected", true)
  .variant("connecting")
  .variant("connected")
  .variant("failed")
  .build();

const mediaState = defineState<{
  duration: number;
  position: number;
  buffered: TimeRanges | null;
}>()
  .name("media")
  .signals(signals)
  .variant("idle", true)
  .variant("loading")
  .variant("ready")
  .variant("error")
  .build();

const playbackState = defineState<{
  volume: number;
  playbackRate: number;
  seeking: boolean;
}>()
  .name("playback")
  .signals(signals)
  .variant("stopped", true)
  .variant("playing")
  .variant("paused")
  .variant("buffering")
  .build();
```

### State Dependencies and Cross-State Logic

Implement state dependencies using the context parameter in flows:

```typescript
// Application type with all states
interface MediaApplication {
  connection: Infer<typeof connectionState>;
  media: Infer<typeof mediaState>;
  playback: Infer<typeof playbackState>;
}

// Flow that depends on other states
defineFlow(playbackState.stopped, {
  play: (state, signal, context: MediaApplication) => {
    // Check if we can play based on other states
    if (stateVar(context.connection) !== connectionState.connected) {
      return Result.reject('Cannot play while disconnected');
    }
    
    if (stateVar(context.media) !== mediaState.ready) {
      return Result.reject('Media not ready for playback');
    }
    
    return playbackState.playing({
      ...state,
      seeking: false
    });
  }
});

// Cross-state reactions
defineFlow(connectionState.connecting, {
  connectionFailed: (state, signal, context: MediaApplication) => {
    // When connection fails, reset dependent states
    return connectionState.failed({
      ...state,
      lastError: signal.error,
      retryCount: state.retryCount + 1
    });
  }
});
```

## Signal Organization at Scale

### Hierarchical Signal Structure

For applications with 50+ signals, organize them by domain and purpose:

```typescript
// Production example from video player
const signals = {
  // Connection management
  connection: {
    connect: defineSignal<{ url: string; options?: ConnectionOptions }>("connect"),
    disconnect: defineSignal("disconnect"),
    retry: defineSignal("retry"),
    timeout: defineSignal<{ after: number }>("timeout"),
  },

  // Media loading and preparation
  media: {
    load: defineSignal<{ source: MediaSource }>("loadMedia"),
    metadata: defineSignal<{ duration: number; tracks: Track[] }>("mediaMetadata"),
    error: defineSignal<{ code: number; message: string }>("mediaError"),
    buffering: defineSignal<{ buffered: TimeRanges }>("buffering"),
  },

  // Playback control
  playback: {
    play: defineSignal("play"),
    pause: defineSignal("pause"),
    stop: defineSignal("stop"),
    seek: defineSignal<{ position: number; precise?: boolean }>("seek"),
    setVolume: defineSignal<{ level: number }>("setVolume"),
    setRate: defineSignal<{ rate: number }>("setRate"),
  },

  // User interface
  ui: {
    showControls: defineSignal("showControls"),
    hideControls: defineSignal("hideControls"),
    toggleFullscreen: defineSignal("toggleFullscreen"),
    showError: defineSignal<{ message: string; recoverable: boolean }>("showError"),
  },

  // Internal system signals
  internal: {
    tick: defineSignal<{ currentTime: number }>("tick"),
    qualityChange: defineSignal<{ level: QualityLevel }>("qualityChange"),
    cleanup: defineSignal("cleanup"),
  }
};
```

### Signal Naming Conventions

Establish consistent naming patterns. The signal and variant names used from here on (e.g.
`connectionFailed`, `seekToPosition`, `connectToUrl`, `playbackState.seeking`) illustrate the
naming *patterns* — they are not part of the signal catalog above and aren't separately defined:

```typescript
// Pattern: domain.verb[Object] for user actions
signals.playback.seekToPosition({ position: 30 })
signals.connection.connectToUrl({ url: "..." })
signals.ui.showErrorMessage({ message: "..." })

// Pattern: domain.on[Event] for external events
signals.media.onLoadComplete({ duration: 180 })
signals.connection.onDisconnected()
signals.playback.onTimeUpdate({ position: 45 })

// Pattern: internal.[system] for internal operations
signals.internal.cleanup()
signals.internal.syncStates()
signals.internal.validateConfiguration()
```

## Advanced State Patterns

### State Machines with Complex Transitions

Use nested state logic for complex state machines:

```typescript
const downloadState = defineState<{
  url: string;
  progress: number;
  speed: number; // bytes/second
  resumeData?: ResumeData;
}>()
  .name("download")
  .signals(signals)
  .variant("idle", true)
  .variant("preparing")
  .variant("downloading") 
  .variant("paused")
  .variant("completed")
  .variant("failed")
  .variant("cancelled")
  .build();

// Complex state machine logic
defineFlow(downloadState.downloading, {
  pause: (state) => {
    // Can pause from downloading
    return downloadState.paused({
      ...state,
      resumeData: captureResumeData(state)
    });
  },

  progress: (state, signal) => {
    // Update progress while downloading
    if (signal.progress >= 100) {
      return downloadState.completed(state);
    }
    return {
      ...state,
      progress: signal.progress,
      speed: calculateSpeed(state, signal)
    };
  },

  networkError: (state, signal) => {
    // Handle network interruptions
    if (signal.error.recoverable && state.resumeData) {
      return downloadState.paused({
        ...state,
        resumeData: signal.error.resumeData
      });
    }
    return downloadState.failed({
      ...state,
      error: signal.error
    });
  }
});
```

### State Composition Patterns

Break complex states into composable pieces:

```typescript
// Instead of one large state
interface MonolithicPlayerState {
  // 50+ properties covering all aspects
  connectionUrl: string;
  connectionStatus: string;
  mediaUrl: string;
  mediaDuration: number;
  playbackVolume: number;
  playbackPosition: number;
  uiControlsVisible: boolean;
  uiFullscreen: boolean;
  // ... many more
}

// Prefer composition of focused states
interface ComposedPlayerApplication {
  connection: ConnectionState;
  media: MediaState; 
  playback: PlaybackState;
  ui: UIState;
  quality: QualityState;
  audio: AudioState;
  video: VideoState;
}

// Each state handles its own domain
const audioState = defineState<{
  volume: number;
  muted: boolean;
  tracks: AudioTrack[];
  selectedTrack?: string;
}>()
  .name("audio")
  .signals(signals)
  .variant("unavailable", true)
  .variant("available")
  .variant("processing")
  .build();
```

## Reducer Decides, Handler Applies

The single most important pattern for keeping a large StateFlow app maintainable: put all the
**decision, validation, and resolution** logic in the pure `defineFlow` reducers, and keep the
effect handlers as **thin appliers**. A request that the flow doesn't approve never reaches an
effect.

The shape that scales — a pure **resolver** returns a `Result`, the request reducer threads it,
and the handler applies only what the reducer resolved:

```typescript
// A pure resolver: decide + validate + resolve, all from the state's own props.
function resolvePendingSource(s: PlayerProps): Result<{ url: string | null }> {
  if (s.preferredQuality == null) return Result.ok({ url: null }); // nothing selected
  const q = s.qualities.find((x) => x.name === s.preferredQuality);
  if (q == null) {
    // "not found" splits into two cases — distinguish them:
    return s.qualities.length > 0
      ? Result.reject(`unknown quality: ${s.preferredQuality}`) // list loaded & absent → invalid
      : Result.ok({ url: null });                                // list not loaded yet → buffer
  }
  const url = q.encodings[q.index]?.location;
  if (url == null) return Result.reject("encoding not found");   // genuine data error
  if (url === s.currentSourceUrl) return Result.ok({ url: null }); // redundant → no-op
  return Result.ok({ url });                                       // a real change → apply
}

// The setQuality REQUEST reducer threads the Result: reject propagates, otherwise carry the
// resolved value on a "pending" prop that the handler keys off.
defineFlow(playerState.playing, {
  setQuality: (s, sig) => {
    const r = resolvePendingSource({ ...s, preferredQuality: sig.name });
    if (r.kind !== ResultKind.OK) return r;        // invalid → Reject; effect never runs
    return playerState.playing({ ...s, preferredQuality: sig.name, pendingSourceUrl: r.data.url });
  },
});

// Re-resolve when the AUTHORITATIVE data arrives (a fresh quality list). These react to the
// system's own data, not a user request, so they NEVER reject — a stale selection must not roll
// back a legitimate list update; it just stays un-applied.
defineFlow(playerState.playing, {
  qualities: (s, sig) => {
    const next = { ...s, qualities: sig.list };
    const r = resolvePendingSource(next);
    return playerState.playing({ ...next, pendingSourceUrl: r.kind === ResultKind.OK ? r.data.url : null });
  },
});

// The effect handler is thin: it applies ONLY the resolved value, read from the snapshot, and
// the record signal clears the pending prop so it cannot re-fire in a loop.
sm.addUpdateHandler(playerState.playing, (state) => {
  if (state.pendingSourceUrl != null) loadSource(state.pendingSourceUrl);
  return Result.ok();
});
defineFlow(playerState.playing, {
  srcLoaded: (s, sig) => playerState.playing({ ...s, currentSourceUrl: sig.url, pendingSourceUrl: null }),
});
```

Key decisions made explicit by this shape:
- **Reject vs buffer for "not found"**: reject only when the list is *loaded* and the name is
  genuinely absent; buffer (store the preference, apply later) while the list is still loading.
- **Re-resolve paths don't reject**: handlers reacting to authoritative data map a reject to
  "nothing to apply" rather than failing the data update.
- **No record→re-fire loop**: the effect gates on the *resolved* prop, and the record signal
  (`srcLoaded`) clears it — so a follow-up `setVolume` update is a no-op for the source pipeline.

## Effects Run After Verification

StateFlow runs **all** the pure flow handlers (the decision) first, then the effect handlers.
There is a precise place for every kind of follow-up work:

| You want to… | Use | Timing |
|---|---|---|
| Decide the next state / validate / resolve | `defineFlow` reducer (pure) | first, before any effect |
| Perform a side effect gated by the transition | `addEnter/Exit/Update` handler | after verification; can reject → rollback |
| A small same-target follow-up **state change** | `Result.enqueue(sig)` | after commit (≤1 per dispatch *cycle*; co-enqueuing from multiple handlers only warns, it is not rejected) |
| React read-only to a committed change | `observe()` | after commit |
| A cross-target follow-up | `lock(otherTarget)` + `send` | sequenced |
| Must-succeed-before-true async work | `Result.transition` | commit deferred until it resolves |

Two rules effect handlers must follow:

```typescript
// ✅ Effect handlers read the (state, snapshot) ARGUMENTS — never live off `this`.
sm.addUpdateHandler(playerState.playing, (state, snapshot) => {
  el.currentTime = state.requestedPosition;            // the NEW, committed value
  const q = qualityState(snapshot);                    // a sibling's NEW state via the snapshot
  return Result.ok();
});

// ❌ Reading a sibling state off the live target inside a handler gets the OLD, pre-commit value.
sm.addUpdateHandler(playerState.playing, function (this: Player) {
  const q = qualityState(this); // STALE during the pre-commit window — bug.
  return Result.ok();
});
```

- **Read the args, not `this`** (the "V10" rule). During a handler the target may still hold the
  pre-commit value; the `state`/`snapshot` arguments are the authoritative new values.
- **Resources the machine owns live in flow props.** The `Hls` instance, a WebSocket, a
  mediasoup `Peer` — anything whose lifecycle a variant owns — belongs in the state props
  (`z.custom<T>()`), created in an enter handler and torn down on exit, **not** scattered as
  instance fields. Capture an external event (e.g. an SFU `streamAdded`) by dispatching a signal,
  not by writing a field from the callback. (The Resource Management examples below capture
  resources on the `app.resources` object via closure; prefer props for state the flow owns.)

## Resource Management

### Lifecycle Management with State Handlers

Use StateFlow's handler system for resource management:

```typescript
interface VideoPlayerApp {
  connection: Infer<typeof connectionState>;
  media: Infer<typeof mediaState>;
  playback: Infer<typeof playbackState>;
  resources: {
    webSocket?: WebSocket;
    mediaElement?: HTMLVideoElement;
    bufferController?: BufferController;
    timers: Map<string, NodeJS.Timer>;
  };
}

// `app` (the flow object, typed VideoPlayerApp) and its `app.resources` are captured by
// closure. The 2nd handler arg is the state SNAPSHOT, not a context object — never read
// resources off it, and never pass it to dispatch (it isn't a flow object).
applyFlow(app, [connectionState, mediaState, playbackState], (sm) => {
  // Resource acquisition. The enter handler itself is SYNCHRONOUS and returns a Result
  // synchronously; the async work lives INSIDE Result.transition. (An `async (state) => {...}`
  // handler returns a Promise and is rejected by the engine.)
  sm.addEnterHandler(connectionState.connecting, (state) => {
    return Result.transition(async () => {
      try {
        const ws = new WebSocket(state.url);
        
        // Set up event handlers — acquire a lock to dispatch onto the flow object `app`.
        // A bare dispatch() would throw while this transition is still in flight.
        ws.onopen = async () => {
          await using send = await lock(app);
          await send(signals.connection.connected()).done();
        };
        ws.onerror = async (error) => {
          await using send = await lock(app);
          await send(signals.connection.failed({ error })).done();
        };
        
        app.resources.webSocket = ws;
        
        // Wait for connection with timeout
        await waitForConnection(ws, 5000);
        return Result.ok();
      } catch (error) {
        return Result.error(error);
      }
    }, 5000);
  });

  // Resource cleanup
  sm.addExitHandler(connectionState.connected, (state) => {
    if (app.resources.webSocket) {
      app.resources.webSocket.close();
      app.resources.webSocket = undefined;
    }
    return Result.ok();
  });

  // Automatic cleanup on state changes
  sm.addExitHandler(playbackState.playing, (state) => {
    // Clear any playback timers
    app.resources.timers.forEach((timer) => clearInterval(timer));
    app.resources.timers.clear();
    return Result.ok();
  });

  // Error recovery
  sm.addRollbackHandler(mediaState.loading, (state) => {
    // Clean up partially loaded resources
    if (app.resources.bufferController) {
      app.resources.bufferController.abort();
      app.resources.bufferController = undefined;
    }
    return Result.ok();
  });
});
```

### Memory Management and Cleanup

```typescript
// Automatic disposal pattern
class VideoPlayerApplication implements Disposable {
  private disposables: Array<{ [Symbol.dispose](): void }> = [];
  
  constructor() {
    // Set up observers that auto-cleanup
    this.disposables.push(
      observe(this, [connectionState.failed], (state) => {
        this.handleConnectionFailure(state);
      }),
      
      observe(this, [mediaState.error], (state) => {
        this.handleMediaError(state);
      })
    );
  }

  [Symbol.dispose]() {
    // Clean up all observers
    this.disposables.forEach(disposable => disposable[Symbol.dispose]());
    
    // Clean up resources
    this.resources.webSocket?.close();
    this.resources.timers.forEach(timer => clearInterval(timer));
  }
}

// The factory must NOT use `using` here: a `using` binding disposes at function return,
// so it would hand back an already-disposed player. Use a plain `const` and let the
// CALLER own disposal (e.g. `using player = createPlayer();`).
function createPlayer(): VideoPlayerApplication {
  const player = new VideoPlayerApplication();
  return player;
}
```

## Integration Patterns

### External System Integration

Connect StateFlow to external APIs and services:

```typescript
// Service integration through handlers
interface ExternalServices {
  analyticsService: AnalyticsService;
  authService: AuthService;
  mediaService: MediaService;
}

// `app` is the flow object and `services` is captured by closure; handlers obtain
// their context this way — the 2nd handler arg is the state SNAPSHOT, not a context object.
const services: ExternalServices = createServices();

applyFlow(app, states, (sm) => {
  // Analytics integration (services/app captured by closure, not the 2nd handler arg)
  sm.addEnterHandler(playbackState.playing, (state) => {
    services.analyticsService.trackEvent('playback_started', {
      mediaId: app.media.id,
      position: state.position,
      timestamp: Date.now()
    });
    return Result.ok();
  });

  // Authentication integration. The enter handler is SYNCHRONOUS and returns a Result
  // synchronously — the async work lives INSIDE Result.transition (an `async` handler
  // returns a Promise the engine rejects).
  sm.addEnterHandler(connectionState.connecting, (state) => {
    return Result.transition(async () => {
      try {
        const token = await services.authService.getValidToken();
        
        // Update connection with auth token
        const authenticatedUrl = addAuthToken(state.url, token);
        return Result.state(connectionState.connecting({
          ...state,
          url: authenticatedUrl
        }));
      } catch (error) {
        return Result.error(error);
      }
    }, 3000);
  });
});
```

### Event System Integration

Bridge StateFlow with external event systems:

```typescript
// Two-way integration with DOM events
class DOMIntegration {
  constructor(private app: MediaApplication, private element: HTMLVideoElement) {
    this.setupDOMListeners();
    this.setupStateFlowObservers();
  }

  private setupDOMListeners() {
    // DOM events -> StateFlow signals. Acquire a lock to dispatch onto `this.app`; a bare
    // dispatch() throws if a lock is held or a transition is in flight, so signals must
    // queue behind any in-flight transition via lock() + send().
    this.element.addEventListener('play', () => {
      (async () => {
        await using send = await lock(this.app);
        await send(signals.playback.play()).done();
      })();
    });

    this.element.addEventListener('pause', () => {
      (async () => {
        await using send = await lock(this.app);
        await send(signals.playback.pause()).done();
      })();
    });

    this.element.addEventListener('timeupdate', () => {
      (async () => {
        await using send = await lock(this.app);
        await send(signals.internal.tick({
          currentTime: this.element.currentTime
        })).done();
      })();
    });

    this.element.addEventListener('error', (event) => {
      (async () => {
        await using send = await lock(this.app);
        await send(signals.media.error({
          code: this.element.error?.code || 0,
          message: this.element.error?.message || 'Unknown error'
        })).done();
      })();
    });
  }

  private setupStateFlowObservers() {
    // StateFlow states -> DOM updates
    observe(this.app, [playbackState.playing], (state) => {
      if (this.element.paused) {
        this.element.play().catch(async error => {
          await using send = await lock(this.app);
          await send(signals.playback.error({ error })).done();
        });
      }
    });

    observe(this.app, [playbackState.paused], (state) => {
      if (!this.element.paused) {
        this.element.pause();
      }
    });

    observe(this.app, [playbackState.seeking], (state) => {
      if (Math.abs(this.element.currentTime - state.position) > 0.5) {
        this.element.currentTime = state.position;
      }
    });
  }
}
```

## Performance Optimization

### Efficient Observer Patterns

Optimize observer performance for large applications:

```typescript
// Batch observer updates
class BatchedObserver {
  private pendingUpdates = new Map<string, StateInstance>();
  private updateScheduled = false;

  observe<T>(app: Application, states: StateVariant<T>[], handler: (state: StateInstance<T>) => void) {
    return observe(app, states, (state) => {
      // Batch updates instead of immediate handling
      const stateKey = String(stateVar(state));
      this.pendingUpdates.set(stateKey, state);
      
      if (!this.updateScheduled) {
        this.updateScheduled = true;
        queueMicrotask(() => this.flushUpdates(handler));
      }
    });
  }

  private flushUpdates<T>(handler: (state: StateInstance<T>) => void) {
    for (const [key, state] of this.pendingUpdates) {
      handler(state as StateInstance<T>);
    }
    this.pendingUpdates.clear();
    this.updateScheduled = false;
  }
}

// Selective observation with custom comparisons
observe(
  app,
  [mediaState.ready],
  (state) => expensiveUIUpdate(state),
  (prev, curr) => {
    // Only update UI if meaningful properties changed
    return prev.duration !== curr.duration || 
           prev.tracks.length !== curr.tracks.length ||
           prev.quality !== curr.quality;
  }
);
```

### State Validation and Runtime Checks

Add runtime validation for production applications:

```typescript
// Schema validation with Zod
import { z } from 'zod';

const MediaPropsSchema = z.object({
  url: z.string().url(),
  duration: z.number().min(0),
  position: z.number().min(0),
  bitrate: z.number().positive().optional(),
  tracks: z.array(z.object({
    id: z.string(),
    type: z.enum(['audio', 'video', 'subtitle']),
    language: z.string().optional()
  }))
});

const mediaState = defineState<z.infer<typeof MediaPropsSchema>>()
  .name("media")
  .signals(signals)
  .variant("loading", true)
  .variant("ready")
  .variant("error")
  .parser(obj => {
    // Runtime validation
    const result = MediaPropsSchema.safeParse(obj);
    if (!result.success) {
      throw new StateFlowError(`Invalid media state: ${result.error.message}`);
    }
    return result.data;
  })
  .stringRepr(s => `${s.url} (${Math.round(s.position)}/${Math.round(s.duration)}s)`)
  .build();
```

## Error Handling and Recovery

### Graceful Degradation Patterns

Implement fallback states for robust applications:

```typescript
const qualityState = defineState<{
  current: QualityLevel;
  available: QualityLevel[];
  auto: boolean;
  fallbackReason?: string;
}>()
  .name("quality")
  .signals(signals)
  .variant("auto", true) // Automatic quality selection
  .variant("manual") // User selected quality
  .variant("degraded") // Fallback due to network/performance
  .variant("unavailable") // No quality options available
  .build();

defineFlow(qualityState.auto, {
  networkDegraded: (state, signal) => {
    // Automatic fallback to lower quality
    const fallbackQuality = findBestQuality(
      state.available, 
      signal.bandwidth,
      signal.dropRate
    );
    
    if (!fallbackQuality) {
      return qualityState.unavailable({
        ...state,
        fallbackReason: 'No suitable quality for current network conditions'
      });
    }
    
    return qualityState.degraded({
      ...state,
      current: fallbackQuality,
      fallbackReason: `Downgraded due to ${signal.reason}`
    });
  },

  networkImproved: (state, signal) => {
    // Try to upgrade quality when conditions improve
    const betterQuality = findBetterQuality(
      state.available,
      state.current,
      signal.bandwidth
    );
    
    if (betterQuality && betterQuality.bitrate > state.current.bitrate) {
      return {
        ...state,
        current: betterQuality,
        fallbackReason: undefined
      };
    }
    
    return Result.ignore('No better quality available');
  }
});
```

These architectural patterns enable building complex, maintainable StateFlow applications that can scale with your needs while maintaining the core benefits of type safety, immutability, and explicit error handling.