/**
 * Three worked examples, each a scenario a test can run: the counter, reducers only; the player, whose activation
 * waits for the world through a declared transition; and the session, whose media holds a transport and a map of
 * producers as nested states. The definitions sit at module level, and each run function sets up a new target,
 * plays its signals, and returns the states it ends in. A run reaches the world only through the `world` it is
 * given, and only from a handler (enter, exit, update, transition or commit). So with every handler off
 * (setHandlersDisabled(true)) a run changes nothing outside StateFlow, which src/.tests/simulation.spec.ts
 * checks; src/.tests/examples.spec.ts tests the player and the session through their own methods that way, with
 * mocks giving the world's answers.
 */
import {
  applyFlow,
  Box,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  HandlerResult,
  type InstanceOf,
  type Items,
  isBox,
  lock,
  type ReducerContext,
  type Result,
  ResultKind,
  StateResult,
} from "../src";

/** What the world gives the player for a url: where its media is, and its tracks. */
export type Manifest = { url: string; tracks: string[] };

/** A media track a session sends, as a camera or a microphone gives it. */
export type Track = { id: string };

/** The world's sender of one track: pausing it holds the track back until it resumes, and closing it stops sending. */
export type RtpProducer = { close(): void; pause(): void; resume(): void };

/** The world's connection a session sends its tracks over. */
export type WireSocket = { close(): void };

/** How a failure came about: the `kind` that the FAILURE result carries into a failed state. */
type FailureKind = "rejected" | "error" | "timeout" | "aborted";

/** Everything outside StateFlow that the examples change or ask. A test passes a recording stand-in. */
export type World = {
  /** Turns the light on or off. */
  light(on: boolean): void;
  /** Tells the application that something happened. */
  notify(message: string): void;
  /** The manifest of `url`, or null when there is none; aborting `init.signal` cancels the request, which then
   * rejects with the signal's reason. */
  fetchManifest(url: string, init: { signal: AbortSignal }): Promise<Manifest | null>;
  /** Puts the media of `manifest` on the screen. */
  attach(manifest: Manifest): void;
  /** Takes the media off the screen. */
  detach(): void;
  /** Opens the connection a session sends over; aborting `init.signal` cancels it, which then rejects with the
   * signal's reason. */
  connect(init: { signal: AbortSignal }): Promise<WireSocket>;
  /** Starts sending `track`; aborting `init.signal` cancels it, which then rejects with the signal's reason. */
  produce(track: Track, init: { signal: AbortSignal }): Promise<RtpProducer>;
};

/**
 * A world that records each call, those on each socket and producer it gives included. fetchManifest answers by url:
 * ".../ok" gives a manifest, ".../missing" none, and ".../slow" never answers; produce never answers for a track whose
 * id is "slow".
 */
export function recordingWorld(): { world: World; calls: string[] } {
  const calls: string[] = [];
  const world: World = {
    light(on) {
      calls.push(`light ${on}`);
    },
    notify(message) {
      calls.push(`notify ${message}`);
    },
    fetchManifest(url, init) {
      calls.push(`fetchManifest ${url}`);
      if (url.endsWith("/slow")) {
        return unanswered(init.signal);
      }
      return Promise.resolve(url.endsWith("/ok") ? { url, tracks: ["video", "audio"] } : null);
    },
    attach(manifest) {
      calls.push(`attach ${manifest.url}`);
    },
    detach() {
      calls.push("detach");
    },
    connect() {
      calls.push("connect");
      return Promise.resolve({ close: () => calls.push("close socket") });
    },
    produce(track, init) {
      calls.push(`produce ${track.id}`);
      if (track.id === "slow") {
        return unanswered(init.signal);
      }
      return Promise.resolve({
        close: () => calls.push(`close producer ${track.id}`),
        pause: () => calls.push(`pause producer ${track.id}`),
        resume: () => calls.push(`resume producer ${track.id}`),
      });
    },
  };
  return { world, calls };
}

/** A request the world never answers: once `signal` aborts, it rejects with the signal's reason, as fetch does. */
function unanswered<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

//#region Counter example

// At first, we need to define signals we're going to use
const signals = {
  // they may accept arguments
  next: defineSignal<{ allow: boolean; incr: boolean }>("next"),

  err: defineSignal<{ critical: boolean }>("err"),
};

