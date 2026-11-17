import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  type FlowSnapshot,
  HandlerResult,
  type InstanceOf,
  type Items,
  lock,
  ResultKind,
  type StateFlowLogEntry,
  type StateInstance,
  StateResult,
  sync,
} from "..";

/**
 * Commit handlers (`addCommitHandler`) run right after the commit, inside the dispatch, keyed like enter
 * handlers. They cannot fail the dispatch: a throw is logged as their handler result, and a returned promise is not
 * awaited, its rejection reported through console.error.
 */
describe("commit handlers", () => {
  const toggle = defineSignal("toggle");
  const dimTo = defineSignal<{ level: number }>("dimTo");
  const start = defineSignal("start");

  type LampProps = { level: number };
  type Lamp = { lamp: StateInstance<LampProps> };

  /** A fresh `lamp`: toggle switches off and on, dimTo updates `on` in place. */
  function defineLamp() {
    const lamp = defineState<LampProps>()
      .name("lamp")
      .signals({ toggle, dimTo })
      .variant("off", { initial: true })
      .variant("on")
      .build();
    defineFlow(lamp.off, { toggle: () => lamp.on({ level: 10 }) });
    defineFlow(lamp.on, { toggle: () => lamp.off({ level: 0 }), dimTo: (_s, { level }) => lamp.on({ level }) });
    return lamp;
  }

  type JobProps = { n: number };
  type Job = { job: StateInstance<JobProps> };

  /** A fresh `job` whose idle reducer declares done (next) through running (temp), with failed. */
  function defineJob() {
    const job = defineState<JobProps>()
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

  /** A promise and the function that resolves it. */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // Runs pending microtasks and the timers due now (log entries are delivered on a microtask).
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a commit handler runs after the commit (the getter shows the new state) and before send() returns", async () => {
    const lamp = defineLamp();
    const entries: StateFlowLogEntry[] = [];
    const t = { lamp: { level: 0 } } as unknown as Lamp;
    const seen: string[] = [];
    const calls: Array<{ state: unknown; snapshot: FlowSnapshot; prev: unknown; key: unknown }> = [];
    applyFlow(
      t,
      [lamp],
      (sm) => {
        sm.addEnterHandler(lamp.on, () => {
          seen.push(`enter sees ${String(t.lamp)}`);
          return HandlerResult.ok();
        });
        sm.addCommitHandler(lamp.on, function lampOnCommit(state, snapshot, prev, key) {
          seen.push(`commit sees ${String(t.lamp)}`);
          calls.push({ state, snapshot, prev, key });
        });
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );
    const before = t.lamp;

    await using send = await lock(t);
    const r = send(toggle());

    // Both ran inside send(): enter before the commit, the commit handler after it.
    expect(seen).toEqual(["enter sees lamp.off(level=0)", "commit sees lamp.on(level=10)"]);
    expect(r.kind).toBe(ResultKind.OK);
    expect(calls).toHaveLength(1);
    expect(calls[0].state).toBe(t.lamp);
    expect(calls[0].prev).toBe(before);
    expect(calls[0].key).toBeUndefined();
    expect(calls[0].snapshot.lamp).toBe(t.lamp);
    expect(Object.isFrozen(calls[0].snapshot)).toBe(true);
    await tick();
    expect(entries[0].handlerResults).toContainEqual({
      type: "commit",
      handlerName: "lampOnCommit",
      stateName: "lamp",
      result: "OK",
    });
  });

  it("it is keyed like enter: it fires on an entered variant and not on an update", () => {
    const lamp = defineLamp();
    const t = { lamp: { level: 0 } } as unknown as Lamp;
    const fired: string[] = [];
    applyFlow(t, [lamp], (sm) => {
      sm.addCommitHandler(lamp.on, (state, _snapshot, prev) => {
        fired.push(`on ${String(prev)} -> ${String(state)}`);
      });
      sm.addCommitHandler(lamp.off, (state, _snapshot, prev) => {
        fired.push(`off ${String(prev)} -> ${String(state)}`);
      });
    });

    // The initial off was never entered, so nothing fires before the first dispatch.
    expect(fired).toEqual([]);
    dispatch(t, toggle());
    dispatch(t, dimTo({ level: 5 }));
    dispatch(t, toggle());

    expect(String(t.lamp)).toBe("lamp.off(level=0)");
    expect(fired).toEqual(["on lamp.off(level=0) -> lamp.on(level=10)", "off lamp.on(level=5) -> lamp.off(level=0)"]);
  });

  it("a throw is caught, logged as type commit, and leaves the result unchanged", async () => {
    const lamp = defineLamp();
    const entries: StateFlowLogEntry[] = [];
    const t = { lamp: { level: 0 } } as unknown as Lamp;
    const later: string[] = [];
    applyFlow(
      t,
      [lamp],
      (sm) => {
        sm.addCommitHandler(lamp.on, function explode() {
          throw new Error("boom");
        });
        sm.addCommitHandler(lamp.on, function afterExplode() {
          later.push("ran");
        });
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );

    const r = dispatch(t, toggle());

    expect(r.kind).toBe(ResultKind.OK);
    expect(String(t.lamp)).toBe("lamp.on(level=10)");
    expect(later).toEqual(["ran"]);
    await tick();
    expect(entries).toHaveLength(1);
    expect(entries[0].finalResult).toBe("OK");
    expect(entries[0].handlerResults).toContainEqual({
      type: "commit",
      handlerName: "explode",
      stateName: "lamp",
      result: "Error: boom",
    });
    expect(entries[0].handlerResults).toContainEqual({
      type: "commit",
      handlerName: "afterExplode",
      stateName: "lamp",
      result: "OK",
    });
  });

  it("an async commit handler that rejects is reported through console.error and raises no unhandled rejection; the commit and the result stand", async () => {
    const lamp = defineLamp();
    const t = { lamp: { level: 0 } } as unknown as Lamp;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const late = new Error("late failure");
    try {
      applyFlow(t, [lamp], (sm) => {
        sm.addCommitHandler(lamp.on, async function announce() {
          throw late;
        });
      });

      const r = dispatch(t, toggle());

      expect(r.kind).toBe(ResultKind.OK);
      expect(String(t.lamp)).toBe("lamp.on(level=10)");
      // Node reports an unhandled rejection after the microtasks of the turn that left it unhandled.
      await tick();
      await tick();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[SF/Object] commit handler announce on lamp.on rejected:", late);
  });

  it("it fires for temp's commit before the work starts, and for next's commit", async () => {
    const job = defineJob();
    const t = { job: { n: 0 } } as unknown as Job;
    const order: string[] = [];
    const work = deferred<HandlerResult>();
    applyFlow(t, [job], (sm) => {
      sm.addCommitHandler(job.running, () => {
        order.push(`commit running, getter ${String(t.job)}`);
      });
      sm.addTransitionHandler(job.done, () => {
        order.push("work starts");
        return work.promise;
      });
      sm.addCommitHandler(job.done, (state, _snapshot, prev) => {
        order.push(`commit done, prev ${String(prev)}, getter ${String(t.job)}`);
      });
    });

    const r = dispatch(t, start());

    expect(r.kind).toBe(ResultKind.InTransition);
    expect(order).toEqual(["commit running, getter job.running(n=0)", "work starts"]);
    work.resolve(HandlerResult.ok());
    const outcome = await r.done();
    expect(outcome.kind).toBe(ResultKind.OK);
    expect(order).toEqual([
      "commit running, getter job.running(n=0)",
      "work starts",
      "commit done, prev job.running(n=0), getter job.done(n=0)",
    ]);
  });

  it("it fires for entered nested states with their key (undefined for a single nested state), after the parent's", () => {
    const member = defineState<{ name: string }>()
      .name("member")
      .variant("waiting", { initial: true })
      .variant("active")
      .build();
    type Member = InstanceOf<typeof member>;
    const set = defineSignal<{ members: Items<typeof member>; host?: Member }>("set");
    const room = defineState<{ members?: Items<typeof member>; host?: Member }>()
      .name("room")
      .signals({ set })
      .variant("closed", { initial: true })
      .variant("open")
      .stringRepr((r) => [...(r.members?.keys() ?? [])].join(","))
      .build();
    defineFlow(room.closed, { set: (_s, { members, host }) => room.open({ members, host }) });
    defineFlow(room.open, { set: (_s, { members, host }) => room.open({ members, host }) });
    const t = { room: {} } as unknown as { room: StateInstance<{ members?: Items<typeof member> }> };
    const fired: Array<{ label: string; state: string; prev: string; key: unknown }> = [];
    const record =
      (label: string) =>
      (state: unknown, _snapshot: FlowSnapshot, prev: unknown, key: unknown): void => {
        fired.push({ label, state: String(state), prev: String(prev), key });
      };
    applyFlow(t, [room], (sm) => {
      sm.addCommitHandler(room.open, record("room"));
      sm.addCommitHandler(member.waiting, record("member"));
      sm.addCommitHandler(member.active, record("member"));
    });
    const a = member.waiting({ name: "ann" });
    const host = member.active({ name: "hal" });

    dispatch(
      t,
      set({
        members: member
          .items()
          .with("a", a)
          .with("b", member.active({ name: "bob" })),
        host,
      }),
    );
    // a changes variant (a commit with the old member as prev); b gets a new instance of the same variant, which
    // is an update and fires nothing, and the host is the same instance.
    dispatch(
      t,
      set({
        members: member
          .items()
          .with("a", member.active(a))
          .with("b", member.active({ name: "bea" })),
        host,
      }),
    );

    expect(fired).toEqual([
      { label: "room", state: "room.open(a,b)", prev: "room.closed()", key: undefined },
      { label: "member", state: "member.waiting(name=ann)", prev: "undefined", key: "a" },
      { label: "member", state: "member.active(name=bob)", prev: "undefined", key: "b" },
      { label: "member", state: "member.active(name=hal)", prev: "undefined", key: undefined },
      { label: "member", state: "member.active(name=ann)", prev: "member.waiting(name=ann)", key: "a" },
    ]);
  });

  it("a temp commit handler that calls sync(), or lock() on a free lock, resolves after the end, both for an end inside send() and for an async end; nothing hangs", async () => {
    // End inside send(): done has no transition handler, so next commits before dispatch() returns.
    const job1 = defineJob();
    const t1 = { job: { n: 0 } } as unknown as Job;
    const order1: string[] = [];
    let synced1: Promise<void> | null = null;
    let locked1: Promise<unknown> | null = null;
    applyFlow(t1, [job1], (sm) => {
      sm.addCommitHandler(job1.running, () => {
        synced1 = sync(t1).then(() => {
          order1.push(`sync resolved at ${String(t1.job)}`);
        });
        locked1 = lock(t1).then(async (send) => {
          order1.push(`lock resolved at ${String(t1.job)}`);
          await send[Symbol.asyncDispose]();
        });
      });
    });

    const r1 = dispatch(t1, start());

    expect(r1.kind).toBe(ResultKind.OK);
    expect(String(t1.job)).toBe("job.done(n=0)");
    await Promise.all([synced1, locked1]);
    expect(order1).toEqual(["sync resolved at job.done(n=0)", "lock resolved at job.done(n=0)"]);

    // Async end: the work's promise settles later.
    const job2 = defineJob();
    const t2 = { job: { n: 0 } } as unknown as Job;
    const order2: string[] = [];
    const work = deferred<HandlerResult>();
    let synced2: Promise<void> | null = null;
    let locked2: Promise<unknown> | null = null;
    applyFlow(t2, [job2], (sm) => {
      sm.addCommitHandler(job2.running, () => {
        synced2 = sync(t2).then(() => {
          order2.push(`sync resolved at ${String(t2.job)}`);
        });
        locked2 = lock(t2).then(async (send) => {
          order2.push(`lock resolved at ${String(t2.job)}`);
          await send[Symbol.asyncDispose]();
        });
      });
      sm.addTransitionHandler(job2.done, () => work.promise);
    });

    const r2 = dispatch(t2, start());

    expect(r2.kind).toBe(ResultKind.InTransition);
    await tick();
    expect(order2).toEqual([]);
    work.resolve(HandlerResult.ok());
    await r2.done();
    await Promise.all([synced2, locked2]);
    expect(order2).toEqual(["sync resolved at job.done(n=0)", "lock resolved at job.done(n=0)"]);
  });

  it("a commit handler that calls disposeFlow on its own target logs the StateFlowError as its handler result; the step completes and the work still starts", async () => {
    const job = defineJob();
    const entries: StateFlowLogEntry[] = [];
    const t = { job: { n: 0 } } as unknown as Job;
    const order: string[] = [];
    applyFlow(
      t,
      [job],
      (sm) => {
        sm.addCommitHandler(job.running, function disposeEarly() {
          disposeFlow(t);
        });
        sm.addTransitionHandler(job.done, async () => {
          order.push("work starts");
          return HandlerResult.ok();
        });
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );

    const r = dispatch(t, start());

    expect(r.kind).toBe(ResultKind.InTransition);
    expect(order).toEqual(["work starts"]);
    expect((await r.done()).kind).toBe(ResultKind.OK);
    expect(String(t.job)).toBe("job.done(n=0)");
    await tick();
    const temp = entries.find((entry) => entry.transition === "temp");
    expect(temp?.handlerResults).toContainEqual({
      type: "commit",
      handlerName: "disposeEarly",
      stateName: "job",
      result:
        "StateFlowError: Cannot dispose Object from inside its own dispatch [SF043] Dispose after the dispatch returns.",
    });
  });

  it("a temp commit handler that throws an Error whose string form throws is logged, and the transition still ends", async () => {
    class ToStringThrows extends Error {
      override toString(): string {
        throw new Error("no string form");
      }
    }
    // Error.prototype.toString reads message, so a throwing message getter breaks the string form too.
    const messageThrows = (): Error =>
      Object.defineProperty(new Error(), "message", {
        get() {
          throw new Error("no message");
        },
      });
    for (const [name, error] of [
      ["toString throws", () => new ToStringThrows("boom")],
      ["message getter throws", messageThrows],
    ] as const) {
      const job = defineJob();
      const entries: StateFlowLogEntry[] = [];
      const t = { job: { n: 0 } } as unknown as Job;
      applyFlow(
        t,
        [job],
        (sm) => {
          sm.addCommitHandler(job.running, function explode() {
            throw error();
          });
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );

      const r = dispatch(t, start());

      expect(r.kind, name).toBe(ResultKind.OK);
      expect(String(t.job), name).toBe("job.done(n=0)");
      await sync(t);
      await tick();
      const temp = entries.find((entry) => entry.transition === "temp");
      expect(temp?.handlerResults, name).toContainEqual({
        type: "commit",
        handlerName: "explode",
        stateName: "job",
        result: "Error: a thrown value with no string form",
      });
    }
  });
});
