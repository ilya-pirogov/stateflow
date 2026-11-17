import { describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  HandlerResult,
  type InstanceOf,
  ResultKind,
  type StateFlowLogEntry,
  type StateManager,
  StateResult,
} from "..";

/**
 * Commit delegates (`HandlerResult.onCommit`): functions a handler attaches to the result it returns, of any kind,
 * which run right after its step commits, before the commit handlers, in the order of the handler calls that returned
 * them; a step that does not commit drops them. A transition handler's run when the transition's end step commits,
 * before the end step's own. Definitions are made inside each test, because defineFlow binds once per variant.
 */
describe("commit delegates", () => {
  const toggle = defineSignal("toggle");
  const start = defineSignal("start");

  // Log entries are delivered after the dispatch returns.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** A lamp: toggle switches off to on, with broken as the failed of that switch, and on to off. On's named result lit
   * sets the level. */
  function defineLamp() {
    const lamp = defineState<{ level: number }>()
      .name("lamp")
      .signals({ toggle })
      .variant("off", { initial: true })
      .variant("on", { results: { lit: (data) => data as { level: number } } })
      .variant("broken")
      .build();

    defineFlow(lamp.off, { toggle: (s) => StateResult.ok(lamp.on({ level: 10 }), lamp.broken(s)) });
    defineFlow(lamp.on, { toggle: () => lamp.off({ level: 0 }) }, { lit: (s, { level }) => ({ ...s, level }) });

    return lamp;
  }
  type Lamp = ReturnType<typeof defineLamp>;
  type LampTarget = { lamp: InstanceOf<Lamp> };

  /** A target of the lamp's flow, with the handlers `init` registers, its entries going to `entries`. */
  function makeLamp(
    lamp: Lamp,
    init: (sm: StateManager, target: LampTarget) => void,
    entries: StateFlowLogEntry[] = [],
  ): LampTarget {
    const target = { lamp: { level: 0 } } as unknown as LampTarget;
    applyFlow(target, [lamp], (sm) => init(sm, target), { logHandlers: [(entry) => entries.push(entry)] });

    return target;
  }

  it("an enter handler's delegate runs inside the dispatch, after the commit and before the commit handlers", () => {
    const lamp = defineLamp();

    const seen: string[] = [];
    const target = makeLamp(lamp, (sm, t) => {
      sm.addEnterHandler(lamp.on, () => {
        seen.push(`enter sees ${String(t.lamp)}`);
        return HandlerResult.ok().onCommit(() => seen.push(`delegate sees ${String(t.lamp)}`));
      });
      sm.addCommitHandler(lamp.on, () => {
        seen.push("commit handler");
      });
    });

    const result = dispatch(target, toggle());

    expect(result.kind).toBe(ResultKind.OK);
    expect(seen).toEqual(["enter sees lamp.off(level=0)", "delegate sees lamp.on(level=10)", "commit handler"]);
  });

  it("a step that a later handler refuses drops its delegates unrun; the failed step calls the exit again, and that call's delegate runs at the failed commit, before the failed step's enter's", () => {
    const lamp = defineLamp();

    const ran: string[] = [];
    let exits = 0;
    const target = makeLamp(lamp, (sm, t) => {
      sm.addExitHandler(lamp.off, () => {
        const call = ++exits;
        return HandlerResult.ok().onCommit(() => ran.push(`off's exit call ${call}`));
      });
      sm.addEnterHandler(lamp.on, () => HandlerResult.ok().onCommit(() => ran.push("on's delegate")));
      sm.addEnterHandler(lamp.on, () => HandlerResult.rejected("no bulb"));
      sm.addEnterHandler(lamp.broken, () =>
        HandlerResult.ok().onCommit(() => ran.push(`broken's sees ${String(t.lamp)}`)),
      );
    });

    const result = dispatch(target, toggle());

    expect(result.message).toBe("no bulb");
    expect(String(target.lamp)).toBe("lamp.broken(level=0)");
    expect(exits).toBe(2);
    expect(ran).toEqual(["off's exit call 2", "broken's sees lamp.broken(level=0)"]);
  });

  it("an exit handler's delegate runs after the commit", () => {
    const lamp = defineLamp();

    const seen: string[] = [];
    const target = makeLamp(lamp, (sm, t) => {
      sm.addExitHandler(lamp.on, () => HandlerResult.ok().onCommit(() => seen.push(`delegate sees ${String(t.lamp)}`)));
    });
    dispatch(target, toggle());

    dispatch(target, toggle());

    expect(seen).toEqual(["delegate sees lamp.off(level=0)"]);
  });

  it("a named result's delegate runs after the commit, which holds the result folded in", () => {
    const lamp = defineLamp();

    const seen: string[] = [];
    const target = makeLamp(lamp, (sm, t) => {
      sm.addEnterHandler(lamp.on, () =>
        lamp.on.results.lit({ level: 70 }).onCommit(() => seen.push(`delegate sees ${String(t.lamp)}`)),
      );
    });

    const result = dispatch(target, toggle());

    expect(result.kind).toBe(ResultKind.OK);
    expect(seen).toEqual(["delegate sees lamp.on(level=70)"]);
  });

  it("the delegates run in the order of the calls, exits, then updates, then enters, and a result's own in the order onCommit added them", () => {
    const lamp = defineLamp();
    const meter = defineState<{ n: number }>()
      .name("meter")
      .signals({ toggle })
      .variant("counting", { initial: true })
      .build();
    defineFlow(meter.counting, { toggle: (s) => ({ n: s.n + 1 }) });

    const order: string[] = [];
    const target = { lamp: { level: 0 }, meter: { n: 0 } };
    applyFlow(
      target,
      [lamp, meter],
      (sm) => {
        sm.addExitHandler(lamp.on, () =>
          HandlerResult.ok().onCommit(
            () => order.push("exit 1"),
            () => order.push("exit 2"),
          ),
        );
        sm.addUpdateHandler(meter.counting, () => HandlerResult.ok().onCommit(() => order.push("update")));
        sm.addEnterHandler(lamp.off, () =>
          HandlerResult.ok()
            .onCommit(() => order.push("enter 1"))
            .onCommit(() => order.push("enter 2")),
        );
        sm.addCommitHandler(lamp.off, () => {
          order.push("commit handler");
        });
      },
      { logHandlers: [() => {}] },
    );
    dispatch(target, toggle());
    order.length = 0;

    dispatch(target, toggle());

    expect(order).toEqual(["exit 1", "exit 2", "update", "enter 1", "enter 2", "commit handler"]);
  });

  it("a throw is logged as a commit result named by the handler that returned the delegate, the next delegate still runs, and the dispatch stays OK", async () => {
    const lamp = defineLamp();

    const ran: string[] = [];
    const entries: StateFlowLogEntry[] = [];
    const target = makeLamp(
      lamp,
      (sm) => {
        sm.addEnterHandler(lamp.on, function switchOn() {
          return HandlerResult.ok().onCommit(
            () => {
              throw new Error("boom");
            },
            () => ran.push("second"),
          );
        });
      },
      entries,
    );

    const result = dispatch(target, toggle());

    expect(result.kind).toBe(ResultKind.OK);
    expect(String(target.lamp)).toBe("lamp.on(level=10)");
    expect(ran).toEqual(["second"]);

    await tick();
    expect(entries[0].finalResult).toBe("OK");
    expect(entries[0].handlerResults).toContainEqual({
      type: "commit",
      handlerName: "switchOn",
      stateName: "lamp",
      result: "Error: boom",
    });
  });

  it("onCommit keeps a result's kind and reason, and its delegates run whenever its step commits: an Ignored's in a step that commits, a Rejected's and an Error's in a failed step; a refused step drops a Rejected's", () => {
    const lamp = defineLamp();
    for (const r of [HandlerResult.ignored("x"), HandlerResult.rejected("y"), HandlerResult.error(new Error("z"))]) {
      const carrying = r.onCommit(() => {});
      expect([carrying.kind, String(carrying)]).toEqual([r.kind, String(r)]);
    }

    const ran: string[] = [];

    // An Ignored refuses nothing, so its step commits.
    const ignoring = makeLamp(lamp, (sm) => {
      sm.addEnterHandler(lamp.on, () => HandlerResult.ignored("lit already").onCommit(() => ran.push("ignored's")));
    });
    expect(dispatch(ignoring, toggle()).kind).toBe(ResultKind.OK);
    expect(String(ignoring.lamp)).toBe("lamp.on(level=10)");
    expect(ran).toEqual(["ignored's"]);

    // The Rejected refuses its step, which drops it; the failed step commits whatever its handlers return.
    ran.length = 0;
    const failing = makeLamp(lamp, (sm) => {
      sm.addEnterHandler(lamp.on, () => HandlerResult.rejected("no bulb").onCommit(() => ran.push("refusal's")));
      sm.addEnterHandler(lamp.broken, () =>
        HandlerResult.rejected("still broken").onCommit(() => ran.push("rejected's")),
      );
      sm.addEnterHandler(lamp.broken, () =>
        HandlerResult.error(new Error("no fuse")).onCommit(() => ran.push("error's")),
      );
    });
    dispatch(failing, toggle());
    expect(String(failing.lamp)).toBe("lamp.broken(level=0)");
    expect(ran).toEqual(["rejected's", "error's"]);
  });

  /** A job: idle -> done (asynchronous) through running (temp), with failed as the failed end. */
  function defineJob() {
    const job = defineState<{ n: number }>()
      .name("job")
      .signals({ start })
      .variant("idle", { initial: true })
      .variant("running")
      .variant("done", { async: true })
      .variant("failed")
      .build();

    defineFlow(job.idle, { start: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s)) });

    return job;
  }
  type Job = ReturnType<typeof defineJob>;
  type JobTarget = { job: InstanceOf<Job> };

  /** A target of the job's flow, with the handlers `init` registers, its entries going to `entries`. */
  function makeJob(
    job: Job,
    init: (sm: StateManager, target: JobTarget) => void,
    entries: StateFlowLogEntry[] = [],
  ): JobTarget {
    const target = { job: { n: 0 } } as unknown as JobTarget;
    applyFlow(target, [job], (sm) => init(sm, target), { logHandlers: [(entry) => entries.push(entry)] });

    return target;
  }

  it("a transition's temp step runs its handlers' delegates after the temp commits; the end's commit runs the transition handlers' first, in the order of the work, an Ignored's too, then the end step's own", async () => {
    const job = defineJob();

    const seen: string[] = [];
    let finish: (result: HandlerResult) => void = () => {};
    const target = makeJob(job, (sm, t) => {
      sm.addEnterHandler(job.running, () =>
        HandlerResult.ok().onCommit(() => seen.push(`temp's sees ${String(t.job)}`)),
      );
      sm.addTransitionHandler(
        job.done,
        () =>
          new Promise<HandlerResult>((resolve) => {
            finish = resolve;
          }),
      );
      sm.addTransitionHandler(job.done, async () =>
        HandlerResult.ignored("cached").onCommit(() => seen.push("second work's")),
      );
      sm.addEnterHandler(job.done, () => HandlerResult.ok().onCommit(() => seen.push(`end's sees ${String(t.job)}`)));
    });

    const result = dispatch(target, start());

    expect(result.kind).toBe(ResultKind.InTransition);
    expect(seen).toEqual(["temp's sees job.running(n=0)"]);

    // The first work settles last; its delegate still runs first.
    finish(HandlerResult.ok().onCommit(() => seen.push(`first work's sees ${String(target.job)}`)));
    expect((await result.done()).kind).toBe(ResultKind.OK);
    expect(seen).toEqual([
      "temp's sees job.running(n=0)",
      "first work's sees job.done(n=0)",
      "second work's",
      "end's sees job.done(n=0)",
    ]);
  });

  it("an end step that a handler refuses drops its delegates and the work's; the failed end runs its own", async () => {
    const job = defineJob();

    const seen: string[] = [];
    const target = makeJob(job, (sm, t) => {
      sm.addTransitionHandler(job.done, async () => HandlerResult.ok().onCommit(() => seen.push("work's")));
      sm.addEnterHandler(job.done, () => HandlerResult.ok().onCommit(() => seen.push("end's")));
      sm.addEnterHandler(job.done, () => HandlerResult.rejected("disk full"));
      sm.addEnterHandler(job.failed, () =>
        HandlerResult.ok().onCommit(() => seen.push(`failed end's sees ${String(t.job)}`)),
      );
    });

    const outcome = await dispatch(target, start()).done();

    expect(outcome.message).toBe("disk full");
    expect(seen).toEqual(["failed end's sees job.failed(n=0)"]);
  });

  it("an end step that never runs drops the work's delegates, a refusing work's included: another work refused, or the work outlasted its timeout", async () => {
    vi.useFakeTimers();
    try {
      for (const ending of ["refused", "timeout"] as const) {
        const job = defineJob();

        const seen: string[] = [];
        const target = makeJob(job, (sm) => {
          sm.addTransitionHandler(job.done, async () => HandlerResult.ok().onCommit(() => seen.push("passing work's")));
          sm.addTransitionHandler(job.done, () =>
            ending === "refused"
              ? Promise.resolve(HandlerResult.rejected("no disk").onCommit(() => seen.push("refusing work's")))
              : new Promise<HandlerResult>(() => {}),
          );
        });

        const done = dispatch(target, start()).done();
        await vi.advanceTimersByTimeAsync(500);

        expect((await done).kind, ending).toBe(ending === "refused" ? ResultKind.Rejected : ResultKind.Error);
        expect(String(target.job), ending).toBe("job.failed(n=0)");
        expect(seen, ending).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throw from a transition handler's delegate is logged in the end's entry as a commit result named by that handler, and the end stays OK", async () => {
    const job = defineJob();

    const entries: StateFlowLogEntry[] = [];
    const target = makeJob(
      job,
      (sm) => {
        sm.addTransitionHandler(job.done, async function load() {
          return HandlerResult.ok().onCommit(() => {
            throw new Error("boom");
          });
        });
      },
      entries,
    );

    const outcome = await dispatch(target, start()).done();

    expect(outcome.kind).toBe(ResultKind.OK);
    expect(String(target.job)).toBe("job.done(n=0)");

    await tick();
    expect(entries[1]).toMatchObject({ transition: "final", finalResult: "OK" });
    expect(entries[1].handlerResults).toContainEqual({
      type: "commit",
      handlerName: "load",
      stateName: "job",
      result: "Error: boom",
    });
  });
});