// then we need to define a state with props
const first = defineState<{ perm: boolean }>()
  // the name is important and will be used later
  .name("first")

  // all possible signals defined earlier
  .signals(signals)

  // and its variants: the initial option marks the variant applyFlow starts in
  .variant("zero", { initial: true })

  // stringRepr is optional, it allows to represent state as a string
  .stringRepr((v) => (v.perm ? "allowed" : "forbidden"))

  // finally we need to call .build()
  .build();
// it will create an object with variants of states

// we can specify multiple states
// all of them will be changed at once
const second = defineState<{ counter: number; msg: string }>()
  .name("second")
  .signals(signals)
  .variant("initial", { initial: true })
  .variant("good")
  .variant("done")
  .stringRepr((v) => `c=${v.counter};m=${v.msg}`)
  .build();
// A rule of a group of states is a plain function the reducers call. `second` moves on only while `first`
// allows it. Every reducer reads the snapshot from before the signal, so `first(ctx)` is `first` as committed: a
// `next` that makes `first` allow it moves `second` from the following `next` on.
function waitForFirst(ctx: ReducerContext): StateResult | null {
  return first(ctx).perm ? null : StateResult.ignored("first does not allow it yet");
}

// next we need to define a flow
// the first argument is a state variant
// and second is an object with signals handling this state variant
defineFlow(first.zero, {
  // a reducer returns the new props or a new instance
  next(x, p) {
    if (p.allow) {
      return { perm: true };
    }
    // or it may ignore the signal
    return StateResult.ignored("nothing to do");
  },
});

defineFlow(second.initial, {
  next(x, p, ctx) {
    return waitForFirst(ctx) ?? second.good({ ...x, counter: p.incr ? x.counter + 1 : x.counter });
  },
  err(x, p) {
    if (p.critical) {
      // a reducer may reject the signal: nothing commits and no handler runs
      return StateResult.rejected("bad state");
    }

    // if state variant is not changed then it may return just new props
    return { ...x, msg: "bad state" };
  },
});

// flow can be defined only once
// it will trigger an error if we try to define it again
defineFlow(second.good, {
  next(x, p, ctx) {
    const counter = p.incr ? x.counter + 1 : x.counter;
    if (counter < 2) {
      return StateResult.rejected(`we are not done yet! counter=${counter} < 2`);
    }
    return waitForFirst(ctx) ?? second.done({ ...x, counter });
  },
  err(x, p) {
    if (p.critical) {
      return StateResult.rejected("still bad state");
    }
    return { ...x, msg: "still bad state" };
  },
});

/**
 * Plays the counter scenario on a new target. The light is on while `second` is good, and the application
 * hears when `second` is done.
 *
 * @returns The states it ends in: `first`, then `second`.
 */
export async function runCounterExample(world: World): Promise<string[]> {
  // the target may be a class instance or a plain object holding each state's initial props
  const target = { first: { perm: false }, second: { counter: 0, msg: "" } };

  // the order of the states is the order their reducers run and their handlers are called in, within each
  // phase. The callback is the only place to add handlers
  applyFlow(target, [first, second] as const, (sm) => {
    sm.addEnterHandler(second.good, function lightOn() {
      world.light(true);
      return HandlerResult.ok();
    });
    sm.addExitHandler(second.good, function lightOff() {
      world.light(false);
      return HandlerResult.ok();
    });
    // a commit handler runs right after the commit, for events to the application; it cannot fail
    sm.addCommitHandler(second.done, function notifyDone(state) {
      world.notify(`counter done at ${state.counter}`);
    });
  });

  // send() dispatches while the lock is held; the lock is released at the end of the scope
  await using send = await lock(target);

  // Ignored: first has nothing to do, and second waits for first ("nothing to do; first does not allow it yet")
  send(signals.next({ allow: false, incr: true }));

  // Rejected by the reducer: bad state
  send(signals.err({ critical: true }));

  // OK: first allows it now; second still reads first as committed, and waits
  send(signals.next({ allow: true, incr: true }));

  // OK: second is good (c=1); the light turns on. first ignores it ("nothing to do") and stays allowed
  send(signals.next({ allow: false, incr: true }));

  // Rejected: still bad state
  send(signals.err({ critical: true }));

  // OK: second stays good with m=still bad state, an update
  send(signals.err({ critical: false }));

  // Rejected by second.good's reducer: we are not done yet! counter=1 < 2
  send(signals.next({ allow: false, incr: false }));

  // OK: second is done (c=2); the light turns off and the application hears it
  send(signals.next({ allow: false, incr: true }));

  // Ignored: second.done has no reducer for next, and first ignores it ("nothing to do")
  send(signals.next({ allow: false, incr: true }));

  return [String(target.first), String(target.second)];
}

