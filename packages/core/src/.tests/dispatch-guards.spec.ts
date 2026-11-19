import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  consoleLogHandler,
  type DispatchFn,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  HandlerResult,
  lock,
  observe,
  ResultKind,
  type StateFlowLogEntry,
  type StateInstance,
  StateResult,
  setConsoleLogSilenced,
} from "..";

/**
 * What a dispatch may meet: re-entry from inside its own step throws, the lock holder's sends queue behind
 * a pending transition and drain in order after it, a bare dispatch during a transition throws, and the
 * `mute` option.
 */
describe("dispatch guards", () => {
  const toggle = defineSignal("toggle");
  const start = defineSignal("start");
  const bump = defineSignal("bump");
  const restart = defineSignal("restart");
  const quick = defineSignal("quick");
  const breakIt = defineSignal("breakIt");
  const poke = defineSignal("poke");

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const defineLight = () => {
    const light = defineState<{ n: number }>()
      .name("light")
      .signals({ toggle })
      .variant("off", { initial: true })
      .variant("on")
      .build();
    defineFlow(light.off, { toggle: (s) => light.on({ n: s.n + 1 }) });
    defineFlow(light.on, { toggle: (s) => light.off(s) });
    return light;
  };

  /** idle declares done through running; done's reducers queue up behind it in the tests. */
  const defineJob = () => {
    const job = defineState<{ n: number }>()
      .name("job")
      .signals({ start, bump, restart, quick, breakIt, poke })
      .variant("idle", { initial: true })
      .variant("running")
      .variant("done", { async: true })
      .variant("failed")
      .variant("broken")
      .build();
    defineFlow(job.idle, {
      start: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s)),
      poke: (s) => ({ n: s.n + 1 }),
    });
    defineFlow(job.done, {
      bump: (s) => ({ n: s.n + 1 }),
      restart: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s)),
      // To its own variant with its own instance as temp, done is updated and nothing enters it: the transition has
      // no work, and it ends inside the dispatch that declares it.
      quick: (s, _signal, ctx) => StateResult.transition(job.done({ n: s.n + 5 }), job(ctx), job.failed(s)),
      breakIt: (s) => job.broken(s),
    });
    return job;
  };
  type JobDef = ReturnType<typeof defineJob>;
  type JobTarget = { job: StateInstance<{ n: number }> };

  /** A job target whose transition into done takes 100 ms and returns OK. */
  function makeJob(job: JobDef, entries: StateFlowLogEntry[] = []): JobTarget {
    const target = { job: { n: 0 } };
    applyFlow(
      target,
      [job],
      (sm) =>
        sm.addTransitionHandler(job.done, async () => {
          await sleep(100);
          return HandlerResult.ok();
        }),
      { logHandlers: [(entry) => entries.push(entry)] },
    );
    return target as unknown as JobTarget;
  }

  it("a handler's synchronous dispatch to its own target throws; the handler's result in the log entry carries the Error, which refuses the outer dispatch", async () => {
    const light = defineLight();
    const entries: StateFlowLogEntry[] = [];
    const target = { light: { n: 0 } };
    applyFlow(
      target,
      [light],
      (sm) =>
        sm.addEnterHandler(light.on, function redispatch() {
          dispatch(target, toggle());
          return HandlerResult.ok();
        }),
      { logHandlers: [(entry) => entries.push(entry)] },
    );

    const r = dispatch(target, toggle());

    expect(r.kind).toBe(ResultKind.Error);
    expect(String(r)).toBe(
      "StateFlowError: Cannot dispatch to Object from inside its own dispatch [SF016] Return a named result from the handler, or send after the dispatch returns.",
    );
    expect(String(target.light)).toBe("light.off(n=0)");
    await flush();
    expect(entries).toHaveLength(1);
    expect(entries[0].handlerResults).toEqual([
      expect.objectContaining({
        type: "enter",
        handlerName: "redispatch",
        result:
          "StateFlowError: Cannot dispatch to Object from inside its own dispatch [SF016] Return a named result from the handler, or send after the dispatch returns.",
      }),
    ]);
  });

  it("the lock holder's send from a handler inside the target's own step throws; the handler's result in the log entry carries the Error, which refuses the outer send", async () => {
    const light = defineLight();
    const entries: StateFlowLogEntry[] = [];
    const target = { light: { n: 0 } };
    let send: DispatchFn | undefined;
    applyFlow(
      target,
      [light],
      (sm) =>
        sm.addEnterHandler(light.on, function resend() {
          send?.(toggle());
          return HandlerResult.ok();
        }),
      { logHandlers: [(entry) => entries.push(entry)] },
    );
    send = await lock(target);

    const r = send(toggle());

    expect(r.kind).toBe(ResultKind.Error);
    expect(String(r)).toBe(
      "StateFlowError: Cannot dispatch to Object from inside its own dispatch [SF016] Return a named result from the handler, or send after the dispatch returns.",
    );
    expect(String(target.light)).toBe("light.off(n=0)");
    await send[Symbol.asyncDispose]();
    await flush();
    expect(entries).toHaveLength(1);
    expect(entries[0].handlerResults).toEqual([
      expect.objectContaining({
        type: "enter",
        handlerName: "resend",
        result:
          "StateFlowError: Cannot dispatch to Object from inside its own dispatch [SF016] Return a named result from the handler, or send after the dispatch returns.",
      }),
    ]);
  });

  it("an observer compare that throws during a plain step's commit breaks nothing: the state is set, the dispatch is OK, the entry logs the throw as that observer's result, and console.error reports it", async () => {
    const light = defineLight();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const entries: StateFlowLogEntry[] = [];
    const target = { light: { n: 0 } };
    applyFlow(target, [light], () => {}, { logHandlers: [(entry) => entries.push(entry)] });
    const thrown = new Error("compare boom");
    using _observer = observe(
      target,
      [light.on],
      function seen() {},
      () => {
        throw thrown;
      },
    );

    const r = dispatch(target, toggle());

    expect(r.kind).toBe(ResultKind.OK);
    expect(String(target.light)).toBe("light.on(n=1)");
    expect(error).toHaveBeenCalledWith("[SF/Object] the compare of observer seen on light.on threw:", thrown);
    await flush();
    expect(entries).toHaveLength(1);
    expect(entries[0].finalResult).toBe("OK");
    expect(entries[0].observers).toEqual([
      { stateName: "light", observerName: "seen", needObserve: false, error: "Error: compare boom" },
    ]);
    // The console handler prints the throw as the observer's result.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const quiet of ["groupCollapsed", "groupEnd", "debug"] as const) {
      vi.spyOn(console, quiet).mockImplementation(() => {});
    }
    setConsoleLogSilenced(false);
    try {
      consoleLogHandler(entries[0]);
    } finally {
      setConsoleLogSilenced(null);
    }
    expect(log).toHaveBeenCalledWith("\tobserved by seen() => threw Error: compare boom");
  });

  it("an observer whose compare declines leaves no record in the step's entry", async () => {
    const light = defineLight();
    const entries: StateFlowLogEntry[] = [];
    const target = { light: { n: 0 } };
    applyFlow(target, [light], () => {}, { logHandlers: [(entry) => entries.push(entry)] });
    using _observer = observe(
      target,
      [light.on],
      function seen() {},
      () => false,
    );

    dispatch(target, toggle());

    expect(String(target.light)).toBe("light.on(n=1)");
    await flush();
    expect(entries).toHaveLength(1);
    expect(entries[0].observers).toEqual([]);
  });

  it("a string form that throws while a plain step is logged leaves the dispatch: nothing commits, and the step's entry records the Error", async () => {
    const light = defineState<{ n: number }>()
      .name("light")
      .signals({ toggle })
      .variant("off", { initial: true })
      .variant("on")
      .stringRepr((s) => {
        if (s.n === 13) {
          throw new Error("no string form for 13");
        }
        return `n=${s.n}`;
      })
      .build();
    defineFlow(light.off, { toggle: (s) => light.on({ n: s.n + 1 }) });
    const entries: StateFlowLogEntry[] = [];
    const target = { light: { n: 12 } };
    applyFlow(target, [light], () => {}, { logHandlers: [(entry) => entries.push(entry)] });

    expect(() => dispatch(target, toggle())).toThrow("no string form for 13");

    expect(String(target.light)).toBe("light.off(n=12)");
    await flush();
    expect(entries).toHaveLength(1);
    expect(entries[0].finalResult).toBe("Error: no string form for 13");
  });

  it("the holder's send during a pending transition returns a pending result and is reduced after the end, in order", async () => {
    const job = defineJob();
    const entries: StateFlowLogEntry[] = [];
    const target = makeJob(job, entries);
    const holder = await lock(target);
    expect(holder(start()).kind).toBe(ResultKind.InTransition);

    const first = holder(bump());
    const second = holder(bump());

    expect(first.kind).toBe(ResultKind.InTransition);
    expect(second.kind).toBe(ResultKind.InTransition);
    expect(String(target.job)).toBe("job.running(n=0)");
    await vi.advanceTimersByTimeAsync(100);
    expect((await first.done()).kind).toBe(ResultKind.OK);
    expect((await second.done()).kind).toBe(ResultKind.OK);
    expect(String(target.job)).toBe("job.done(n=2)");
    await holder[Symbol.asyncDispose]();
    await flush();
    expect(entries.map((e) => `${e.signal} ${e.finalResult}`)).toEqual([
      "start{} InTransition",
      "start{} OK",
      "bump{} OK",
      "bump{} OK",
    ]);
  });

  it("a bare dispatch during a pending transition throws, naming lock() and abort", () => {
    const job = defineJob();
    const target = makeJob(job);
    expect(dispatch(target, start()).kind).toBe(ResultKind.InTransition);

    expect(() => dispatch(target, poke())).toThrow(
      "A transition is pending on Object; use lock() to queue, or { abort: true }",
    );
  });

  it("{ mute: true } writes no entry and { mute: false } writes one", async () => {
    const job = defineJob();
    const entries: StateFlowLogEntry[] = [];
    const target = makeJob(job, entries);

    dispatch(target, poke(), { mute: true });
    await flush();
    expect(entries).toHaveLength(0);

    dispatch(target, poke(), { mute: false });
    await flush();
    expect(entries).toHaveLength(1);

    {
      await using send = await lock(target);
      send(poke(), { mute: true });
    }
    await flush();
    expect(entries).toHaveLength(1);
    expect(String(target.job)).toBe("job.idle(n=3)");
  });

  it("disposeFlow from a handler inside the target's own step throws StateFlowError; the handler's result in the log entry carries it, the other handlers of its phase still run, and the dispatch is refused", async () => {
    const light = defineLight();
    const entries: StateFlowLogEntry[] = [];
    let laterRan = false;
    const target = { light: { n: 0 } };
    applyFlow(
      target,
      [light],
      (sm) => {
        sm.addEnterHandler(light.on, function disposer() {
          disposeFlow(target);
          return HandlerResult.ok();
        });
        sm.addEnterHandler(light.on, function later() {
          laterRan = true;
          return HandlerResult.ok();
        });
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );

    const r = dispatch(target, toggle());

    expect(r.kind).toBe(ResultKind.Error);
    expect(String(r)).toBe(
      "StateFlowError: Cannot dispose Object from inside its own dispatch [SF043] Dispose after the dispatch returns.",
    );
    expect(String(target.light)).toBe("light.off(n=0)");
    expect(laterRan).toBe(true);
    await flush();
    expect(entries[0].handlerResults).toEqual([
      expect.objectContaining({
        handlerName: "disposer",
        result:
          "StateFlowError: Cannot dispose Object from inside its own dispatch [SF043] Dispose after the dispatch returns.",
      }),
      expect.objectContaining({ handlerName: "later", result: "OK" }),
    ]);
  });

  it("a transition handler's synchronous part that dispatches to or disposes its own target throws; the work settles to that Error, which takes the node to failed", async () => {
    const cases: Array<[(target: object) => void, string]> = [
      [
        (target) => dispatch(target, poke()),
        "Cannot dispatch to Object from inside its own dispatch [SF016] Return a named result from the handler, or send after the dispatch returns.",
      ],
      [
        (target) => disposeFlow(target),
        "Cannot dispose Object from inside its own dispatch [SF043] Dispose after the dispatch returns.",
      ],
    ];
    for (const [act, message] of cases) {
      const job = defineJob();
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) =>
        sm.addTransitionHandler(job.done, () => {
          act(target);
          return Promise.resolve(HandlerResult.ok());
        }),
      );

      const outcome = await dispatch(target, start()).done();

      expect(String(outcome), message).toBe(`StateFlowError: ${message}`);
      expect(String(target.job), message).toBe("job.failed(n=0)");
    }
  });

  it("a queued send that declares a transition stops the drain: the sends queued after it are reduced after that cycle's end, in order", async () => {
    const job = defineJob();
    const entries: StateFlowLogEntry[] = [];
    const target = makeJob(job, entries);
    const holder = await lock(target);
    expect(holder(start()).kind).toBe(ResultKind.InTransition);
    const restarted = holder(restart());
    const bumped = holder(bump());
    let bumpedSettled = false;
    const bumpedDone = bumped.done().then((r) => {
      bumpedSettled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(String(target.job)).toBe("job.running(n=0)");
    expect(bumpedSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(String(target.job)).toBe("job.done(n=2)");
    expect((await restarted.done()).kind).toBe(ResultKind.OK);
    expect((await bumpedDone).kind).toBe(ResultKind.OK);
    await holder[Symbol.asyncDispose]();
    await flush();
    expect(entries.map((e) => `${e.signal} ${e.transition ?? "-"} ${e.finalResult}`)).toEqual([
      "start{} temp InTransition",
      "start{} final OK",
      "restart{} temp InTransition",
      "restart{} final OK",
      "bump{} - OK",
    ]);
  });

  it("a queued send whose dispatch throws (a string form that throws while its step is logged) settles with an Error, and the drain goes on", async () => {
    const job = defineState<{ n: number }>()
      .name("job")
      .signals({ start, bump, breakIt })
      .variant("idle", { initial: true })
      .variant("running")
      .variant("done", { async: true })
      .variant("failed")
      .variant("broken")
      .stringRepr((s) => {
        if (s.n === 13) {
          throw new Error("no string form for 13");
        }
        return `n=${s.n}`;
      })
      .build();
    defineFlow(job.idle, { start: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s)) });
    defineFlow(job.done, { bump: (s) => ({ n: s.n + 1 }), breakIt: () => job.broken({ n: 13 }) });
    const target = { job: { n: 0 } };
    applyFlow(target, [job], (sm) =>
      sm.addTransitionHandler(job.done, async () => {
        await sleep(100);
        return HandlerResult.ok();
      }),
    );
    const holder = await lock(target);
    expect(holder(start()).kind).toBe(ResultKind.InTransition);
    const broken = holder(breakIt());
    const bumped = holder(bump());

    await vi.advanceTimersByTimeAsync(100);

    const b = await broken.done();
    expect(b.kind).toBe(ResultKind.Error);
    expect(b.error?.message).toBe("no string form for 13");
    expect((await bumped.done()).kind).toBe(ResultKind.OK);
    expect(String(target.job)).toBe("job.done(n=1)");
    await holder[Symbol.asyncDispose]();
  });

  it("a queued send whose transition ends synchronously: the sends queued after it are reduced next, and all settle in queue order", async () => {
    const job = defineJob();
    const target = makeJob(job);
    const holder = await lock(target);
    expect(holder(start()).kind).toBe(ResultKind.InTransition);
    const quickly = holder(quick());
    const bumped = holder(bump());
    const order: string[] = [];
    const settled = Promise.all([
      quickly.done().then(() => order.push("quick")),
      bumped.done().then(() => order.push("bump")),
    ]);

    await vi.advanceTimersByTimeAsync(100);
    await settled;

    expect(order).toEqual(["quick", "bump"]);
    expect(String(target.job)).toBe("job.done(n=6)");
    await holder[Symbol.asyncDispose]();
  });
});
