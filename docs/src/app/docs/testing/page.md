---
title: Testing
description: Testing strategies and patterns for StateFlow applications
---

Reducers are pure, every signal returns an explicit result, and every effect lives in a handler. A test therefore drives the real object through its real methods, gives the world's answers with mocks, and can switch every handler off to run the pure state logic alone. {% .lead %}

{% callout title="Complete files" %}
Each block below is a complete test file. The ones that import `./player` use the player of [Testing Declared Transitions](#testing-declared-transitions), and `./quality` is the `quality` state of [Design Principles](/docs/design-principles#the-reducer-decides-the-handler-applies), exported.
{% /callout %}

## Testing Philosophy

- **Reducers are pure functions:** an invalid request is `Rejected` and a redundant one changes nothing, with no effect to stub.
- **Results are explicit:** a test asserts the kind, the message and the state that committed.
- **Effects live in handlers:** switch them all off, mock the one service a test needs, and run the real methods.
- **Time is the flow's:** every timer of a flow goes through its config, so a test controls it.

## Definitions

```typescript
import { describe, expect, test } from "vitest";
import { defineSignal, defineState } from "@state-flow/core";

describe("definitions", () => {
  test("a variant builds frozen instances that print their state and variant", () => {
    const userState = defineState<{ id: string; name: string }>()
      .name("user")
      .variant("guest", { initial: true })
      .variant("authenticated")
      .build();

    const guest = userState.guest({ id: "u0", name: "Guest" });

    expect(guest.name).toBe("Guest");
    expect(Object.isFrozen(guest)).toBe(true);
    expect(String(guest)).toBe("user.guest(id=u0 name=Guest)");
  });

  test("a signal carries its name and its payload", () => {
    const login = defineSignal<{ email: string }>("login");

    const signal = login({ email: "test@example.com" });

    expect(signal[Symbol.toStringTag]).toBe("login");
    expect(signal.email).toBe("test@example.com");
  });
});
```

## Reducers

A flow is exercised by sending signals to a target it was applied to:

```typescript
import { describe, expect, test } from "vitest";
import { applyFlow, defineFlow, defineSignal, defineState, lock, ResultKind, StateResult, stateVar } from "@state-flow/core";

const signals = {
  login: defineSignal<{ email: string; password: string }>("login"),
  failedLogin: defineSignal("failedLogin"),
  logout: defineSignal("logout"),
};

const userState = defineState<{ id: string; email: string; loginAttempts: number }>()
  .name("user")
  .signals(signals)
  .variant("guest", { initial: true })
  .variant("authenticated")
  .variant("locked")
  .build();

defineFlow(userState.guest, {
  login: (s, { email, password }) =>
    password === "correct"
      ? userState.authenticated({ id: "user123", email, loginAttempts: 0 })
      : StateResult.rejected("invalid credentials"),
  failedLogin: (s) =>
    s.loginAttempts + 1 >= 3
      ? userState.locked({ ...s, loginAttempts: s.loginAttempts + 1 })
      : { ...s, loginAttempts: s.loginAttempts + 1 },
});
defineFlow(userState.authenticated, { logout: () => userState.guest({ id: "", email: "", loginAttempts: 0 }) });

function createApp() {
  const app = { user: { id: "", email: "", loginAttempts: 0 } };
  applyFlow(app, [userState], () => {});
  return app;
}

describe("user flow", () => {
  test("a correct login authenticates", async () => {
    const app = createApp();

    await using send = await lock(app);
    const result = send(signals.login({ email: "test@example.com", password: "correct" }));

    expect(result.kind).toBe(ResultKind.OK);
    expect(stateVar(app.user)).toBe(userState.authenticated);
    expect(app.user.email).toBe("test@example.com");
  });

  test("a wrong password is rejected, and nothing changes", async () => {
    const app = createApp();
    const before = app.user;

    await using send = await lock(app);
    const result = send(signals.login({ email: "test@example.com", password: "wrong" }));

    expect(result.kind).toBe(ResultKind.Rejected);
    expect(result.message).toBe("invalid credentials");
    expect(app.user).toBe(before);
  });

  test("three failed logins lock the account", async () => {
    const app = createApp();

    await using send = await lock(app);
    send(signals.failedLogin());
    send(signals.failedLogin());
    send(signals.failedLogin());

    expect(stateVar(app.user)).toBe(userState.locked);
    expect(app.user.loginAttempts).toBe(3);
  });
});
```

A send that declares no transition returns its final result at once; `await send(signal).done()` fits both kinds.

### The Reducer's Decisions

Because the reducer holds the decision, its every branch is asserted on the result and the state, and the handler on what it applied:

```typescript
import { expect, test, vi } from "vitest";
import { applyFlow, HandlerResult, lock, ResultKind } from "@state-flow/core";
import { quality, qualitySignals } from "./quality";

const initial = { qualities: [{ name: "hd", id: "q1" }], currentId: "q1" };

test("an unknown quality is rejected, and nothing changes", async () => {
  const app = { quality: initial };
  applyFlow(app, [quality], () => {});

  await using send = await lock(app);
  const result = send(qualitySignals.setQuality({ name: "does-not-exist" }));

  expect(result.kind).toBe(ResultKind.Rejected);
  expect(app.quality.currentId).toBe("q1");
});

test("the current quality runs no handler", async () => {
  const switchTo = vi.fn();
  const app = { quality: initial };
  applyFlow(app, [quality], (sm) =>
    sm.addUpdateHandler(quality.active, (s) => {
      switchTo(s.currentId);
      return HandlerResult.ok();
    }),
  );

  await using send = await lock(app);
  send(qualitySignals.setQuality({ name: "hd" }));

  expect(switchTo).not.toHaveBeenCalled();
});
```

## Testing Declared Transitions

A testable object keeps its whole state in StateFlow and makes every outside call in a handler; its public methods are plain code over `lock()`, `send()` and an abort. Here is such a player: its driver activates by fetching a manifest, which reaches props as the named result `loaded`, and the reason of a failed activation reaches props through `FAILURE`.

```typescript
// player.ts
import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  type FlowConfig,
  HandlerResult,
  lock,
  type Result,
  ResultKind,
  StateResult,
} from "@state-flow/core";

export type Manifest = { url: string; tracks: string[] };

/** Everything outside StateFlow the player calls. */
export interface World {
  fetchManifest(url: string, init: { signal: AbortSignal }): Promise<Manifest | null>;
  attach(manifest: Manifest): void;
  detach(): void;
}

export const playerSignals = {
  play: defineSignal<{ url: string }>("play"),
  stop: defineSignal("stop"),
};

type DriverProps = { url: string; manifest: Manifest | null; reason: string | null };

function parseLoaded(data: unknown): { manifest: Manifest } {
  const manifest = (data as { manifest?: Manifest } | null)?.manifest;
  if (typeof manifest?.url !== "string") {
    throw new TypeError("loaded takes a manifest with a url");
  }
  return { manifest };
}

export const driverState = defineState<DriverProps>()
  .name("driver")
  .signals(playerSignals)
  .variant("idle", { initial: true })
  .variant("activating", { transitional: true })
  .variant("active", { async: true, results: { loaded: parseLoaded } })
  .variant("failed")
  .build();

const idle = () => driverState.idle({ url: "", manifest: null, reason: null });

// activating commits at once; active's transition handler is the work; a refusal or the timeout commits failed.
const play = (s: DriverProps, { url }: { url: string }) =>
  StateResult.transition(
    driverState.active({ ...s, url, manifest: null, reason: null }),
    driverState.activating({ ...s, url, reason: null }),
    driverState.failed({ ...s, url, manifest: null }),
    { timeoutMs: 5000 },
  );

defineFlow(driverState.idle, { play });
defineFlow(driverState.activating, { stop: idle }); // the abort reducer
defineFlow(driverState.active, { stop: idle }, { loaded: (s, { manifest }) => ({ ...s, manifest }) });
defineFlow(driverState.failed, { play, stop: idle }, { [FAILURE]: (s, { reason }) => ({ ...s, reason: reason ?? null }) });

export class Player {
  /** The driver's initial props; applyFlow puts its instance here. */
  readonly driver: DriverProps = { url: "", manifest: null, reason: null };

  /** `timers`: the flow's timers; the global ones when absent (see Controlling Time). */
  constructor(world: World, timers?: FlowConfig["timers"]) {
    applyFlow(
      this,
      [driverState],
      (sm) => {
        sm.addTransitionHandler(driverState.active, async (next, snapshot, prev, key, signal) => {
          const manifest = await world.fetchManifest(next.url, { signal });
          signal.throwIfAborted();
          return manifest === null ? HandlerResult.rejected("no manifest") : driverState.active.results.loaded({ manifest });
        });
        // The end's enter handlers see the work's named result folded in.
        sm.addEnterHandler(driverState.active, (s) => {
          if (s.manifest !== null) {
            world.attach(s.manifest);
          }
          return HandlerResult.ok();
        });
        sm.addExitHandler(driverState.active, () => {
          world.detach();
          return HandlerResult.ok();
        });
      },
      { timers },
    );
  }

  /** Resolves once active committed; rejects once failed or idle committed when the world refuses, the timeout
   * passes, or a stop aborts the play. */
  async play(url: string): Promise<Result> {
    await using send = await lock(this);
    return send(playerSignals.play({ url })).expect(ResultKind.OK).done();
  }

  /** Aborts a play still waiting for its manifest, or stops as any signal does. The abort skips the lock, which
   * the pending play holds; a stop of an idle driver rejects, since idle takes no stop. */
  async stop(): Promise<Result> {
    return dispatch(this, playerSignals.stop(), { abort: true }).expect(ResultKind.OK).done();
  }
}
```

A test drives the transition through a world it controls. A transition mock (`mockHandlers`) replaces only the work, while `attach` and `detach` stay real; the mock gets the handler's arguments, the `AbortSignal` included. The timeout is an ordinary timer, so fake timers control it, as does a clock given to the flow (see [Controlling Time](#controlling-time)).

```typescript
import { afterEach, expect, test, vi } from "vitest";
import { HandlerResult, mockHandlers, ResultKind, stateVar, TransitionAborted } from "@state-flow/core";
import { driverState, type Manifest, Player, type World } from "./player";

function fakeWorld(manifest: Manifest | null): World {
  return { fetchManifest: async () => manifest, attach: vi.fn(), detach: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

test("play reaches active and attaches the manifest the world gave", async () => {
  const world = fakeWorld({ url: "https://example.com/a", tracks: ["video"] });
  const player = new Player(world);

  const result = await player.play("https://example.com/a");

  expect(result.kind).toBe(ResultKind.OK);
  expect(stateVar(player.driver)).toBe(driverState.active);
  expect(world.attach).toHaveBeenCalledWith(player.driver.manifest);
});

test("a refusal of the work rejects play, once failed committed with the reason", async () => {
  const player = new Player(fakeWorld(null));

  await expect(player.play("https://example.com/missing")).rejects.toThrow("no manifest");

  expect(stateVar(player.driver)).toBe(driverState.failed);
  expect(player.driver.reason).toBe("no manifest");
});

test("the timeout commits failed, then aborts the work with a TransitionAborted of kind timeout", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  using mocks = mockHandlers(driverState.active, {
    transition: (next, snapshot, prev, key, s) => {
      signal = s;
      return new Promise<HandlerResult>(() => {}); // the world never answers
    },
  });
  const player = new Player(fakeWorld(null));
  const timeout =
    "driver did not reach driver.active within 5000 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.";

  const playing = player.play("https://example.com/slow");
  const rejected = expect(playing).rejects.toThrow(timeout); // given its handler before it rejects
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;

  expect(stateVar(player.driver)).toBe(driverState.failed);
  expect(player.driver.reason).toBe(timeout);
  expect(signal?.reason).toBeInstanceOf(TransitionAborted);
  expect((signal?.reason as TransitionAborted).kind).toBe("timeout");
});

test("stop during play aborts it: the work learns why, and the driver goes idle", async () => {
  let reason: unknown;
  using mocks = mockHandlers(driverState.active, {
    transition: (next, snapshot, prev, key, signal) =>
      new Promise<HandlerResult>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reason = signal.reason;
          reject(signal.reason);
        });
      }),
  });
  const player = new Player(fakeWorld(null));

  const playing = player.play("https://example.com/slow");
  const rejected = expect(playing).rejects.toThrow("aborted by stop");
  await new Promise((resolve) => setTimeout(resolve, 0)); // play holds the lock; its transition is pending

  expect((await player.stop()).kind).toBe(ResultKind.OK);
  await rejected;
  expect((reason as TransitionAborted).kind).toBe("aborted");
  expect(stateVar(player.driver)).toBe(driverState.idle);
});
```

While a transition is pending, the lock holder's other sends queue behind it and are reduced in order after it ends; `sync(target)` resolves once no transition is pending, and a lock's release waits for that too.

## Observers, Watches and Events

Observer callbacks, watch callbacks, events and subscriber changes run on later turns of the flow's timers. `settled(target)` resolves once every delivery set so far has run, the deliveries their commits set in turn included, and once the locks they asked for have been served. It takes the lock itself, so a test awaits it after releasing its own lock: awaited under the target's lock, it never resolves.

```typescript
import { EventEmitter } from "events";
import { describe, expect, test, vi } from "vitest";
import { applyFlow, defineFlow, defineSignal, defineState, lock, observe, settled, watch } from "@state-flow/core";

const counterSignals = { increment: defineSignal("increment") };

const counterState = defineState<{ count: number }>()
  .name("counter")
  .signals(counterSignals)
  .variant("active", { initial: true })
  .build();

defineFlow(counterState.active, { increment: (s) => ({ count: s.count + 1 }) });

class Counter extends EventEmitter {
  readonly counter = { count: 0 };

  constructor() {
    super();
    applyFlow(this, [counterState], (sm) => {
      sm.defineEvent(
        "even",
        (cur, prev) => cur.counter.count !== prev.counter.count && cur.counter.count % 2 === 0,
        (cur) => cur.counter.count,
      );
    });
  }
}

/** Sends `times` increments under one lock, and releases it. */
async function increment(target: Counter, times: number): Promise<void> {
  await using send = await lock(target);
  for (let i = 0; i < times; i += 1) {
    send(counterSignals.increment());
  }
}

describe("observers, watches and events", () => {
  test("an observer has its callback once settled resolves", async () => {
    const counter = new Counter();
    const seen = vi.fn();
    using observer = observe(counter, [counterState.active], seen);

    await increment(counter, 1);
    expect(seen).not.toHaveBeenCalled(); // delivered on a later timer turn

    await settled(counter);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }), "counter");
  });

  test("a compare filters the changes the callback sees", async () => {
    const counter = new Counter();
    const seen = vi.fn();
    using observer = observe(counter, [counterState.active], seen, (prev, cur) => cur.count % 2 === 0);

    await increment(counter, 3);
    await settled(counter);

    expect(seen).toHaveBeenCalledTimes(1);
  });

  test("an event is emitted after each commit that fires it", async () => {
    const counter = new Counter();
    const even = vi.fn();
    counter.on("even", even);

    await increment(counter, 4);
    await settled(counter);

    expect(even.mock.calls).toEqual([[2], [4]]);
  });

  test("a watch callback that sends through the lock is done when settled resolves", async () => {
    const counter = new Counter();
    using onFirst = watch(
      counter,
      (cur, prev) => prev.counter.count === 0 && cur.counter.count === 1,
      async () => {
        await using send = await lock(counter);
        send(counterSignals.increment());
      },
    );

    await increment(counter, 1);
    await settled(counter);

    expect(counter.counter.count).toBe(2);
  });
});
```

## Error Conditions

Every error the engine raises has a stable `code`, and its message ends with that code in brackets and a short fix; a refusal whose text the engine writes names its code on the result (see [Error Types](/docs/api-reference#error-types)).

A reducer's throw is an Error result. A handler's throw refuses the step, and its log entry names the handler; entries are delivered after the dispatch returns, so the test lets a timer turn pass:

```typescript
import { describe, expect, test } from "vitest";
import { applyFlow, defineFlow, defineSignal, defineState, HandlerResult, lock, ResultKind, type StateFlowLogEntry } from "@state-flow/core";

const storeSignals = { corrupt: defineSignal("corrupt"), open: defineSignal("open") };

const storeState = defineState<{ items: string[] }>()
  .name("store")
  .signals(storeSignals)
  .variant("ready", { initial: true })
  .variant("open")
  .build();

defineFlow(storeState.ready, {
  corrupt: () => {
    throw new Error("data corruption detected");
  },
  open: (s) => storeState.open(s),
});

const nextTimerTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("errors", () => {
  test("a reducer that throws gives an Error result, and expect() throws with its message", async () => {
    const app = { store: { items: [] as string[] } };
    applyFlow(app, [storeState], () => {});

    await using send = await lock(app);
    const result = send(storeSignals.corrupt());

    expect(result.kind).toBe(ResultKind.Error);
    expect(() => result.expect(ResultKind.OK)).toThrow("data corruption detected");
  });

  test("a handler that throws refuses the step, and its entry names it", async () => {
    const entries: StateFlowLogEntry[] = [];
    const app = { store: { items: [] as string[] } };
    applyFlow(
      app,
      [storeState],
      (sm) => {
        sm.addEnterHandler(storeState.open, function openStore() {
          throw new Error("disk full");
        });
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );

    await using send = await lock(app);
    const result = send(storeSignals.open());

    expect(result.kind).toBe(ResultKind.Error);
    expect(String(app.store)).toBe("store.ready(items=[])"); // nothing committed

    await nextTimerTurn();
    expect(entries.at(-1)?.handlerResults).toContainEqual({
      type: "enter",
      handlerName: "openStore",
      stateName: "store",
      result: "Error: disk full",
    });
  });
});
```

## Simulating with Handlers Off

With every handler switched off, the real object runs its real methods and no handler touches the world. `setHandlersDisabled(true)` is read at every handler call, so it acts on targets built before or after it. Reducers, commits, observers and the log still run; a declared transition has no work, so its next commits inside the send that declared it, with the props the world would fill left at their defaults.

`mockHandlers` gives each test the world's answer it needs: a mock runs whatever the switch says, gets the real arguments, and its named result folds into props as a handler's would. A recording world checks after each test that no call reached it:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HandlerResult, mockHandlers, ResultKind, setHandlersDisabled, stateVar } from "@state-flow/core";
import { driverState, Player, type World } from "./player";

// A stand-in for everything the player calls outside StateFlow, recording each call.
function recordingWorld() {
  const calls: string[] = [];
  const world: World = {
    fetchManifest: async (url) => {
      calls.push(`fetchManifest ${url}`);
      return { url, tracks: ["video"] };
    },
    attach: (manifest) => {
      calls.push(`attach ${manifest.url}`);
    },
    detach: () => {
      calls.push("detach");
    },
  };
  return { world, calls };
}

const fakeManifest = { url: "https://example.com/a", tracks: ["video"] };

describe("player with every handler off", () => {
  let recording: ReturnType<typeof recordingWorld>;

  beforeEach(() => {
    setHandlersDisabled(true);
    recording = recordingWorld();
  });

  afterEach(() => {
    setHandlersDisabled(false);
    expect(recording.calls).toEqual([]);
  });

  it("play reaches active with the manifest the mock gave", async () => {
    using mocks = mockHandlers(driverState.active, {
      transition: async () => driverState.active.results.loaded({ manifest: fakeManifest }),
    });
    const player = new Player(recording.world);

    await player.play(fakeManifest.url);

    expect(stateVar(player.driver)).toBe(driverState.active);
    expect(player.driver.manifest).toBe(fakeManifest);
  });

  it("play rejects, and ends in failed, when the mock refuses", async () => {
    using mocks = mockHandlers(driverState.active, { transition: async () => HandlerResult.rejected("no manifest") });
    const player = new Player(recording.world);

    await expect(player.play(fakeManifest.url)).rejects.toThrow("no manifest");

    expect(stateVar(player.driver)).toBe(driverState.failed);
    expect(player.driver.reason).toBe("no manifest");
  });

  it("with no mock, play commits active at once, and the manifest stays at its default", async () => {
    const player = new Player(recording.world);

    const result = await player.play(fakeManifest.url);

    expect(result.kind).toBe(ResultKind.OK);
    expect(stateVar(player.driver)).toBe(driverState.active);
    expect(player.driver.manifest).toBeNull();
  });
});

it("positive control: with handlers on, the same run calls the world", async () => {
  const { world, calls } = recordingWorld();
  const player = new Player(world);

  await player.play(fakeManifest.url);

  expect(calls).toEqual([`fetchManifest ${fakeManifest.url}`, `attach ${fakeManifest.url}`]);
});
```

Two conditions make any object testable this way, and they double as a refactoring target: all of its state lives in StateFlow, with no field that copies it, and every outside call lives in a handler. Its public methods may hold any logic.

A test that begins in the middle of a session starts the flow from given states with `start` in `applyFlow`'s config, in place of sending the signals that lead there. Nothing runs for it, not even an enter handler, so the instance may be in an asynchronous variant whose work was never done:

```typescript
const player = { driver: { url: "", manifest: null, reason: null } };
applyFlow(player, [driverState], () => {}, {
  start: { driver: driverState.active({ url: fakeManifest.url, manifest: fakeManifest, reason: null }) },
});

expect(stateVar(player.driver)).toBe(driverState.active);
```

The start writes no log entry, and events and watches compare the first commit with it. A variant marked transitional is refused, since no transition is pending. Nothing else is checked: a name that matches no state is ignored, and an instance of another definition is taken as it is.

A mock's refusal may carry data, as the world's handler would: `HandlerResult.rejected(message, data)` (see [Refusal data](/docs/api-reference#refusal-data)). A failed end that decides from that data, and not from an error's class, reaches the same state when a test or a replay builds the refusal again from the plain data a tap recorded as `result.data`.

What a run with every handler off and no mock does not cover:

- Every declared transition reaches its next, so code that runs only after a failed end or an abort is not reached; a mock that refuses reaches the failed end.
- An abort finds no transition pending, since each ended inside its send: the abort's signal is reduced as an ordinary signal, and abort reducers are not reached.
- `Box.deref()` works as usual, and the engine still disposes the `DisposableBox`es that commits drop and that `disposeFlow` finds: put recording stand-ins in the target's boxes too.

## Controlling Time

Every timer of a flow goes through the `timers` of its config: a declared transition's timeout, an accepted abort's wait for the work, the deliveries of observers, watches, events and subscribers, and `settled`'s wait for them. A test that must not fake the globals gives the flow a clock of its own: nothing times out and nothing is delivered until the test moves that clock, and `settled` resolves only once the clock has run the deliveries.

```typescript
import { expect, it } from "vitest";
import { stateVar } from "@state-flow/core";
import { driverState, Player, type World } from "./player";

// A clock the test moves by hand: advance(ms) runs each timer that falls due, earliest first.
class ManualClock {
  #now = 0;
  readonly #timers = new Set<{ at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const timer = { at: this.#now + ms, callback };
    this.#timers.add(timer);
    return timer;
  }

  clearTimeout(timer: unknown): void {
    this.#timers.delete(timer as { at: number; callback: () => void });
  }

  advance(ms: number): void {
    const until = this.#now + ms;
    for (let due = this.#next(until); due !== undefined; due = this.#next(until)) {
      this.#timers.delete(due);
      this.#now = due.at;
      due.callback();
    }
    this.#now = until;
  }

  #next(until: number) {
    // A stable sort keeps timers due at the same time in the order they were set.
    return [...this.#timers].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
  }
}

// The world never answers, so only the clock ends a play.
const silentWorld: World = {
  fetchManifest: () => new Promise(() => {}),
  attach: () => {},
  detach: () => {},
};

it("play times out when the test moves the clock to its timeout, and not before", async () => {
  const clock = new ManualClock();
  const player = new Player(silentWorld, clock);
  const timeout =
    "driver did not reach driver.active within 5000 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.";

  const playing = player.play("https://example.com/slow");
  const rejected = expect(playing).rejects.toThrow(timeout);
  await new Promise((resolve) => setTimeout(resolve, 0)); // play holds the lock; its transition is pending

  clock.advance(4999);
  expect(stateVar(player.driver)).toBe(driverState.activating);

  clock.advance(1);
  await rejected;
  expect(stateVar(player.driver)).toBe(driverState.failed);
  expect(player.driver.reason).toBe(timeout);
});
```

## Test Utilities

```typescript
// test-utils.ts
import { lock, type Result, type Signal } from "@state-flow/core";

/** Sends `signals` in order under one lock, and returns each outcome, a transition's end included. */
export async function sendAll(target: object, ...signals: Signal[]): Promise<Result[]> {
  await using send = await lock(target);
  const results: Result[] = [];
  for (const signal of signals) {
    results.push(await send(signal).done());
  }
  return results;
}

/** Resolves on the next turn of the timers, after the log entries of the dispatches before it were delivered. */
export const nextTimerTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
```

## Practices

1. Test reducers through a target: send the signal, assert the result and the state.
2. Assert refusals as well as successes: the kind, the message, and that nothing else committed.
3. Give the world's answers with `mockHandlers`, and keep the other handlers real or switched off.
4. Await `settled(target)`, after releasing the lock, before asserting on observers, watches, events or subscribers.
5. Control time through the flow's `timers` or fake timers, never by waiting on the wall clock.