//#endregion

//#region Player example

// A player whose driver activates by fetching a manifest. The world's answer reaches props through a named result:
// active's transition handler returns `driverState.active.results.loaded({ manifest })`, and active's result reducer
// puts the manifest in. Why an activation failed reaches props through FAILURE: failed's reducer for it puts the
// failure's kind and reason in.
const playerSignals = {
  play: defineSignal<{ url: string; timeoutMs?: number }>("play"),
  stop: defineSignal("stop"),
};

type DriverProps = { url: string; manifest: Manifest | null; reason?: string; failure?: FailureKind };

/**
 * The data of the `loaded` result, checked by hand: a manifest with a string url and string tracks. The manifest
 * goes into props as the world gave it, and props freeze it: the world gives each fetch a manifest of its own.
 */
function parseLoaded(data: unknown): { manifest: Manifest } {
  const manifest = (data as { manifest?: { url?: unknown; tracks?: unknown } } | null)?.manifest;
  const tracks = manifest?.tracks;
  if (
    typeof manifest?.url !== "string" ||
    !Array.isArray(tracks) ||
    !tracks.every((track) => typeof track === "string")
  ) {
    throw new TypeError("loaded takes a manifest with a url and string tracks");
  }
  return { manifest: manifest as Manifest };
}

export const driverState = defineState<DriverProps>()
  .name("driver")
  .signals(playerSignals)
  .variant("idle", { initial: true })
  // Committed only while play's transition waits for the manifest, so stop there aborts it.
  .variant("activating", { transitional: true })
  // Entered only through a transition, whose work is active's transition handler.
  .variant("active", { async: true, results: { loaded: (data) => parseLoaded(data) } })
  .variant("failed")
  .stringRepr((d) => (d.reason === undefined ? d.url : `${d.url}: ${d.reason}`))
  .build();

// play declares the transition into active: activating commits at once, and active's transition handler is the
// work. When it gives a manifest, active commits with the manifest folded in; when it refuses, fails or times out,
// failed commits, and FAILURE puts the failure's kind and reason in.
function play(_s: DriverProps, { url, timeoutMs }: { url: string; timeoutMs?: number }): StateResult {
  const playing = { url, manifest: null };
  return StateResult.transition(
    driverState.active(playing),
    driverState.activating(playing),
    driverState.failed(playing),
    { timeoutMs },
  );
}

const stop = () => driverState.idle({ url: "", manifest: null });

defineFlow(driverState.idle, { play });
// activating's reducer is the abort reducer: stop during play cancels the request and commits idle.
defineFlow(driverState.activating, { stop });
defineFlow(driverState.active, { stop }, { loaded: (s, { manifest }) => ({ ...s, manifest }) });
defineFlow(
  driverState.failed,
  { play, stop },
  { [FAILURE]: (s, { kind, reason }) => ({ ...s, failure: kind, reason }) },
);

/**
 * A player: its whole state is its driver, in StateFlow, and every outside call is in a handler. Its methods are
 * plain code over lock(), send() and an abort, and each asserts with `expect(ResultKind.OK)` that its signal reached
 * its end: one no reducer takes, or a refusal, throws at once, and a transition that ends in failed rejects with the
 * failure once failed committed.
 */
export class Player {
  /** The driver's initial props; applyFlow puts its instance here. */
  readonly driver: DriverProps = { url: "", manifest: null };

  constructor(world: World) {
    applyFlow(this, [driverState], (sm) => {
      // The activation: the request takes the transition's signal, so an abort or the timeout cancels it.
      sm.addTransitionHandler(driverState.active, async function fetchManifest(next, _snapshot, _prev, _key, signal) {
        const manifest = await world.fetchManifest(next.url, { signal });
        signal.throwIfAborted();
        return manifest === null
          ? HandlerResult.rejected("no manifest")
          : driverState.active.results.loaded({ manifest });
      });
      // The end's enter handlers run after the work's results folded, so the manifest is in props.
      sm.addEnterHandler(driverState.active, function attach(s) {
        if (s.manifest === null) {
          // A work that settled without loaded: the end is refused, and failed commits.
          return HandlerResult.rejected("no manifest to attach");
        }
        world.attach(s.manifest);
        return HandlerResult.ok();
      });
      sm.addExitHandler(driverState.active, function detach() {
        world.detach();
        return HandlerResult.ok();
      });
    });
  }

