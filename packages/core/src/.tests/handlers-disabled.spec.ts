import { afterEach, describe, expect, it } from "vitest";

import {
  applyFlow,
  Box,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  type FlowChange,
  HandlerResult,
  type InstanceOf,
  type Items,
  lock,
  mockHandlers,
  observe,
  ResultKind,
  type StateFlowLogEntry,
  type StateInstance,
  StateResult,
  setHandlersDisabled,
  stateVar,
  subscribeFlow,
} from "..";

/**
 * The handlers-off switch (`setHandlersDisabled`): read at every handler call, on every target, so while it is on
 * no handler of any kind runs and a run shows what the flow commits without touching the world; registrations
 * are kept, and run again once it is off. A declared transition has no work while it is on and commits its next
 * inside the send that declared it.
 */
describe("handlers-off switch", () => {
  const toggle = defineSignal("toggle");
  const dimTo = defineSignal<{ level: number }>("dimTo");
  const start = defineSignal("start");

  type LampProps = { level: number };
  type Lamp = { lamp: StateInstance<LampProps> };

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

  // Delivers the log entries (a microtask), observer calls and FlowChanges (each a 0 ms timer).
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    setHandlersDisabled(false);
  });

  /** A lamp target whose enter, exit, update and commit handlers on both variants record "<label> <kind>". */
  function makeLamp(lamp: ReturnType<typeof defineLamp>, label: string, calls: string[], entries: StateFlowLogEntry[]) {
    const t = { lamp: { level: 0 } } as unknown as Lamp;
    applyFlow(
      t,
      [lamp],
      (sm) => {
        for (const variant of [lamp.off, lamp.on]) {
          sm.addEnterHandler(variant, () => {
            calls.push(`${label} enter`);
            return HandlerResult.ok();
          });
          sm.addExitHandler(variant, () => {
            calls.push(`${label} exit`);
            return HandlerResult.ok();
          });
          sm.addUpdateHandler(variant, () => {
            calls.push(`${label} update`);
            return HandlerResult.ok();
          });
          sm.addCommitHandler(variant, () => {
            calls.push(`${label} commit`);
          });
        }
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );
    return t;
  }

  it("while the switch is on, no enter, exit, update or commit handler runs; the initializer runs and registers them", async () => {
    const lamp = defineLamp();
    const entries: StateFlowLogEntry[] = [];
    const calls: string[] = [];

    setHandlersDisabled(true);
    const t = makeLamp(lamp, "lamp", calls, entries);
    const results = [dispatch(t, toggle()), dispatch(t, dimTo({ level: 3 })), dispatch(t, toggle())];

    expect(results.map((r) => r.kind)).toEqual([ResultKind.OK, ResultKind.OK, ResultKind.OK]);
    expect(String(t.lamp)).toBe("lamp.off(level=0)");
    expect(calls).toEqual([]);
    await tick();
    expect(entries.map((entry) => entry.handlerResults)).toEqual([[], [], []]);

    // The registrations were kept: with the switch off they run.
    setHandlersDisabled(false);
    dispatch(t, toggle());

    expect(calls).toEqual(["lamp exit", "lamp enter", "lamp commit"]);
  });

  it("the switch is read at each call: it acts on a target set up before it changed, either way", () => {
    const lamp = defineLamp();
    const calls: string[] = [];
    const handled = makeLamp(lamp, "handled", calls, []);
    setHandlersDisabled(true);
    const silent = makeLamp(lamp, "silent", calls, []);

    dispatch(handled, toggle());
    dispatch(silent, toggle());
    expect(calls).toEqual([]);

    setHandlersDisabled(false);
    dispatch(handled, dimTo({ level: 5 }));
    dispatch(silent, dimTo({ level: 5 }));

    expect(calls).toEqual(["handled update", "silent update"]);
    expect([String(handled.lamp), String(silent.lamp)]).toEqual(["lamp.on(level=5)", "lamp.on(level=5)"]);
  });

  it("a declared transition has no work while it is on: temp, then next, commit inside send(), with the props the world would fill at their defaults", async () => {
    const reset = defineSignal("reset");
    const job = defineState<{ n: number; manifest: string | null }>()
      .name("job")
      .signals({ start, reset })
      .variant("idle", { initial: true })
      .variant("running")
      .variant("done", { async: true, results: { loaded: (data) => String(data) } })
      .variant("failed")
      .build();
    defineFlow(job.idle, {
      start: (s) =>
        StateResult.transition(job.done({ ...s, n: s.n + 1 }), job.running(s), job.failed(s), { timeoutMs: 1000 }),
    });
    defineFlow(job.done, {}, { loaded: (s, manifest) => ({ ...s, manifest }) });
    // An abort reducer of the temporary variant; under the switch nothing can reach it.
    defineFlow(job.running, { reset: () => job.idle({ n: 0, manifest: null }) });
    const entries: StateFlowLogEntry[] = [];
    const changes: string[] = [];
    const works: string[] = [];
    const t = { job: { n: 0, manifest: null } } as unknown as {
      job: StateInstance<{ n: number; manifest: string | null }>;
    };

    setHandlersDisabled(true);
    applyFlow(
      t,
      [job],
      (sm) => {
        // Would fill the manifest; with handlers on, this transition could only time out.
        sm.addTransitionHandler(job.done, () => {
          works.push("work");
          return new Promise(() => {});
        });
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );
    using _sub = subscribeFlow(t, (change: FlowChange) => {
      changes.push(`${change.prevVariant} -> ${change.nextVariant}`);
    });

    await using send = await lock(t);
    const r = send(start());

    expect(r.kind).toBe(ResultKind.OK);
    expect(String(t.job)).toBe("job.done(n=1 manifest=N)");
    expect(works).toEqual([]);
    expect((await r.done()).kind).toBe(ResultKind.OK);
    await tick();
    expect(entries.map((entry) => [entry.transition, entry.finalResult])).toEqual([
      ["temp", "InTransition"],
      ["final", "OK"],
    ]);
    expect(changes).toEqual(["idle -> running", "running -> done"]);
  });

  it("the switch is read at each call by transition handlers too: a target set up before it changed runs its work, or none", async () => {
    const job = defineState<{ n: number }>()
      .name("job")
      .signals({ start })
      .variant("idle", { initial: true })
      .variant("running")
      .variant("done", { async: true })
      .variant("failed")
      .build();
    defineFlow(job.idle, {
      start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s)),
    });
    defineFlow(job.done, {
      start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s)),
    });
    const works: number[] = [];
    const t = { job: { n: 0 } } as unknown as { job: StateInstance<{ n: number }> };
    applyFlow(t, [job], (sm) =>
      sm.addTransitionHandler(job.done, async (next) => {
        works.push(next.n);
        return HandlerResult.ok();
      }),
    );

    setHandlersDisabled(true);
    expect(dispatch(t, start()).kind).toBe(ResultKind.OK);
    setHandlersDisabled(false);
    expect((await dispatch(t, start()).done()).kind).toBe(ResultKind.OK);

    expect(works).toEqual([2]);
    expect(String(t.job)).toBe("job.done(n=2)");
  });

  it("whether an entry is asynchronous is the variant's mark, which the switch does not change: an ok answer into an asynchronous variant is an Error with the switch on, and a transition into it commits at once", () => {
    const go = defineSignal("go");
    const job = defineState<{ n: number }>()
      .name("job")
      .signals({ start, go })
      .variant("idle", { initial: true })
      .variant("done", { async: true })
      .variant("failed")
      .build();
    defineFlow(job.idle, {
      go: (s) => job.done(s),
      start: (s, _signal, ctx) => StateResult.transition(job.done(s), job(ctx), job.failed(s)),
    });
    const t = { job: { n: 0 } } as unknown as { job: StateInstance<{ n: number }> };
    applyFlow(t, [job], () => {});
    setHandlersDisabled(true);

    const ok = dispatch(t, go());

    expect(ok.kind).toBe(ResultKind.Error);
    expect(ok.error?.message).toBe(
      "job enters job.done, whose entry is asynchronous; declare a transition [SF024] Return StateResult.transition(next, temp, failed) to enter it.",
    );
    expect(dispatch(t, start()).kind).toBe(ResultKind.OK);
    expect(String(t.job)).toBe("job.done(n=0)");
  });

  it("reducers, the diffs of nested states, commits, observers, subscribeFlow and the log still run", async () => {
    const flip = defineSignal("flip");
    const member = defineState<{ name: string }>().name("member").variant("waiting", { initial: true }).build();
    type Members = Items<typeof member>;
    const set = defineSignal<{ members: Members }>("set");
    const power = defineState<{ watts: number }>()
      .name("power")
      .signals({ flip, set })
      .variant("off", { initial: true })
      .variant("on")
      .build();
    defineFlow(power.off, { flip: () => power.on({ watts: 60 }) });
    const room = defineState<{ members?: Members }>()
      .name("room")
      .signals({ flip, set })
      .variant("closed", { initial: true })
      .variant("open")
      .build();
    // The room opens only with power, as committed before the signal.
    defineFlow(room.closed, {
      set: (_s, { members }, ctx) =>
        stateVar(power(ctx)) === power.on
          ? room.open({ members })
          : StateResult.rejected("the room opens only with power"),
    });
    const entries: StateFlowLogEntry[] = [];
    const calls: string[] = [];
    const observed: string[] = [];
    const changes: string[] = [];
    const t = { power: { watts: 0 }, room: {} } as unknown as {
      power: StateInstance<{ watts: number }>;
      room: StateInstance<{ members?: Members }>;
    };

    setHandlersDisabled(true);
    applyFlow(
      t,
      [power, room],
      (sm) => {
        sm.addEnterHandler(member.waiting, () => {
          calls.push("member enter");
          return HandlerResult.ok();
        });
        sm.addEnterHandler(room.open, () => {
          calls.push("room enter");
          return HandlerResult.ok();
        });
        sm.addCommitHandler(power.on, () => {
          calls.push("power commit");
        });
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );
    using _observer = observe(t, [power.on], (state) => {
      observed.push(String(state));
    });
    using _sub = subscribeFlow(t, (change) => {
      changes.push(`${change.stateName} ${change.prevVariant} -> ${change.nextVariant}`);
    });
    const members = member.items().with("a", member.waiting({ name: "ann" }));

    const refused = dispatch(t, set({ members }));
    const flipped = dispatch(t, flip());
    const opened = dispatch(t, set({ members }));

    expect(refused.kind).toBe(ResultKind.Rejected);
    expect(refused.message).toBe("the room opens only with power");
    expect(flipped.kind).toBe(ResultKind.OK);
    expect(opened.kind).toBe(ResultKind.OK);
    expect(String(t.power)).toBe("power.on(watts=60)");
    expect(stateVar(t.room)).toBe(room.open);
    expect(t.room.members?.get("a")).toBe(members.get("a") as InstanceOf<typeof member>);
    expect(calls).toEqual([]);
    await tick();
    expect(observed).toEqual(["power.on(watts=60)"]);
    expect(changes).toEqual(["power off -> on", "room closed -> open", "member (none) -> waiting"]);
    expect(entries).toHaveLength(3);
    expect(entries[1].observers).toHaveLength(1);
    expect(entries[2].stateChanges).toContainEqual({
      stateName: "room.members[a]",
      oldState: "(none)",
      newState: "member.waiting(name=ann)",
    });
  });

  it("a mock still runs under the switch: its refusal takes the reducer's failed, which commits with FAILURE folded in while the registered handlers stay off", () => {
    const lamp = defineState<LampProps>()
      .name("lamp")
      .signals({ toggle })
      .variant("off", { initial: true })
      .variant("on")
      .variant("broken")
      .build();
    defineFlow(lamp.off, { toggle: () => StateResult.ok(lamp.on({ level: 10 }), lamp.broken({ level: 0 })) });
    // Reducers run under the switch: the length of the refusal's reason becomes the level.
    defineFlow(lamp.broken, {}, { [FAILURE]: (_s, { reason }) => ({ level: reason?.length ?? -1 }) });
    const calls: string[] = [];
    const t = { lamp: { level: 0 } } as unknown as Lamp;
    applyFlow(t, [lamp], (sm) => {
      sm.addEnterHandler(lamp.broken, () => {
        calls.push("broken enter");
        return HandlerResult.rejected("never runs");
      });
    });
    setHandlersDisabled(true);
    using _mocks = mockHandlers(lamp.on, { enter: () => HandlerResult.rejected("no power") });

    const result = dispatch(t, toggle());

    expect(String(result)).toBe("Rejected: no power");
    expect(String(t.lamp)).toBe("lamp.broken(level=8)");
    expect(calls).toEqual([]);
  });

  it("Box.deref works under the switch", () => {
    type Stream = { id: string };
    const attach = defineSignal<{ stream: Box<Stream> }>("attach");
    const peek = defineSignal("peek");
    const cam = defineState<{ stream: Box<Stream> | null }>()
      .name("cam")
      .signals({ attach, peek })
      .variant("off", { initial: true })
      .variant("on")
      .build();
    defineFlow(cam.off, { attach: (_s, { stream }) => cam.on({ stream }) });
    // A reducer may place a Box but not read it, with the switch on as without it.
    defineFlow(cam.on, { peek: (s) => cam.on({ stream: Box.of({ id: `${s.stream?.deref().id} copy` }) }) });
    const standIn: Stream = { id: "stand-in" };
    const box = Box.of(standIn);
    const t = { cam: { stream: null } } as unknown as { cam: StateInstance<{ stream: Box<Stream> | null }> };

    setHandlersDisabled(true);
    applyFlow(t, [cam], () => {});

    expect(box.deref()).toBe(standIn);
    expect(dispatch(t, attach({ stream: box })).kind).toBe(ResultKind.OK);
    expect(t.cam.stream?.deref()).toBe(standIn);
    const peeked = dispatch(t, peek());
    expect(peeked.kind).toBe(ResultKind.Error);
    expect(peeked.error?.message).toContain("Cannot deref a Box inside a reducer");
  });
});
