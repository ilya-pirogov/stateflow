import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  driverState,
  type Manifest,
  media,
  Player,
  producer,
  type RtpProducer,
  recordingWorld,
  Session,
  type Track,
  transport,
  type WireSocket,
  type World,
} from "../../examples/examples";
import {
  addGlobalLogHandler,
  Box,
  HandlerResult,
  mockHandlers,
  ResultKind,
  type StateFlowLogEntry,
  setHandlersDisabled,
  stateVar,
  TransitionAborted,
} from "..";

/**
 * The library's acceptance: the player and the session of examples.ts are tested through their real constructors
 * and methods with every handler off, mocks giving the world's answers. A method resolves only when its signal
 * reached its end; a refusal, a timeout or an abort rejects, and the test then reads the state it left. After each
 * test the recording world must have no call: a world call, answered or thrown, could end in a failed state and let a
 * wrong test pass.
 */
describe("acceptance", () => {
  let world: World;
  let worldCalls: string[];

  beforeEach(() => {
    ({ world, calls: worldCalls } = recordingWorld());
    setHandlersDisabled(true);
  });

  afterEach(() => {
    try {
      expect(worldCalls).toEqual([]);
    } finally {
      setHandlersDisabled(false);
    }
  });

  /** A transition mock that answers only when its signal aborts, by rejecting with the reason. `working` resolves
   * to that signal once the mock was called, so the transition is pending from then on. */
  function waitingForAbort() {
    let started: (signal: AbortSignal) => void = () => {};
    const working = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const transition = (_next: unknown, _snapshot: unknown, _prev: unknown, _key: unknown, signal: AbortSignal) => {
      started(signal);
      return new Promise<HandlerResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    return { working, transition };
  }

  describe("player", () => {
    const url = "https://example.com/movie";
    const fakeManifest: Manifest = { url, tracks: ["video", "audio"] };

    it("play reaches active with the manifest the world gave", async () => {
      using _mocks = mockHandlers(driverState.active, {
        transition: async () => driverState.active.results.loaded({ manifest: fakeManifest }),
      });
      const player = new Player(world);

      const result = await player.play(url);

      expect(result.kind).toBe(ResultKind.OK);
      expect(stateVar(player.driver)).toBe(driverState.active);
      expect(player.driver.manifest).toBe(fakeManifest);
    });

    it("play with a world that refuses rejects with the refusal, once the driver is failed with it as its reason", async () => {
      using _mocks = mockHandlers(driverState.active, {
        transition: async () => HandlerResult.rejected("no manifest"),
      });
      const player = new Player(world);

      await expect(player.play(url)).rejects.toThrow("no manifest");

      expect(stateVar(player.driver)).toBe(driverState.failed);
      // Put there by failed's FAILURE reducer, with the kind of the failure.
      expect(player.driver.reason).toBe("no manifest");
      expect(player.driver.failure).toBe("rejected");
    });

    it("a play the world does not answer is activating for the default 500 ms, then rejects with the timeout, once the driver is failed", async () => {
      const { working, transition } = waitingForAbort();
      using _mocks = mockHandlers(driverState.active, { transition });
      const player = new Player(world);
      vi.useFakeTimers();
      try {
        const timeout =
          "driver did not reach driver.active within 500 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.";
        const playing = player.play(url);
        // Awaited after the timers run, so the rejection has its handler before it happens.
        const rejected = expect(playing).rejects.toThrow(timeout);
        await working;

        await vi.advanceTimersByTimeAsync(499);
        expect(stateVar(player.driver)).toBe(driverState.activating);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;

        expect(stateVar(player.driver)).toBe(driverState.failed);
        expect(player.driver.reason).toBe(timeout);
        expect(player.driver.failure).toBe("timeout");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stop during play aborts it: the work's signal says 'aborted by stop', play rejects with that, the driver is idle, and stop resolves", async () => {
      const { working, transition } = waitingForAbort();
      using _mocks = mockHandlers(driverState.active, { transition });
      const player = new Player(world);

      const playing = player.play(url);
      const rejected = expect(playing).rejects.toThrow("aborted by stop");
      const signal = await working;
      const stopped = player.stop();
      await rejected;

      expect(signal.reason).toBeInstanceOf(TransitionAborted);
      expect(signal.reason).toMatchObject({
        kind: "aborted",
        message:
          "aborted by stop [SF040] Stop the work on abort and release what it acquired; expect Rejected where an abort may come.",
      });
      expect(stateVar(player.driver)).toBe(driverState.idle);
      expect((await stopped).kind).toBe(ResultKind.OK);
    });

    it("stop from active runs the exit mock with the active instance", async () => {
      const exited: unknown[] = [];
      using _mocks = mockHandlers(driverState.active, {
        exit: (state) => {
          exited.push(state);
          return HandlerResult.ok();
        },
      });
      const player = new Player(world);
      await player.play(url);
      const active = player.driver;

      const result = await player.stop();

      expect(result.kind).toBe(ResultKind.OK);
      expect(exited).toHaveLength(1);
      expect(exited[0]).toBe(active);
      expect(stateVar(player.driver)).toBe(driverState.idle);
    });

    it("stop on a player that never played throws: no reducer takes it in driver.idle", async () => {
      const player = new Player(world);

      await expect(player.stop()).rejects.toThrow(/Signal 'stop\{\}' was ignored/);
      expect(stateVar(player.driver)).toBe(driverState.idle);
    });

    it("with no mock play has no work and commits active at once, the manifest left null", async () => {
      const entries: StateFlowLogEntry[] = [];
      const removeLogHandler = addGlobalLogHandler((entry) => entries.push(entry));
      try {
        const player = new Player(world);

        const result = await player.play(url);
        // Log entries are delivered after their dispatch returns.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.kind).toBe(ResultKind.OK);
        expect(stateVar(player.driver)).toBe(driverState.active);
        expect(player.driver.manifest).toBeNull();
        // The temp step and the end, both inside play's send: no transition handler ran, and neither entry ended
        // after the send returned.
        expect(entries.map((entry) => [entry.transition, entry.isAsync, entry.handlerResults])).toEqual([
          ["temp", false, []],
          ["final", false, []],
        ]);
      } finally {
        removeLogHandler();
      }
    });
  });

  describe("session", () => {
    const cam: Track = { id: "cam" };
    const mic: Track = { id: "mic" };
    const fakeProducer: RtpProducer = { close() {}, pause() {}, resume() {} };
    const fakeSocket: WireSocket = { close() {} };

    /** A session whose media is active: open has no work, so it commits at once. */
    async function openSession(): Promise<Session> {
      const session = new Session(world);
      await session.open();
      return session;
    }

    /** A handler mock that records "<label> <key>" in `log`, the key left out when undefined. */
    const recording =
      (log: string[], label: string) =>
      (_state: unknown, _snapshot: unknown, _prev: unknown, key: unknown): HandlerResult => {
        log.push(key === undefined ? label : `${label} ${String(key)}`);
        return HandlerResult.ok();
      };

    it("addProducer puts the producer the world created into the element", async () => {
      using _mocks = mockHandlers(producer.active, {
        transition: async () => producer.active.results.created({ producer: Box.of(fakeProducer) }),
      });
      const session = await openSession();

      const result = await session.addProducer("cam", cam);

      expect(result.kind).toBe(ResultKind.OK);
      expect(stateVar(session.media.producers.get("cam"))).toBe(producer.active);
      expect(session.media.producers.get("cam")?.producer?.deref()).toBe(fakeProducer);
    });

    it("addProducer the world refuses rejects with the refusal, once the element is failed, not creating, with the refusal as its reason", async () => {
      using _mocks = mockHandlers(producer.active, {
        transition: async () => HandlerResult.rejected("no room for cam"),
      });
      const session = await openSession();

      await expect(session.addProducer("cam", cam)).rejects.toThrow("no room for cam");

      expect(stateVar(session.media.producers.get("cam"))).toBe(producer.failed);
      // The failed is media's; FAILURE reaches the element the failed end enters inside it.
      expect(session.media.producers.get("cam")?.reason).toBe("no room for cam");
      expect(session.media.producers.get("cam")?.failure).toBe("rejected");
      expect(stateVar(session.media)).toBe(media.active);
    });

    it("addProducer the world does not answer is creating for 5000 ms, then rejects with the timeout, once the element is failed", async () => {
      const { working, transition } = waitingForAbort();
      using _mocks = mockHandlers(producer.active, { transition });
      const session = await openSession();
      vi.useFakeTimers();
      try {
        const adding = session.addProducer("cam", cam);
        // The transition is media's, whose reducer declared it.
        const rejected = expect(adding).rejects.toThrow(
          "media did not reach media.active within 5000 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
        );
        await working;

        await vi.advanceTimersByTimeAsync(4999);
        expect(stateVar(session.media.producers.get("cam"))).toBe(producer.creating);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;

        expect(stateVar(session.media.producers.get("cam"))).toBe(producer.failed);
        expect(session.media.producers.get("cam")?.reason).toBe(
          "media did not reach media.active within 5000 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
        );
        expect(session.media.producers.get("cam")?.failure).toBe("timeout");
      } finally {
        vi.useRealTimers();
      }
    });

    it("addProducer on a closed session throws: no reducer takes it in media.idle", async () => {
      const session = await openSession();
      await session.close();

      await expect(session.addProducer("cam", cam)).rejects.toThrow(
        /Signal 'addProducer\{.*\}' was ignored: Message: no reducer for addProducer in media\.idle/,
      );
      expect(stateVar(session.media)).toBe(media.idle);
      expect(session.media.producers.size).toBe(0);
    });

    it("addProducer under a key a producer already has throws with the reducer's refusal, and the first producer stays as it was", async () => {
      const session = await openSession();
      await session.addProducer("cam", cam);
      const first = session.media.producers.get("cam");

      await expect(session.addProducer("cam", mic)).rejects.toThrow("cam already exists");

      expect(session.media.producers.get("cam")).toBe(first);
    });

    it("close on a session that never opened throws: no reducer takes it in media.idle", async () => {
      const session = new Session(world);

      await expect(session.close()).rejects.toThrow(/Signal 'close\{\}' was ignored/);
      expect(stateVar(session.media)).toBe(media.idle);
    });

    it("pause flips only the keyed producer's flag: it stays active, active's update runs for it alone, and media gets no call", async () => {
      const session = await openSession();
      await session.addProducer("cam", cam);
      await session.addProducer("mic", mic);
      const before = session.media;
      const calls: string[] = [];
      using _media = mockHandlers(media.active, {
        enter: recording(calls, "media.active enter"),
        exit: recording(calls, "media.active exit"),
        update: recording(calls, "media.active update"),
        commit: recording(calls, "media.active commit"),
      });
      using _active = mockHandlers(producer.active, {
        enter: recording(calls, "producer.active enter"),
        exit: recording(calls, "producer.active exit"),
        update: recording(calls, "producer.active update"),
      });

      const result = await session.pause("cam");

      expect(result.kind).toBe(ResultKind.OK);
      expect(calls).toEqual(["producer.active update cam"]);
      expect(stateVar(session.media.producers.get("cam"))).toBe(producer.active);
      expect(session.media.producers.get("cam")?.paused).toBe(true);
      expect(session.media.producers.get("mic")).toBe(before.producers.get("mic"));
      expect(session.media.transport).toBe(before.transport);
    });

    it("pause of a key no producer has throws: every producer's reducer ignores it, and nothing changes", async () => {
      const session = await openSession();
      await session.addProducer("cam", cam);
      const before = session.media;

      await expect(session.pause("mic")).rejects.toThrow("Signal 'pause{key=mic}' was ignored");

      expect(session.media).toBe(before);
    });

    it("with the session's own handlers on and only the world's answers mocked: pause and resume make active's update handler pause and resume the producer, and its exit closes the producer on a removal and on a close, never on a pause", async () => {
      setHandlersDisabled(false);
      // The world's producers, one per key, recording what the session's handlers call on them.
      const producerCalls: string[] = [];
      const recordingProducer = (key: string): RtpProducer => ({
        close: () => producerCalls.push(`close ${key}`),
        pause: () => producerCalls.push(`pause ${key}`),
        resume: () => producerCalls.push(`resume ${key}`),
      });
      using _transport = mockHandlers(transport.open, {
        transition: async () => transport.open.results.opened({ socket: Box.of(fakeSocket) }),
      });
      using _producer = mockHandlers(producer.active, {
        transition: async (_p, _snapshot, _prev, key) =>
          producer.active.results.created({ producer: Box.of(recordingProducer(String(key))) }),
      });
      const session = await openSession();
      await session.addProducer("cam", cam);
      await session.addProducer("mic", mic);

      await session.pause("cam");
      expect(session.media.producers.get("cam")?.paused).toBe(true);
      await session.resume("cam");
      expect(session.media.producers.get("cam")?.paused).toBe(false);
      expect(producerCalls).toEqual(["pause cam", "resume cam"]);

      await session.removeProducer("cam");
      await session.close();

      expect(producerCalls).toEqual(["pause cam", "resume cam", "close cam", "close mic"]);
    });

    it("with the session's own handlers on, a close another handler refuses leaves the producer and the socket open: the exits close them only once their step commits", async () => {
      setHandlersDisabled(false);
      const closed: string[] = [];
      using _transport = mockHandlers(transport.open, {
        transition: async () =>
          transport.open.results.opened({ socket: Box.of({ close: () => closed.push("close socket") }) }),
      });
      using _producer = mockHandlers(producer.active, {
        transition: async () =>
          producer.active.results.created({
            producer: Box.of({ close: () => closed.push("close cam"), pause() {}, resume() {} }),
          }),
      });
      const session = await openSession();
      await session.addProducer("cam", cam);

      {
        // Exits run before enters, so both exits have run when idle's enter refuses the step.
        using _refusing = mockHandlers(media.idle, { enter: () => HandlerResult.rejected("not now") });
        await expect(session.close()).rejects.toThrow("not now");
      }
      expect(stateVar(session.media)).toBe(media.active);
      expect(closed).toEqual([]);

      await session.close();
      expect(closed).toEqual(["close cam", "close socket"]);
    });

    it("close during addProducer aborts it: the producer's transition mock sees the abort, addProducer rejects, close resolves, the session ends idle, and the exits run producers, transport, media", async () => {
      const session = await openSession();
      // Added before the mocks, so it commits at once.
      await session.addProducer("mic", mic);
      const { working, transition } = waitingForAbort();
      const exits: string[] = [];
      using _active = mockHandlers(producer.active, { transition, exit: recording(exits, "producer.active exit") });
      using _creating = mockHandlers(producer.creating, { exit: recording(exits, "producer.creating exit") });
      using _transport = mockHandlers(transport.open, { exit: recording(exits, "transport.open exit") });
      using _media = mockHandlers(media.active, { exit: recording(exits, "media.active exit") });

      const adding = session.addProducer("cam", cam);
      const rejected = expect(adding).rejects.toThrow("aborted by close");
      const signal = await working;
      const closed = session.close();
      await rejected;

      expect(signal.reason).toBeInstanceOf(TransitionAborted);
      expect(signal.reason).toMatchObject({
        kind: "aborted",
        message:
          "aborted by close [SF040] Stop the work on abort and release what it acquired; expect Rejected where an abort may come.",
      });
      expect((await closed).kind).toBe(ResultKind.OK);
      expect(stateVar(session.media)).toBe(media.idle);
      expect(stateVar(session.media.transport)).toBe(transport.closed);
      expect(session.media.producers.size).toBe(0);
      // Children before their parent, later siblings first.
      expect(exits).toEqual([
        "producer.creating exit cam",
        "producer.active exit mic",
        "transport.open exit",
        "media.active exit",
      ]);
    });

    it("open: media is opening while the transport connects, then active with the socket filled in through the transport's result reducer", async () => {
      let mediaWhileConnecting: unknown;
      using _mocks = mockHandlers(transport.open, {
        transition: async () => {
          mediaWhileConnecting = stateVar(session.media);
          return transport.open.results.opened({ socket: Box.of(fakeSocket) });
        },
      });
      const session = new Session(world);

      const result = await session.open();

      expect(mediaWhileConnecting).toBe(media.opening);
      expect(result.kind).toBe(ResultKind.OK);
      expect(stateVar(session.media)).toBe(media.active);
      expect(stateVar(session.media.transport)).toBe(transport.open);
      expect(session.media.transport.socket?.deref()).toBe(fakeSocket);
    });

    it("open the world refuses rejects with the refusal, once media is back in idle with its transport closed", async () => {
      using _mocks = mockHandlers(transport.open, { transition: async () => HandlerResult.rejected("no route") });
      const session = new Session(world);

      await expect(session.open()).rejects.toThrow("no route");

      expect(stateVar(session.media)).toBe(media.idle);
      expect(stateVar(session.media.transport)).toBe(transport.closed);
    });

    it("close during open aborts it: the transport's transition mock sees the abort, and the session ends idle", async () => {
      const { working, transition } = waitingForAbort();
      using _mocks = mockHandlers(transport.open, { transition });
      const session = new Session(world);

      const opening = session.open();
      const rejected = expect(opening).rejects.toThrow("aborted by close");
      const signal = await working;
      expect(stateVar(session.media)).toBe(media.opening);
      const closed = session.close();
      await rejected;

      expect(signal.reason).toBeInstanceOf(TransitionAborted);
      expect(signal.reason).toMatchObject({
        kind: "aborted",
        message:
          "aborted by close [SF040] Stop the work on abort and release what it acquired; expect Rejected where an abort may come.",
      });
      expect((await closed).kind).toBe(ResultKind.OK);
      expect(stateVar(session.media)).toBe(media.idle);
      expect(stateVar(session.media.transport)).toBe(transport.closed);
    });
  });
});