  /** Plays `url`: resolves once active committed with the manifest the world gave; rejects when the world refuses,
   * times out or a stop aborts it, the refusal then the failed driver's reason. */
  async play(url: string, timeoutMs?: number): Promise<Result> {
    await using send = await lock(this);
    return send(playerSignals.play({ url, timeoutMs })).expect(ResultKind.OK).done();
  }

  /** Stops: aborts a play still waiting for its manifest, or, with nothing pending, stops as any signal does; throws
   * on an idle driver, which takes no stop. */
  async stop(): Promise<Result> {
    return dispatch(this, playerSignals.stop(), { abort: true }).expect(ResultKind.OK).done();
  }
}

/**
 * Plays the player scenario on a new player: a play that reaches active, one the world refuses, one that times
 * out, and one that stop aborts. Each but the last is stopped after its end.
 *
 * @returns The state each of the four plays ends in.
 */
export async function runPlayerExample(world: World): Promise<string[]> {
  const player = new Player(world);
  const ends: string[] = [];

  // OK: active with the manifest the world gave; active's enter handler attaches it
  await player.play("https://example.com/ok");
  ends.push(String(player.driver));
  // Nothing is pending, so stop is an ordinary dispatch: active's exit handler detaches
  await player.stop();

  // The world has no manifest: play rejects with "no manifest", which failed holds as its reason. The rejections
  // below are what the scenario plays, and the ends record them.
  await player.play("https://example.com/missing").catch(() => {});
  ends.push(String(player.driver));
  await player.stop();

  // The world does not answer: once 50 ms pass, play rejects with a TransitionAborted of kind timeout, whose message
  // failed holds as its reason; then the transition's signal cancels the request
  await player.play("https://example.com/slow", 50).catch(() => {});
  ends.push(String(player.driver));
  await player.stop();

  // stop during play aborts it: the request is cancelled, idle commits, and play rejects with "aborted by stop"
  const playing = player.play("https://example.com/slow").catch(() => {});
  // One timer turn: play holds the lock and its transition is pending
  await new Promise((resolve) => setTimeout(resolve, 0));
  await player.stop();
  await playing;
  ends.push(String(player.driver));

  return ends;
}

//#endregion

//#region Session example

// A session sends tracks over one transport. Its media state holds the transport and a producer per track as
// nested states: plain props whose types say what they hold, with nothing else to declare.

/** The data of the `created` result, checked by hand: the world's producer in a Box. */
function parseCreated(data: unknown): { producer: Box<RtpProducer> } {
  const rtp = (data as { producer?: unknown } | null)?.producer;
  if (!isBox(rtp)) {
    throw new TypeError("created takes the world's producer in a Box");
  }
  return { producer: rtp as Box<RtpProducer> };
}

/** The data of the `opened` result, checked by hand: the world's socket in a Box. */
function parseOpened(data: unknown): { socket: Box<WireSocket> } {
  const socket = (data as { socket?: unknown } | null)?.socket;
  if (!isBox(socket)) {
    throw new TypeError("opened takes the world's socket in a Box");
  }
  return { socket: socket as Box<WireSocket> };
}

// A producer: a state with signals of its own, living inside media under its key.
const producerSignals = {
  pause: defineSignal<{ key: string }>("pause"),
  resume: defineSignal<{ key: string }>("resume"),
};

type ProducerProps = {
  track: Box<Track>;
  producer: Box<RtpProducer> | null;
  paused: boolean;
  reason?: string;
  failure?: FailureKind;
};

export const producer = defineState<ProducerProps>()
  .name("producer")
  .signals(producerSignals)
  // Committed only while addProducer's transition waits for the world to create the producer.
  .variant("creating", { transitional: true })
  // Entered only through a transition, whose work is active's transition handler. A paused producer stays active:
  // only its flag changes.
  .variant("active", { async: true, results: { created: (data) => parseCreated(data) } })
  .variant("failed")
  // Whether the world's producer is in, whether it is paused, and why it failed; a Box's own string form carries a
  // running number.
  .stringRepr(
    (p) =>
      `${p.producer === null ? "no rtp" : "rtp"}${p.paused ? " paused" : ""}${p.reason === undefined ? "" : `: ${p.reason}`}`,
  )
  .build();

// The transport: a state without signals, one inside media.
export const transport = defineState<{ socket: Box<WireSocket> | null }>()
  .name("transport")
  .variant("closed", { initial: true })
  // Entered only through a transition, whose work is open's transition handler.
  .variant("open", { async: true, results: { opened: (data) => parseOpened(data) } })
  .stringRepr((t) => (t.socket === null ? "no socket" : "socket"))
  .build();

/** What media holds in its `transport` prop. */
type Transport = InstanceOf<typeof transport>;

const mediaSignals = {
  open: defineSignal("open"),
  addProducer: defineSignal<{ key: string; track: Box<Track> }>("addProducer"),
  removeProducer: defineSignal<{ key: string }>("removeProducer"),
  close: defineSignal("close"),
};

type MediaProps = { transport: Transport; producers: Items<typeof producer> };

export const media = defineState<MediaProps>()
  .name("media")
  .signals(mediaSignals)
  .variant("idle", { initial: true })
  // Committed only while open's transition waits for the world to connect, so close there aborts it.
  .variant("opening", { transitional: true })
  .variant("active")
  .build();

// The parent decides its children: an empty map and a closed transport take each one out of its variant.
const close = () => media.idle({ transport: transport.closed({ socket: null }), producers: producer.items() });

// open declares the transition into active: media is opening while the transport's transition handler connects,
// and the socket it returns folds into the open transport through transport's result reducer. A refusal or the
// timeout takes media back to idle.
defineFlow(media.idle, {
  open: (s) =>
    StateResult.transition(
      media.active({ ...s, transport: transport.open({ socket: null }) }),
      media.opening(s),
      media.idle(s),
    ),
});

// opening's reducer is the abort reducer: close during open cancels the connection and commits idle.
defineFlow(media.opening, { close });

defineFlow(media.active, {
  // The element is creating while the world creates its producer; a refusal or the timeout leaves it in failed.
  addProducer: (s, { key, track }) =>
    s.producers.has(key)
      ? StateResult.rejected(`${key} already exists`)
      : StateResult.transition(
          media.active({
            ...s,
            producers: s.producers.with(key, producer.active({ track, producer: null, paused: false })),
          }),
          media.active({
            ...s,
            producers: s.producers.with(key, producer.creating({ track, producer: null, paused: false })),
          }),
          media.active({
            ...s,
            producers: s.producers.with(key, producer.failed({ track, producer: null, paused: false })),
          }),
          { timeoutMs: 5000 },
        ),
  removeProducer: (s, { key }) => media.active({ ...s, producers: s.producers.without(key) }),
  // While addProducer waits, close is the reducer that aborts it.
  close,
});

// pause and resume reach every active producer; each picks itself by its key in media's producers, and only its flag
// changes.
defineFlow(
  producer.active,
  {
    pause: (p, { key }, ctx) => (ctx.key === key ? producer.active({ ...p, paused: true }) : StateResult.ignored()),
    resume: (p, { key }, ctx) => (ctx.key === key ? producer.active({ ...p, paused: false }) : StateResult.ignored()),
  },
  { created: (p, data) => ({ ...p, producer: data.producer }) },
);

// A failed producer holds how and why it failed. The failed is media's, whose reducer declared the transition, and the
// step into it enters the producer's failed inside media, so FAILURE reaches the producer too.
defineFlow(producer.failed, {}, { [FAILURE]: (p, { kind, reason }) => ({ ...p, failure: kind, reason }) });

// A state without signals takes its result reducers as the second argument.
defineFlow(transport.open, { opened: (t, data) => ({ ...t, socket: data.socket }) });

/**
 * A session: its whole state is its media, in StateFlow, and every outside call is in a handler. Its methods are
 * plain code over lock(), send() and an abort, and each asserts with `expect(ResultKind.OK)` that its signal reached
 * its end: one no reducer takes, or a refusal, throws at once, and a transition that ends in failed rejects with the
 * failure once failed committed.
 */
export class Session {
  /** The media's initial props; applyFlow puts its instance here. */
  readonly media: MediaProps = { transport: transport.closed({ socket: null }), producers: producer.items() };

  constructor(world: World) {
    applyFlow(this, [media], (sm) => {
      // Handlers go on the variants of nested states as on top-level ones; the transition's signal goes on to
      // the world, so an abort or the timeout cancels the request.
      sm.addTransitionHandler(transport.open, async function connect(_t, _snapshot, _prev, _key, signal) {
        const socket = await world.connect({ signal });
        signal.throwIfAborted();
        return transport.open.results.opened({ socket: Box.of(socket) });
      });
      sm.addTransitionHandler(producer.active, async function produce(p, _snapshot, _prev, _key, signal) {
        const rtp = await world.produce(p.track.deref(), { signal });
        signal.throwIfAborted();
        return producer.active.results.created({ producer: Box.of(rtp) });
      });
      // pause and resume change only the flag, so the world's producer holds back or sends again.
      sm.addUpdateHandler(producer.active, function pauseOrResume(p, _snapshot, prev) {
        if (p.paused !== prev.paused) {
          const rtp = p.producer?.deref();
          if (p.paused) {
            rtp?.pause();
          } else {
            rtp?.resume();
          }
        }
        return HandlerResult.ok();
      });
      // Leaving active stops sending: the producer leaves on a removal or a close. An exit runs in every step that
      // leaves its variant, a refused one included, so each close waits for the commit in a commit delegate.
      sm.addExitHandler(producer.active, function closeProducer(p) {
        return HandlerResult.ok().onCommit(() => p.producer?.deref().close());
      });
      sm.addExitHandler(transport.open, function closeSocket(t) {
        return HandlerResult.ok().onCommit(() => t.socket?.deref().close());
      });
    });
  }

  /** Opens the transport: resolves once media is active with the socket the world connected. */
  async open(): Promise<Result> {
    await using send = await lock(this);
    return send(mediaSignals.open()).expect(ResultKind.OK).done();
  }

  /** Sends `track` under `key`: resolves once its producer is active with the producer the world created. */
  async addProducer(key: string, track: Track): Promise<Result> {
    await using send = await lock(this);
    return send(mediaSignals.addProducer({ key, track: Box.of(track) }))
      .expect(ResultKind.OK)
      .done();
  }

  /** Pauses the producer under `key`. */
  async pause(key: string): Promise<Result> {
    await using send = await lock(this);
    return send(producerSignals.pause({ key })).expect(ResultKind.OK).done();
  }

  /** Resumes the producer under `key`. */
  async resume(key: string): Promise<Result> {
    await using send = await lock(this);
    return send(producerSignals.resume({ key })).expect(ResultKind.OK).done();
  }

  /** Takes the producer under `key` out of the session. */
  async removeProducer(key: string): Promise<Result> {
    await using send = await lock(this);
    return send(mediaSignals.removeProducer({ key })).expect(ResultKind.OK).done();
  }

  /** Closes: aborts an open still waiting for its connection or an addProducer still waiting for its producer, or,
   * with nothing pending, closes as any signal does; throws on idle media, which takes no close. */
  async close(): Promise<Result> {
    return dispatch(this, mediaSignals.close(), { abort: true }).expect(ResultKind.OK).done();
  }
}

/**
 * Plays the session scenario on a new session: it opens, sends two tracks, pauses one and removes the other;
 * then close cuts off a third track that the world is slow to send.
 *
 * @returns The media's state after the removal and after the close.
 */
export async function runSessionExample(world: World): Promise<string[]> {
  const session = new Session(world);
  const ends: string[] = [];

  // OK: active, with the socket the world connected folded into the open transport
  await session.open();
  // OK: cam and mic are active, each with the producer the world created
  await session.addProducer("cam", { id: "cam" });
  await session.addProducer("mic", { id: "mic" });
  // OK: only cam's flag changes: active's update handler pauses its producer; mic and media get no call
  await session.pause("cam");
  // OK: mic leaves, and its producer closes
  await session.removeProducer("mic");
  ends.push(String(session.media));

  // close during addProducer aborts it: the request is cancelled and addProducer rejects with "aborted by close",
  // which the scenario plays; then the producers, the transport and media exit, in that order: cam's exit closes its
  // producer, and the transport's exit closes the socket
  const adding = session.addProducer("slow", { id: "slow" }).catch(() => {});
  // One timer turn: addProducer holds the lock and its transition is pending
  await new Promise((resolve) => setTimeout(resolve, 0));
  await session.close();
  await adding;
  ends.push(String(session.media));

  return ends;
}

//#endregion
