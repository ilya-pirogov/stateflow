import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  FAILURE,
  HandlerResult,
  type InstanceOf,
  type Items,
  lock,
  observe,
  ResultKind,
  type StateFlowLogEntry,
  type StateInstance,
  type StateManager,
  StateResult,
  type StateVariant,
  stateVar,
  VARIANT,
} from "..";

/**
 * The failed path: `StateResult.ok(next, failed?)`. When a handler refuses the step, every answer with a failed
 * goes there, and an answer without one stays as it was. When no answer has a failed, nothing commits. Otherwise
 * the failed step runs, the diff from the snapshot the reducers ran on: it exits every node it leaves, so it exits
 * again a node the refused step exited when it leaves the same instance, gives a node it holds as the same instance no
 * call, also one the refused step exited, folds the FAILURE result, the refusal's reason, into every node it enters or
 * updates whose variant has a reducer for it, and is a floor: its handlers' refusals do not stop its commit and become
 * an Error of the result. Every definition with reducers is made inside its test, because defineFlow binds once per
 * variant.
 */
describe("failed", () => {
  const push = defineSignal("push");

  // Log entries are delivered after the dispatch returns.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  type DoorProps = { n: number; reason?: string };

  /** A door: closed (initial), open and jammed; its reducers are left to the test. */
  const defineDoor = () =>
    defineState<DoorProps>()
      .name("door")
      .signals({ push })
      .variant("closed", { initial: true })
      .variant("open")
      .variant("jammed")
      .build();
  type Door = ReturnType<typeof defineDoor>;
  type DoorTarget = { door: InstanceOf<Door> };

  /**
   * A door target whose enter, exit and update handlers on every variant record "<kind> <instance>" (an enter
   * also its prev) and return what `refusals` gives for that record, OK otherwise; commit handlers record too.
   */
  function makeDoor(
    door: Door,
    calls: string[],
    refusals: Record<string, () => HandlerResult> = {},
    entries: StateFlowLogEntry[] = [],
  ): DoorTarget {
    const target = { door: { n: 0 } };
    applyFlow(target, [door], (sm) => record(sm, [door.closed, door.open, door.jammed], calls, refusals), {
      logHandlers: [(entry) => entries.push(entry)],
    });
    return target as unknown as DoorTarget;
  }

  function record(
    sm: StateManager,
    variants: ReadonlyArray<Door["closed" | "open" | "jammed"]>,
    calls: string[],
    refusals: Record<string, () => HandlerResult>,
  ): void {
    const answer = (label: string): HandlerResult => {
      calls.push(label);
      return refusals[label]?.() ?? HandlerResult.ok();
    };
    for (const variant of variants) {
      sm.addExitHandler(variant, (state) => answer(`exit ${String(state)}`));
      sm.addUpdateHandler(variant, (state, _snapshot, prev) => answer(`update ${String(state)} from ${String(prev)}`));
      sm.addEnterHandler(variant, (state, _snapshot, prev) => answer(`enter ${String(state)} from ${String(prev)}`));
      sm.addCommitHandler(variant, (state) => {
        calls.push(`commit ${String(state)}`);
      });
    }
  }

  describe("ok(next, failed)", () => {
    it("handlers pass: next commits, and failed does not, so no FAILURE folds", () => {
      const door = defineDoor();
      const failure = vi.fn((s: DoorProps) => s);
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed(s)) });
      defineFlow(door.jammed, {}, { [FAILURE]: failure });
      const calls: string[] = [];
      const target = makeDoor(door, calls);

      const result = dispatch(target, push());

      expect(result.kind).toBe(ResultKind.OK);
      expect(String(target.door)).toBe("door.open(n=1)");
      expect(failure).not.toHaveBeenCalled();
      expect(calls).toEqual([
        "exit door.closed(n=0)",
        "enter door.open(n=1) from door.closed(n=0)",
        "commit door.open(n=1)",
      ]);
    });

    it("refused without failed: nothing commits, and the result is the merged refusal", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 })) });
      const calls: string[] = [];
      const target = { door: { n: 0 } };
      applyFlow(target, [door], (sm) => {
        sm.addExitHandler(door.closed, () => {
          calls.push("exit first");
          return HandlerResult.rejected("first");
        });
        sm.addExitHandler(door.closed, () => {
          calls.push("exit second");
          return HandlerResult.error(new Error("second"));
        });
        sm.addEnterHandler(door.open, () => {
          calls.push("enter door.open");
          return HandlerResult.ok();
        });
      });
      const before = target.door;

      const result = dispatch(target, push());

      // Both exit handlers ran and their refusals merged, the Error over the Rejected; the enter phase did not run.
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe("second");
      expect(target.door).toBe(before);
      expect(calls).toEqual(["exit first", "exit second"]);
    });

    it("refused with failed: failed commits and the result is the merged refusal; the failed step leaves the instance the refused step left, so it exits it again, then enters failed", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed({ n: 7 })) });
      const calls: string[] = [];
      const target = makeDoor(door, calls, {
        "enter door.open(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck"),
      });

      const result = dispatch(target, push());

      expect(String(result)).toBe("Rejected: stuck");
      expect(String(target.door)).toBe("door.jammed(n=7)");
      expect(calls).toEqual([
        "exit door.closed(n=0)",
        "enter door.open(n=1) from door.closed(n=0)",
        "exit door.closed(n=0)",
        "enter door.jammed(n=7) from door.closed(n=0)",
        "commit door.jammed(n=7)",
      ]);
    });

    it("a failed of the variant the refused step exited is an update of the instance before the signal, which leaves no variant, so the exit does not run again; after a refused update it is an update too", () => {
      const door = defineDoor();
      defineFlow(door.closed, {
        push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.closed({ n: 5 })),
      });
      const calls: string[] = [];
      const target = makeDoor(door, calls, {
        "enter door.open(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck"),
      });

      dispatch(target, push());

      expect(String(target.door)).toBe("door.closed(n=5)");
      // The diff from the snapshot the reducer ran on: closed to closed is an update; what the exit did stays done.
      expect(calls).toEqual([
        "exit door.closed(n=0)",
        "enter door.open(n=1) from door.closed(n=0)",
        "update door.closed(n=5) from door.closed(n=0)",
      ]);

      const shut = defineDoor();
      defineFlow(shut.closed, { push: (s) => StateResult.ok(shut.closed({ n: s.n + 1 }), shut.closed({ n: 5 })) });
      const shutCalls: string[] = [];
      const shutTarget = makeDoor(shut, shutCalls, {
        "update door.closed(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck"),
      });

      dispatch(shutTarget, push());

      expect(shutCalls).toEqual([
        "update door.closed(n=1) from door.closed(n=0)",
        "update door.closed(n=5) from door.closed(n=0)",
      ]);
    });

    it("a failed that is the node's own instance before the signal gets no call after the refused step ran its exit: the exit stays done, and the node keeps that instance", async () => {
      const door = defineDoor();
      defineFlow(door.closed, {
        // The reducer's state is typed as its props, so the instance comes from ctx; the definition's call types it as
        // its variants' calls do, so ok() takes it as failed.
        push: (s, _signal, ctx) => StateResult.ok(door.open({ n: s.n + 1 }), door(ctx)),
      });
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = makeDoor(
        door,
        calls,
        { "enter door.open(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck") },
        entries,
      );
      const before = target.door;

      const result = dispatch(target, push());
      await tick();

      expect(String(result)).toBe("Rejected: stuck");
      expect(target.door).toBe(before);
      expect(calls).toEqual(["exit door.closed(n=0)", "enter door.open(n=1) from door.closed(n=0)"]);
      // The failed step changes nothing, so the entry holds the attempt alone.
      expect(entries).toHaveLength(1);
      expect(entries[0].stateChanges).toEqual([
        { stateName: "door", oldState: "door.closed(n=0)", newState: "door.open(n=1)" },
      ]);
      expect(entries[0].finalStates).toEqual({ door: "door.closed(n=0)" });
    });

    it("every state with failed goes there, exited again where the failed step leaves the instance the refused step left, and one without stays as it was with no call, though the refused step exited it", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed(s)) });
      const gate = defineState<{ n: number }>()
        .name("gate")
        .signals({ push })
        .variant("down", { initial: true })
        .variant("up")
        .build();
      defineFlow(gate.down, { push: (s) => gate.up(s) });
      const calls: string[] = [];
      const target = { door: { n: 0 }, gate: { n: 0 } };
      applyFlow(target, [door, gate], (sm) => {
        record(sm, [door.closed, door.open, door.jammed], calls, {});
        sm.addExitHandler(gate.down, () => {
          calls.push("exit gate.down");
          return HandlerResult.ok();
        });
        sm.addEnterHandler(gate.up, () => {
          calls.push("enter gate.up");
          return HandlerResult.rejected("gate stuck");
        });
        sm.addEnterHandler(gate.down, () => {
          calls.push("enter gate.down");
          return HandlerResult.ok();
        });
      });
      const gateBefore = target.gate;

      const result = dispatch(target, push());

      expect(String(result)).toBe("Rejected: gate stuck");
      expect(String(target.door)).toBe("door.jammed(n=0)");
      expect(target.gate).toBe(gateBefore);
      expect(calls).toEqual([
        "exit door.closed(n=0)",
        "exit gate.down",
        "enter door.open(n=1) from door.closed(n=0)",
        "enter gate.up",
        "exit door.closed(n=0)",
        "enter door.jammed(n=0) from door.closed(n=0)",
        "commit door.jammed(n=0)",
      ]);
    });

    it("a refused step and its failed step write one entry: the attempt's changes and handler results, then the failed step's", async () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed(s)) });
      const entries: StateFlowLogEntry[] = [];
      const target = makeDoor(
        door,
        [],
        { "enter door.open(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck") },
        entries,
      );

      dispatch(target, push());
      await tick();

      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry.finalResult).toBe("Rejected: stuck");
      expect(entry.finalStates).toEqual({ door: "door.jammed(n=0)" });
      expect(entry.stateChanges).toEqual([
        { stateName: "door", oldState: "door.closed(n=0)", newState: "door.open(n=1)" },
        { stateName: "door", oldState: "door.closed(n=0)", newState: "door.jammed(n=0)" },
      ]);
      expect(entry.handlerResults.map((line) => [line.type, line.result])).toEqual([
        ["exit", "OK"],
        ["enter", "Rejected: stuck"],
        ["exit", "OK"],
        ["enter", "OK"],
        ["commit", "OK"],
      ]);
    });
  });

  describe("an ancestor without failed", () => {
    /** A panel holding one lamp; panel.idle -> panel.busy and lamp.off -> lamp.on both answer push. */
    function definePanel(lampFailed: boolean) {
      const lamp = defineState<{ watts: number }>()
        .name("lamp")
        .signals({ push })
        .variant("off", { initial: true })
        .variant("on")
        .variant("broken")
        .build();
      defineFlow(lamp.off, {
        push: (l) => (lampFailed ? StateResult.ok(lamp.on(l), lamp.broken(l)) : lamp.on(l)),
      });
      const panel = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("panel")
        .signals({ push })
        .variant("idle", { initial: true })
        .variant("busy")
        .build();
      defineFlow(panel.idle, { push: (p) => panel.busy(p) });
      return { lamp, panel };
    }

    it("exited by the refused step, it stays as it was with no call from the failed step, whether or not a child's failed rebuilt it; a child that its failed replaces is exited again", () => {
      for (const lampFailed of [true, false]) {
        const { lamp, panel } = definePanel(lampFailed);
        // A second state with failed, so a failed step runs when the lamp declares none.
        const door = defineDoor();
        defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
        const calls: string[] = [];
        const target = { panel: { lamp: lamp.off({ watts: 1 }) }, door: { n: 0 } };
        applyFlow(target, [panel, door], (sm) => {
          for (const variant of [panel.idle, panel.busy, lamp.off, lamp.on, lamp.broken]) {
            sm.addExitHandler(variant, (state) => {
              calls.push(`exit ${String(state[VARIANT])}`);
              return HandlerResult.ok();
            });
            sm.addEnterHandler(variant, (state) => {
              calls.push(`enter ${String(state[VARIANT])}`);
              return state[VARIANT] === lamp.on ? HandlerResult.rejected("no power") : HandlerResult.ok();
            });
            sm.addUpdateHandler(variant, (state) => {
              calls.push(`update ${String(state[VARIANT])}`);
              return HandlerResult.ok();
            });
          }
          record(sm, [door.jammed], calls, {});
        });
        const panelBefore = target.panel;

        const result = dispatch(target, push());

        expect(String(result), String(lampFailed)).toBe("Rejected: no power");
        expect(stateVar(target.panel), String(lampFailed)).toBe(panel.idle);
        expect(String(target.door), String(lampFailed)).toBe("door.jammed(n=0)");
        const failedStep = calls.slice(calls.indexOf("enter lamp.on") + 1);
        // The refused step exited the panel and its lamp; what those exits did stays done.
        expect(calls.slice(0, 2), String(lampFailed)).toEqual(["exit lamp.off", "exit panel.idle"]);
        if (lampFailed) {
          // The engine rebuilt the panel around the lamp's failed: no call for the panel. The failed step leaves the
          // lamp the refused step left, so it exits it again.
          expect(String(target.panel.lamp)).toBe("lamp.broken(watts=1)");
          expect(failedStep).toEqual([
            "exit lamp.off",
            "enter lamp.broken",
            "enter door.jammed(n=0) from door.closed(n=0)",
            "commit door.jammed(n=0)",
          ]);
        } else {
          expect(target.panel).toBe(panelBefore);
          expect(failedStep).toEqual(["enter door.jammed(n=0) from door.closed(n=0)", "commit door.jammed(n=0)"]);
        }
      }
    });
  });

  describe("what the refused step exited", () => {
    it("a child that a parent's next removed, and whose parent's failed brings it back as the same instance, gets no call: its exit stays done; the parent's failed is an update; at the top level and nested", () => {
      for (const nested of [false, true]) {
        const lamp = defineState<{ watts: number }>().name("lamp").variant("off", { initial: true }).build();
        const slot = defineState<{ n: number; lamp?: InstanceOf<typeof lamp> }>()
          .name("slot")
          .signals({ push })
          .variant("idle", { initial: true })
          .build();
        // next drops the lamp; failed holds the very lamp the reducer ran on.
        defineFlow(slot.idle, { push: (s) => StateResult.ok(slot.idle({ n: s.n + 1 }), slot.idle({ ...s, n: 9 })) });
        const root = defineState<{ slot: InstanceOf<typeof slot> }>()
          .name("root")
          .variant("x", { initial: true })
          .build();
        const gate = defineState<{ n: number }>()
          .name("gate")
          .signals({ push })
          .variant("down", { initial: true })
          .build();
        defineFlow(gate.down, { push: (g) => ({ n: g.n + 1 }) });
        const calls: string[] = [];
        const record = (sm: StateManager): void => {
          sm.addExitHandler(lamp.off, (l, _snapshot, _prev, key) => {
            calls.push(`exit ${String(l)} ${String(key)}`);
            return HandlerResult.ok();
          });
          sm.addEnterHandler(lamp.off, (l, _snapshot, prev) => {
            calls.push(`enter ${String(l)} from ${String(prev)}`);
            return HandlerResult.ok();
          });
          sm.addUpdateHandler(slot.idle, (s) => {
            calls.push(`update slot n=${s.n}`);
            return HandlerResult.ok();
          });
          sm.addUpdateHandler(gate.down, () => {
            calls.push("update gate");
            return HandlerResult.rejected("stuck");
          });
        };
        const held = { n: 0, lamp: lamp.off({ watts: 1 }) };
        const inRoot = { root: { slot: slot.idle(held) }, gate: { n: 0 } };
        const atTop = { slot: held, gate: { n: 0 } };
        if (nested) {
          applyFlow(inRoot, [root, gate], record);
        } else {
          applyFlow(atTop, [slot, gate], record);
        }
        const target: { gate: unknown } = nested ? inRoot : atTop;
        const label = nested ? "nested" : "top level";
        const gateBefore = target.gate;
        const slotAt = (): InstanceOf<typeof slot> =>
          nested
            ? (inRoot as unknown as { root: InstanceOf<typeof root> }).root.slot
            : (atTop as unknown as { slot: InstanceOf<typeof slot> }).slot;
        const lampBefore = slotAt().lamp;

        const result = dispatch(target, push());

        expect(String(result), label).toBe("Rejected: stuck");
        expect(slotAt().n, label).toBe(9);
        expect(slotAt().lamp, label).toBe(lampBefore);
        expect(target.gate, label).toBe(gateBefore);
        expect(calls, label).toEqual([
          "exit lamp.off(watts=1) undefined",
          "update slot n=1",
          "update gate",
          "update slot n=9",
        ]);
      }
    });
  });

  describe("every end of a dispatch", () => {
    const start = defineSignal("start");
    const stop = defineSignal("stop");
    const go = defineSignal("go");

    type JobProps = { n: number; reason?: string };

    /** A job whose idle reducer declares done through running (transitional), with failed, and answers go with
     * stopped and no failed; running's stop reducer is an abort reducer; failed takes FAILURE's reason. */
    function defineJob() {
      const job = defineState<JobProps>()
        .name("job")
        .signals({ start, stop, go })
        .variant("idle", { initial: true })
        .variant("running", { transitional: true })
        .variant("done", { async: true })
        .variant("failed")
        .variant("stopped")
        .build();
      defineFlow(job.idle, {
        start: (s) =>
          StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s), { timeoutMs: 100 }),
        go: (s) => job.stopped(s),
      });
      defineFlow(job.running, { stop: (s) => job.stopped(s) });
      defineFlow(job.failed, {}, { [FAILURE]: (s, { reason }) => ({ ...s, reason }) });
      return job;
    }

    type Job = ReturnType<typeof defineJob>;

    function makeJob(job: Job, init: (sm: StateManager) => void): { job: InstanceOf<Job> } {
      const target = { job: { n: 0 } };
      applyFlow(target, [job], init);
      return target as unknown as { job: InstanceOf<Job> };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("everything passed: next commits, and the result is OK", async () => {
      const job = defineJob();
      const t = makeJob(job, (sm) => sm.addTransitionHandler(job.done, async () => HandlerResult.ok()));

      const outcome = await dispatch(t, start()).done();

      expect(String(outcome)).toBe("OK");
      expect(String(t.job)).toBe("job.done(n=1)");
    });

    it("a handler of a step refused it and the reducer gave no failed, as only an ok answer may: the state is as it was, and the result is the merged refusal", () => {
      const job = defineJob();
      const t = makeJob(job, (sm) => {
        sm.addExitHandler(job.idle, () => HandlerResult.rejected("first"));
        sm.addExitHandler(job.idle, () => HandlerResult.rejected("second"));
      });
      const before = t.job;

      const result = dispatch(t, go());

      expect(String(result)).toBe("Rejected: first");
      expect(t.job).toBe(before);
    });

    it("a handler of a step refused it and a failed is given: failed commits with the refusal as its reason, and the result is the merged refusal", () => {
      const job = defineJob();
      const t = makeJob(job, (sm) => sm.addEnterHandler(job.running, () => HandlerResult.rejected("busy")));

      const result = dispatch(t, start());

      expect(String(result)).toBe("Rejected: busy");
      expect(String(t.job)).toBe("job.failed(n=0 reason=busy)");
    });

    it("the work refused, or outlasted its timeout: failed commits with the refusal's message or the timeout's as its reason, and the result is the refusal, or an Error whose error is the TransitionAborted of kind timeout", async () => {
      for (const [work, text, reason] of [
        [async () => HandlerResult.rejected("no route"), "Rejected: no route", "no route"],
        [
          () => new Promise<HandlerResult>(() => {}),
          "TransitionAborted: job did not reach job.done within 100 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
          "job did not reach job.done within 100 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
        ],
      ] as const) {
        const job = defineJob();
        const t = makeJob(job, (sm) => sm.addTransitionHandler(job.done, work));

        const r = dispatch(t, start());
        await vi.advanceTimersByTimeAsync(100);

        expect(String(await r.done())).toBe(text);
        expect(stateVar(t.job)).toBe(job.failed);
        expect(t.job.reason).toBe(reason);
      }
    });

    it("a handler of the step into failed refused it: failed commits anyway with its reason, and the result is that handler's Error", async () => {
      const job = defineJob();
      const t = makeJob(job, (sm) => {
        sm.addTransitionHandler(job.done, async () => HandlerResult.rejected("no route"));
        sm.addEnterHandler(job.failed, () => HandlerResult.rejected("jam refuses"));
      });

      const outcome = await dispatch(t, start()).done();

      expect(outcome.kind).toBe(ResultKind.Error);
      expect(outcome.error?.message).toBe(
        "jam refuses [SF029] Make the failed variant's handlers succeed; report trouble there through state, not a refusal.",
      );
      expect(String(t.job)).toBe("job.failed(n=0 reason='no route')");
    });

    it("an abort was accepted: the state is the abort reducer's; the transition's result is Rejected 'aborted by stop', the abort's that of its step", async () => {
      const job = defineJob();
      const t = makeJob(job, (sm) =>
        sm.addTransitionHandler(job.done, (_next, _snapshot, _prev, _key, signal) => {
          return new Promise<HandlerResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          });
        }),
      );
      const send = await lock(t);
      const original = send(start());

      const aborting = send(stop(), { abort: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(String(await original.done())).toBe("Rejected: aborted by stop");
      expect(String(await aborting.done())).toBe("OK");
      expect(String(t.job)).toBe("job.stopped(n=0)");
      await send[Symbol.asyncDispose]();
    });

    it("disposeFlow ran during the work: nothing more commits, and the result is an Error", async () => {
      const job = defineJob();
      const t = makeJob(job, (sm) => sm.addTransitionHandler(job.done, () => new Promise<HandlerResult>(() => {})));
      const r = dispatch(t, start());

      disposeFlow(t);
      await vi.advanceTimersByTimeAsync(100);

      expect((await r.done()).kind).toBe(ResultKind.Error);
      expect(Reflect.has(t, "job")).toBe(false);
    });
  });

  describe("the FAILURE result", () => {
    /** The FAILURE reducer that puts the reason in props. */
    const withReason = (s: DoorProps, { reason }: { reason?: string }): DoorProps => ({ ...s, reason });

    it("a failed step folds { kind, reason } into failed through its variant's FAILURE reducer: kind rejected, and the message of a Rejected, the first of two that merged; a Rejected without a message gives none", () => {
      for (const [messages, reason] of [
        [["first", "second"], "first"],
        [[""], undefined],
      ] as const) {
        const door = defineDoor();
        const seen: Array<{ reason?: string }> = [];
        defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed(s)) });
        defineFlow(
          door.jammed,
          {},
          {
            [FAILURE]: (s, failure) => {
              seen.push(failure);
              return withReason(s, failure);
            },
          },
        );
        const target = { door: { n: 0 } };
        applyFlow(target, [door], (sm) => {
          for (const message of messages) {
            sm.addExitHandler(door.closed, () => HandlerResult.rejected(message));
          }
        });
        const typed = target as unknown as DoorTarget;

        dispatch(target, push());

        expect(seen, String(messages)).toEqual([{ kind: "rejected", reason, error: undefined }]);
        expect(stateVar(typed.door), String(messages)).toBe(door.jammed);
        expect(typed.door.reason, String(messages)).toBe(reason);
      }
    });

    it("the reason of an Error is its error's message: two merged Errors give their AggregateError's joined message", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed(s)) });
      defineFlow(door.jammed, {}, { [FAILURE]: withReason });
      const target = { door: { n: 0 } };
      applyFlow(target, [door], (sm) => {
        sm.addEnterHandler(door.open, () => {
          throw new Error("broken");
        });
        sm.addEnterHandler(door.open, () => HandlerResult.error(new Error("worse")));
      });
      const typed = target as unknown as DoorTarget;

      const result = dispatch(target, push());

      expect(result.error?.message).toBe("broken; worse");
      expect(typed.door.reason).toBe("broken; worse");
    });

    it.each([
      [
        "throws",
        (error: Error): HandlerResult => {
          throw error;
        },
      ],
      ["returns an Error", (error: Error): HandlerResult => HandlerResult.error(error)],
    ] as const)("a handler that %s gives FAILURE kind error, whose error is that very Error and whose reason its message", (_what, refuse) => {
      const door = defineDoor();
      const seen: unknown[] = [];
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed(s)) });
      defineFlow(
        door.jammed,
        {},
        {
          [FAILURE]: (s, failure) => {
            seen.push(failure);
            return s;
          },
        },
      );
      const broken = new Error("broken");
      const target = { door: { n: 0 } };
      applyFlow(target, [door], (sm) => sm.addEnterHandler(door.open, () => refuse(broken)));

      dispatch(target, push());

      expect(seen).toEqual([{ kind: "error", reason: "broken", error: broken }]);
      expect((seen[0] as { error: unknown }).error).toBe(broken);
    });

    it("FAILURE folds into a node the failed step updates too: a failed of the variant the node had before the signal", () => {
      const door = defineDoor();
      defineFlow(
        door.closed,
        { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.closed({ n: 5 })) },
        { [FAILURE]: withReason },
      );
      const calls: string[] = [];
      const target = makeDoor(door, calls, {
        "enter door.open(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck"),
      });

      dispatch(target, push());

      expect(calls.at(-1)).toBe("update door.closed(n=5) from door.closed(n=0)");
      expect(String(target.door)).toBe("door.closed(n=5 reason=stuck)");
    });

    it("a variant without a FAILURE reducer folds nothing, which is no error: failed keeps the props its reducer gave", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed({ n: 7 })) });
      const target = makeDoor(door, [], {
        "enter door.open(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck"),
      });

      const result = dispatch(target, push());

      expect(String(result)).toBe("Rejected: stuck");
      expect(String(target.door)).toBe("door.jammed(n=7)");
    });

    it("FAILURE folds in the same fold as the enter handlers' named results, before them: an enter handler sees failed as its reducer gave it, the commit handlers see both", () => {
      const door = defineState<DoorProps & { notes?: string }>()
        .name("door")
        .signals({ push })
        .variant("closed", { initial: true })
        .variant("open")
        .variant("jammed", { results: { noted: (data) => String(data) } })
        .build();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
      defineFlow(
        door.jammed,
        {},
        {
          [FAILURE]: (s, { reason }) => ({ ...s, reason }),
          // Reads the reason FAILURE folded in before it.
          noted: (s, note) => ({ ...s, notes: `${note} after ${s.reason}` }),
        },
      );
      const seen: string[] = [];
      const target = { door: { n: 0 } };
      applyFlow(target, [door], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addEnterHandler(door.jammed, (s) => {
          seen.push(`enter sees ${String(s.reason)}`);
          return door.jammed.results.noted("seen");
        });
        sm.addCommitHandler(door.jammed, (s) => {
          seen.push(`commit sees ${s.reason}, ${s.notes}`);
        });
      });

      dispatch(target, push());

      expect(seen).toEqual(["enter sees undefined", "commit sees stuck, seen after stuck"]);
    });

    it("a result the variant declares under the name failure does not collide with FAILURE: each folds through its own reducer", () => {
      const door = defineState<DoorProps & { note?: string }>()
        .name("door")
        .signals({ push })
        .variant("closed", { initial: true })
        .variant("open")
        .variant("jammed", { results: { failure: (data) => String(data) } })
        .build();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
      defineFlow(
        door.jammed,
        {},
        {
          [FAILURE]: (s, { reason }) => ({ ...s, reason }),
          failure: (s, note) => ({ ...s, note }),
        },
      );
      const target = { door: { n: 0 } };
      applyFlow(target, [door], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.failure("from the handler"));
      });

      const result = dispatch(target, push());

      expect(String(result)).toBe("Rejected: stuck");
      expect(String(target.door)).toBe("door.jammed(n=0 reason=stuck note='from the handler')");
    });

    it("a symbol user code makes, even with Symbol.for('FAILURE'), is not FAILURE: a reducer keyed by it gets no failure", () => {
      const mine = Symbol.for("FAILURE");
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open({ n: s.n + 1 }), door.jammed(s)) });
      // Cast, as plain JavaScript would pass it: the reducers' type takes no key but the declared names and FAILURE.
      defineFlow(door.jammed, {}, { [mine]: (s: DoorProps) => ({ ...s, reason: "mine" }) } as never);
      const target = makeDoor(door, [], {
        "enter door.open(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck"),
      });

      dispatch(target, push());

      expect(mine).not.toBe(FAILURE);
      expect(String(target.door)).toBe("door.jammed(n=0)");
    });

    it("a FAILURE reducer that throws in a failed step is skipped: failed commits without its reason, its Error joins the result, and the named results still fold", () => {
      const door = defineState<DoorProps & { note?: string }>()
        .name("door")
        .signals({ push })
        .variant("closed", { initial: true })
        .variant("open")
        .variant("jammed", { results: { noted: (data) => String(data) } })
        .build();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
      defineFlow(
        door.jammed,
        {},
        {
          [FAILURE]: () => {
            throw new Error("reducer broke");
          },
          noted: (s, note) => ({ ...s, note }),
        },
      );
      const target = { door: { n: 0 } };
      applyFlow(target, [door], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.noted("noted"));
      });

      const result = dispatch(target, push());

      expect(String(target.door)).toBe("door.jammed(n=0 note=noted)");
      // The floor's Error outranks the refused step's Rejected.
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe("reducer broke");
    });

    it("a state without signals takes FAILURE's reducer as defineFlow's only argument", () => {
      const lamp = defineState<{ watts: number; reason?: string }>()
        .name("lamp")
        .variant("off", { initial: true })
        .variant("broken")
        .build();
      defineFlow(lamp.broken, { [FAILURE]: (l, { reason }) => ({ ...l, reason }) });
      const panel = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("panel")
        .signals({ push })
        .variant("idle", { initial: true })
        .variant("busy")
        .build();
      defineFlow(panel.idle, {
        push: (p) => StateResult.ok(panel.busy(p), panel.idle({ lamp: lamp.broken(p.lamp) })),
      });
      const target = { panel: { lamp: lamp.off({ watts: 1 }) } };
      applyFlow(target, [panel], (sm) => sm.addEnterHandler(panel.busy, () => HandlerResult.rejected("no room")));
      const typed = target as unknown as { panel: InstanceOf<typeof panel> };

      const result = dispatch(target, push());

      expect(String(result)).toBe("Rejected: no room");
      expect(String(typed.panel.lamp)).toBe("lamp.broken(watts=1 reason='no room')");
    });

    it("a node the failed step leaves as it is gets no FAILURE: it keeps its instance", () => {
      const door = defineDoor();
      const failure = vi.fn(withReason);
      defineFlow(
        door.closed,
        { push: (s, _signal, ctx) => StateResult.ok(door.open({ n: s.n + 1 }), door(ctx)) },
        { [FAILURE]: failure },
      );
      const target = makeDoor(door, [], {
        "enter door.open(n=1) from door.closed(n=0)": () => HandlerResult.rejected("stuck"),
      });
      const before = target.door;

      const result = dispatch(target, push());

      expect(String(result)).toBe("Rejected: stuck");
      expect(target.door).toBe(before);
      expect(failure).not.toHaveBeenCalled();
    });

    it("a function as failed in a reducer: ok refuses it there, which is the reducer's Error, and nothing runs", () => {
      // Called as plain JavaScript would call it: a function as failed does not compile.
      const ok = StateResult.ok as (...args: unknown[]) => StateResult;
      const door = defineDoor();
      const jammed = () => door.jammed({ n: 0 });
      defineFlow(door.closed, { push: (s) => ok(door.open(s), jammed) });
      const calls: string[] = [];
      const target = makeDoor(door, calls);
      const before = target.door;

      const result = dispatch(target, push());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "StateResult.ok: failed must be an instance of next's state [SF069] Pass a failed made by a variant of next's state.",
      );
      expect(target.door).toBe(before);
      expect(calls).toEqual([]);
    });
  });

  describe("a failed instance checked when the reducer returns", () => {
    it("of another state: the reducer's Error, and nothing runs", () => {
      const other = defineState<{ n: number }>().name("other").variant("x", { initial: true }).build();
      const door = defineDoor();
      // Another state's instance as failed does not type-check, hence the cast.
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), other.x({ n: 0 }) as never) });
      const calls: string[] = [];
      const target = makeDoor(door, calls);

      const result = dispatch(target, push());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "StateResult.ok: failed must be an instance of next's state [SF069] Pass a failed made by a variant of next's state.",
      );
      expect(calls).toEqual([]);
    });

    it("replacing an answered node below: an Error, and nothing runs", () => {
      const lamp = defineState<{ watts: number }>()
        .name("lamp")
        .signals({ push })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      defineFlow(lamp.off, { push: (l) => lamp.on(l) });
      const panel = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("panel")
        .signals({ push })
        .variant("idle", { initial: true })
        .variant("busy")
        .build();
      // next keeps the lamp the lamp's reducer answered for; failed holds another lamp in its place.
      defineFlow(panel.idle, {
        push: (p) => StateResult.ok(panel.busy(p), panel.idle({ lamp: lamp.off({ watts: 0 }) })),
      });
      const entered: string[] = [];
      const target = { panel: { lamp: lamp.off({ watts: 1 }) } };
      applyFlow(target, [panel], (sm) => {
        sm.addEnterHandler(lamp.on, () => {
          entered.push("lamp.on");
          return HandlerResult.ok();
        });
      });
      const before = target.panel;

      const result = dispatch(target, push());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "panel replaced or removed panel.lamp, whose own reducer also answered [SF023] Keep the nested state in the parent's answer, or let only one of the two reducers answer.",
      );
      expect(target.panel).toBe(before);
      expect(entered).toEqual([]);
    });
  });

  describe("nested failed", () => {
    const go = defineSignal("go");

    const defineBox = () => {
      const box = defineState<{ n: number }>()
        .name("box")
        .signals({ go })
        .variant("empty", { initial: true })
        .variant("full")
        .variant("broken")
        .build();
      defineFlow(box.empty, { go: (b) => StateResult.ok(box.full({ n: b.n + 1 }), box.broken(b)) });
      return box;
    };

    it("every node the failed step enters or updates takes FAILURE: the parent's failed and the child's failed inside it both get the reason", () => {
      const lamp = defineState<{ watts: number; reason?: string }>()
        .name("lamp")
        .signals({ go })
        .variant("off", { initial: true })
        .variant("on")
        .variant("broken")
        .build();
      defineFlow(lamp.off, { go: (l) => StateResult.ok(lamp.on(l), lamp.broken(l)) });
      defineFlow(lamp.broken, {}, { [FAILURE]: (l, { reason }) => ({ ...l, reason }) });
      const panel = defineState<{ lamp: InstanceOf<typeof lamp>; reason?: string }>()
        .name("panel")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("busy")
        .variant("jammed")
        .build();
      defineFlow(panel.idle, { go: (p) => StateResult.ok(panel.busy(p), panel.jammed(p)) });
      defineFlow(panel.jammed, {}, { [FAILURE]: (p, { reason }) => ({ ...p, reason }) });
      const target = { panel: { lamp: lamp.off({ watts: 1 }) } };
      applyFlow(target, [panel], (sm) => {
        sm.addEnterHandler(lamp.on, () => HandlerResult.rejected("no power"));
      });
      const typed = target as unknown as { panel: InstanceOf<typeof panel> };

      const result = dispatch(target, go());

      expect(String(result)).toBe("Rejected: no power");
      expect(stateVar(typed.panel)).toBe(panel.jammed);
      expect(typed.panel.reason).toBe("no power");
      expect(stateVar(typed.panel.lamp)).toBe(lamp.broken);
      expect(typed.panel.lamp.reason).toBe("no power");
    });

    it("a nested node's failed is its parent's answer with the child's failed in it", () => {
      const lamp = defineState<{ watts: number }>()
        .name("lamp")
        .signals({ go })
        .variant("off", { initial: true })
        .variant("on")
        .variant("broken")
        .build();
      defineFlow(lamp.off, { go: (l) => StateResult.ok(lamp.on(l), lamp.broken(l)) });
      const panel = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("panel")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("busy")
        .variant("jammed")
        .build();
      defineFlow(panel.idle, { go: (p) => StateResult.ok(panel.busy(p), panel.jammed(p)) });
      const target = { panel: { lamp: lamp.off({ watts: 1 }) } };
      applyFlow(target, [panel], (sm) => {
        sm.addEnterHandler(lamp.on, () => HandlerResult.rejected("no power"));
      });

      const result = dispatch(target, go());

      expect(String(result)).toBe("Rejected: no power");
      expect(String(target.panel)).toBe("panel.jammed(lamp=lamp.broken(watts=1))");
    });

    it("a nested node whose failed is its own instance before the signal gets no call after the refused step ran its exit, and neither does its parent: the panel keeps its instance", async () => {
      const lamp = defineState<{ watts: number }>()
        .name("lamp")
        .signals({ go })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      defineFlow(lamp.off, {
        // ctx.parent is the panel the reducer ran on, so its lamp is the instance before the signal.
        go: (l, _signal, ctx) =>
          StateResult.ok(lamp.on(l), (ctx.parent as unknown as { lamp: ReturnType<typeof lamp.off> }).lamp),
      });
      const panel = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("panel")
        .variant("idle", { initial: true })
        .build();
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = { panel: { lamp: lamp.off({ watts: 1 }) } };
      applyFlow(
        target,
        [panel],
        (sm) => {
          for (const variant of [lamp.off, lamp.on, panel.idle]) {
            sm.addExitHandler(variant, (state) => {
              calls.push(`exit ${String(state)}`);
              return HandlerResult.ok();
            });
            sm.addUpdateHandler(variant, (state) => {
              calls.push(`update ${String(state)}`);
              return HandlerResult.ok();
            });
            sm.addEnterHandler(variant, (state, _snapshot, prev) => {
              calls.push(`enter ${String(state)} from ${String(prev)}`);
              return variant === lamp.on ? HandlerResult.rejected("no power") : HandlerResult.ok();
            });
          }
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const before = target.panel;

      const result = dispatch(target, go());
      await tick();

      expect(String(result)).toBe("Rejected: no power");
      expect(target.panel).toBe(before);
      expect(calls).toEqual(["exit lamp.off(watts=1)", "enter lamp.on(watts=1) from lamp.off(watts=1)"]);
      // The attempt rebuilt the panel around the lamp; the failed step changes nothing.
      expect(entries.map((entry) => entry.stateChanges)).toEqual([
        [
          {
            stateName: "panel",
            oldState: "panel.idle(lamp=lamp.off(watts=1))",
            newState: "panel.idle(lamp=lamp.on(watts=1))",
          },
          { stateName: "panel.lamp", oldState: "lamp.off(watts=1)", newState: "lamp.on(watts=1)" },
        ],
      ]);
    });

    /** A rack holding a shelf holding a box: the box and the rack answer `go`, the shelf in between does not. */
    function defineRack() {
      const box = defineBox();
      const shelf = defineState<{ box?: InstanceOf<typeof box> }>()
        .name("shelf")
        .variant("low", { initial: true })
        .variant("high")
        .build();
      const rack = defineState<{ shelf: InstanceOf<typeof shelf> }>()
        .name("rack")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("busy")
        .variant("jammed")
        .build();
      return { box, shelf, rack };
    }

    /** A rack target whose box's entry into full is refused. */
    function makeRack({ box, shelf, rack }: ReturnType<typeof defineRack>) {
      const target = { rack: { shelf: shelf.low({ box: box.empty({ n: 0 }) }) } };
      applyFlow(target, [rack], (sm) => {
        sm.addEnterHandler(box.full, () => HandlerResult.rejected("too heavy"));
      });
      return target as unknown as { rack: InstanceOf<typeof rack> };
    }

    it("at depth 2, an ancestor's failed that replaces the node in between and keeps the answered node commits with that node's failed inside", () => {
      const made = defineRack();
      const { shelf, rack } = made;
      defineFlow(rack.idle, {
        go: (r) => StateResult.ok(rack.busy(r), rack.jammed({ shelf: shelf.high({ box: r.shelf.box }) })),
      });
      const target = makeRack(made);

      const result = dispatch(target, go());

      expect(String(result)).toBe("Rejected: too heavy");
      expect(String(target.rack)).toBe("rack.jammed(shelf=shelf.high(box=box.broken(n=0)))");
    });

    it("one that removes it is an Error when the reducer returns, and nothing commits", () => {
      const byInstance = defineRack();
      defineFlow(byInstance.rack.idle, {
        go: (r) =>
          StateResult.ok(byInstance.rack.busy(r), byInstance.rack.jammed({ shelf: byInstance.shelf.high({}) })),
      });
      const instanceTarget = makeRack(byInstance);
      const before = instanceTarget.rack;

      const refused = dispatch(instanceTarget, go());

      expect(refused.kind).toBe(ResultKind.Error);
      expect(refused.error?.message).toBe(
        "rack replaced or removed rack.shelf.box, whose own reducer also answered [SF023] Keep the nested state in the parent's answer, or let only one of the two reducers answer.",
      );
      expect(instanceTarget.rack).toBe(before);
    });
  });

  describe("a failed step that keeps or updates an asynchronous variant needs no transition", () => {
    const go = defineSignal("go");
    const turnOn = defineSignal("turnOn");

    /** A lamp whose on is asynchronous; its reducers are left to the test. */
    const defineLamp = () =>
      defineState<{ watts: number }>()
        .name("lamp")
        .signals({ go, turnOn })
        .variant("off", { initial: true })
        .variant("on", { async: true })
        .build();
    type Lamp = ReturnType<typeof defineLamp>;

    /** turnOn: a transition into on; with no transition handler it has no work and commits on at once. */
    const turnOnReducer = (lamp: Lamp) => (l: { watts: number }) =>
      StateResult.transition(lamp.on(l), lamp.off({ ...l }), lamp.off(l));

    /** Records "<kind> <instance>" for every enter, exit and update handler of `variants`; off's enter refuses. */
    function recordLamp(sm: StateManager, lamp: Lamp, variants: readonly StateVariant[], calls: string[]): void {
      for (const variant of variants) {
        sm.addEnterHandler(variant, (state) => {
          calls.push(`enter ${String(state)}`);
          return variant === lamp.off ? HandlerResult.rejected("no switch") : HandlerResult.ok();
        });
        sm.addExitHandler(variant, (state) => {
          calls.push(`exit ${String(state)}`);
          return HandlerResult.ok();
        });
        sm.addUpdateHandler(variant, (state) => {
          calls.push(`update ${String(state)}`);
          return HandlerResult.ok();
        });
      }
    }

    it("an ok answer whose failed is the asynchronous instance the refused step exited: no call, so no transition is needed, and the node keeps that instance", () => {
      const lamp = defineLamp();
      defineFlow(lamp.off, { turnOn: turnOnReducer(lamp) });
      defineFlow(lamp.on, { go: (l, _signal, ctx) => StateResult.ok(lamp.off(l), lamp(ctx)) });
      const calls: string[] = [];
      const target = { lamp: { watts: 5 } };
      applyFlow(target, [lamp], (sm) => recordLamp(sm, lamp, [lamp.off, lamp.on], calls));
      expect(dispatch(target, turnOn()).kind).toBe(ResultKind.OK);
      calls.length = 0;
      const on = target.lamp;

      const result = dispatch(target, go());

      expect(String(result)).toBe("Rejected: no switch");
      expect(target.lamp).toBe(on);
      expect(calls).toEqual(["exit lamp.on(watts=5)", "enter lamp.off(watts=5)"]);
    });

    it("a parent's failed that holds the asynchronous child the refused step exited, as the same instance: the parent's failed is an update, and the child gets no call", () => {
      const lamp = defineLamp();
      defineFlow(lamp.off, { turnOn: turnOnReducer(lamp) });
      const panel = defineState<{ lamp: InstanceOf<Lamp> }>()
        .name("panel")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("busy")
        .build();
      // next turns the lamp off; failed is a new panel that holds the lamp the reducer ran on.
      defineFlow(panel.idle, { go: (p) => StateResult.ok(panel.busy({ lamp: lamp.off(p.lamp) }), panel.idle(p)) });
      const calls: string[] = [];
      const target = { panel: { lamp: lamp.off({ watts: 5 }) } };
      applyFlow(target, [panel], (sm) => recordLamp(sm, lamp, [lamp.off, lamp.on, panel.idle, panel.busy], calls));
      expect(dispatch(target, turnOn()).kind).toBe(ResultKind.OK);
      calls.length = 0;
      const typed = target as unknown as { panel: InstanceOf<typeof panel> };
      const on = typed.panel.lamp;

      const result = dispatch(target, go());

      expect(String(result)).toBe("Rejected: no switch");
      expect(typed.panel.lamp).toBe(on);
      expect(calls).toEqual([
        "exit lamp.on(watts=5)",
        "exit panel.idle(lamp=lamp.on(watts=5))",
        "enter panel.busy(lamp=lamp.off(watts=5))",
        "enter lamp.off(watts=5)",
        "update panel.idle(lamp=lamp.on(watts=5))",
      ]);
    });

    it("a node without failed that the refused step exited in an asynchronous variant stays as it was with no call, while another answer's failed commits", () => {
      const lamp = defineLamp();
      defineFlow(lamp.off, { turnOn: turnOnReducer(lamp) });
      defineFlow(lamp.on, { go: (l) => lamp.off(l) });
      const gate = defineState<{ n: number }>()
        .name("gate")
        .signals({ go })
        .variant("down", { initial: true })
        .variant("up")
        .variant("stuck")
        .build();
      defineFlow(gate.down, { go: (g) => StateResult.ok(gate.up(g), gate.stuck(g)) });
      const calls: string[] = [];
      const target = { lamp: { watts: 5 }, gate: { n: 0 } };
      applyFlow(target, [lamp, gate], (sm) => recordLamp(sm, lamp, [lamp.off, lamp.on], calls));
      expect(dispatch(target, turnOn()).kind).toBe(ResultKind.OK);
      calls.length = 0;
      const on = target.lamp;

      const result = dispatch(target, go());

      expect(String(result)).toBe("Rejected: no switch");
      expect(target.lamp).toBe(on);
      expect(String(target.gate)).toBe("gate.stuck(n=0)");
      expect(calls).toEqual(["exit lamp.on(watts=5)", "enter lamp.off(watts=5)"]);
    });

    it("a refused end step that exited an asynchronous child its failed keeps: the failed end updates the parent and gives the child no call", () => {
      const lamp = defineLamp();
      defineFlow(lamp.off, { turnOn: turnOnReducer(lamp) });
      const panel = defineState<{ lamp: InstanceOf<Lamp> }>()
        .name("panel")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("busy")
        .build();
      // The end turns the lamp off; temp and failed are new panels that hold the lamp the reducer ran on. The end
      // enters no asynchronous variant, so the transition has no work and its end runs inside the send.
      defineFlow(panel.idle, {
        go: (p) => StateResult.transition(panel.busy({ lamp: lamp.off(p.lamp) }), panel.idle(p), panel.idle(p)),
      });
      const calls: string[] = [];
      const target = { panel: { lamp: lamp.off({ watts: 5 }) } };
      applyFlow(target, [panel], (sm) => recordLamp(sm, lamp, [lamp.off, lamp.on, panel.idle, panel.busy], calls));
      expect(dispatch(target, turnOn()).kind).toBe(ResultKind.OK);
      calls.length = 0;
      const typed = target as unknown as { panel: InstanceOf<typeof panel> };
      const on = typed.panel.lamp;

      const result = dispatch(target, go());

      expect(String(result)).toBe("Rejected: no switch");
      expect(stateVar(typed.panel)).toBe(panel.idle);
      expect(typed.panel.lamp).toBe(on);
      expect(calls).toEqual([
        // The temp step.
        "update panel.idle(lamp=lamp.on(watts=5))",
        // The end step, refused.
        "exit lamp.on(watts=5)",
        "exit panel.idle(lamp=lamp.on(watts=5))",
        "enter panel.busy(lamp=lamp.off(watts=5))",
        "enter lamp.off(watts=5)",
        // The failed end.
        "update panel.idle(lamp=lamp.on(watts=5))",
      ]);
    });

    it("a new instance of the asynchronous variant as failed is an update, which no transition needs", () => {
      const lamp = defineLamp();
      defineFlow(lamp.off, { turnOn: turnOnReducer(lamp) });
      defineFlow(lamp.on, { go: (l) => StateResult.ok(lamp.off(l), lamp.on({ watts: 9 })) });
      const calls: string[] = [];
      const target = { lamp: { watts: 5 } };
      applyFlow(target, [lamp], (sm) => recordLamp(sm, lamp, [lamp.off, lamp.on], calls));
      expect(dispatch(target, turnOn()).kind).toBe(ResultKind.OK);
      calls.length = 0;

      const result = dispatch(target, go());

      expect(String(result)).toBe("Rejected: no switch");
      expect(String(target.lamp)).toBe("lamp.on(watts=9)");
      expect(calls).toEqual(["exit lamp.on(watts=5)", "enter lamp.off(watts=5)", "update lamp.on(watts=9)"]);
    });
  });

  describe("the floor", () => {
    it("failed's handlers refuse: failed commits anyway, every phase and the commit handlers run, and the result is an Error", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
      // gate is updated by the refused step and leaves its variant for its failed: a new exit in the failed step.
      const gate = defineState<{ n: number }>()
        .name("gate")
        .signals({ push })
        .variant("down", { initial: true })
        .variant("up")
        .build();
      defineFlow(gate.down, { push: (s) => StateResult.ok(gate.down({ n: s.n + 1 }), gate.up(s)) });
      // bell is updated by both steps, to two instances: a new update in the failed step.
      const bell = defineState<{ n: number }>()
        .name("bell")
        .signals({ push })
        .variant("quiet", { initial: true })
        .build();
      defineFlow(bell.quiet, { push: (s) => StateResult.ok(bell.quiet({ n: s.n + 1 }), bell.quiet({ n: 9 })) });
      const calls: string[] = [];
      const target = { door: { n: 0 }, gate: { n: 0 }, bell: { n: 0 } };
      applyFlow(target, [door, gate, bell], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addExitHandler(gate.down, (s) => {
          calls.push(`exit ${String(s)}`);
          return HandlerResult.rejected("gate refuses");
        });
        sm.addUpdateHandler(bell.quiet, (s) => {
          calls.push(`update ${String(s)}`);
          return String(s) === "bell.quiet(n=9)" ? HandlerResult.error(new Error("bell broke")) : HandlerResult.ok();
        });
        sm.addEnterHandler(door.jammed, (s) => {
          calls.push(`enter ${String(s)}`);
          return HandlerResult.rejected("jam refuses");
        });
        sm.addCommitHandler(door.jammed, (s) => {
          calls.push(`commit ${String(s)}`);
        });
      });

      const result = dispatch(target, push());

      expect([String(target.door), String(target.gate), String(target.bell)]).toEqual([
        "door.jammed(n=0)",
        "gate.up(n=0)",
        "bell.quiet(n=9)",
      ]);
      expect(calls).toEqual([
        "update bell.quiet(n=1)",
        "exit gate.down(n=0)",
        "update bell.quiet(n=9)",
        "enter door.jammed(n=0)",
        "commit door.jammed(n=0)",
      ]);
      // The floor's refusals merge to the update's Error, which outranks the refused step's Rejected.
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe("bell broke");
    });

    it("a floor refusal that is only Rejected is an Error with its message", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
      const target = makeDoor(door, [], {
        "enter door.open(n=0) from door.closed(n=0)": () => HandlerResult.rejected("stuck"),
        "enter door.jammed(n=0) from door.closed(n=0)": () => HandlerResult.rejected("jam refuses"),
      });

      const result = dispatch(target, push());

      expect(String(target.door)).toBe("door.jammed(n=0)");
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "jam refuses [SF029] Make the failed variant's handlers succeed; report trouble there through state, not a refusal.",
      );
    });

    it("named results fold into the failed: one whose result reducer throws is skipped and its Error joins the result, and the later ones still fold", () => {
      const door = defineState<DoorProps>()
        .name("door")
        .signals({ push })
        .variant("closed", { initial: true })
        .variant("open")
        .variant("jammed", { results: { noted: (data) => String(data), broken: () => null } })
        .build();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
      defineFlow(
        door.jammed,
        {},
        {
          noted: (s, note) => ({ ...s, reason: note }),
          broken: () => {
            throw new Error("reducer broke");
          },
        },
      );
      const committed: string[] = [];
      const target = { door: { n: 0 } };
      applyFlow(target, [door], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.noted("first"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.broken(null));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.noted("last"));
        sm.addCommitHandler(door.jammed, (s) => {
          committed.push(String(s));
        });
      });

      const result = dispatch(target, push());

      expect(String((target as unknown as DoorTarget).door)).toBe("door.jammed(n=0 reason=last)");
      expect(committed).toEqual(["door.jammed(n=0 reason=last)"]);
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe("reducer broke");
    });

    it("an observer compare that throws at the failed step's commit breaks nothing: failed commits, the result is the merged refusal, the entry logs the throw as that observer's result, and console.error reports it", async () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
      defineFlow(door.jammed, {}, { [FAILURE]: (s, { reason }) => ({ ...s, reason }) });
      const entries: StateFlowLogEntry[] = [];
      const target = makeDoor(
        door,
        [],
        { "enter door.open(n=0) from door.closed(n=0)": () => HandlerResult.rejected("stuck") },
        entries,
      );
      const thrown = new Error("compare boom");
      using _observer = observe(
        target,
        [door.jammed],
        function seen() {},
        () => {
          throw thrown;
        },
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = dispatch(target, push());

        expect(String(result)).toBe("Rejected: stuck");
        expect(String(target.door)).toBe("door.jammed(n=0 reason=stuck)");
        expect(error).toHaveBeenCalledWith("[SF/Object] the compare of observer seen on door.jammed threw:", thrown);
        await tick();
        expect(entries[0].finalResult).toBe("Rejected: stuck");
        expect(entries[0].observers).toEqual([
          { stateName: "door", observerName: "seen", needObserve: false, error: "Error: compare boom" },
        ]);
      } finally {
        error.mockRestore();
      }
    });
  });

  it("one instance under keys a and b of a map enters twice in one step, and a failed step that holds it under key c enters it there: a call is the instance at its path", () => {
    const add = defineSignal("add");
    const el = defineState<{ n: number }>().name("el").variant("on", { initial: true }).build();
    const host = defineState<{ els: Items<typeof el> }>()
      .name("host")
      .signals({ add })
      .variant("idle", { initial: true })
      .variant("busy")
      .build();
    const shared = el.on({ n: 1 });
    defineFlow(host.idle, {
      add: (h) =>
        StateResult.ok(
          host.busy({ els: h.els.with("a", shared).with("b", shared) }),
          host.idle({ els: h.els.with("c", shared) }),
        ),
    });
    const entered: unknown[] = [];
    const target = { host: { els: el.items() } };
    applyFlow(target, [host], (sm) => {
      sm.addEnterHandler(el.on, (_s, _snapshot, _prev, key) => {
        entered.push(key);
        return HandlerResult.ok();
      });
      sm.addEnterHandler(host.busy, () => HandlerResult.rejected("busy"));
    });

    const result = dispatch(target, add());

    expect(String(result)).toBe("Rejected: busy");
    expect([...(target as unknown as { host: InstanceOf<typeof host> }).host.els.keys()]).toEqual(["c"]);

    // The refused step entered the instance at a and at b, the failed step at c. A failed that held it under a or b
    // too would enter it there again (see failed-shared-instance.spec.ts).
    expect(entered).toEqual(["a", "b", "c"]);
  });

  it("the refusal reaches props only through a FAILURE reducer; no prop name is reserved", () => {
    const door = defineState<{ failure: string | null }>()
      .name("door")
      .signals({ push })
      .variant("closed", { initial: true })
      .variant("open")
      .variant("jammed")
      .build();
    defineFlow(door.closed, { push: (s) => StateResult.ok(door.open(s), door.jammed(s)) });
    defineFlow(door.jammed, { push: (s) => door.closed(s) });
    const target = { door: { failure: null } };
    let refuse = true;
    applyFlow(target, [door], (sm) => {
      sm.addEnterHandler(door.open, () => (refuse ? HandlerResult.rejected("stuck") : HandlerResult.ok()));
    });
    const typed = target as unknown as { door: StateInstance<{ failure: string | null }> };

    dispatch(target, push());

    // serializeDebug prints null as N.
    expect(String(typed.door)).toBe("door.jammed(failure=N)");
    // Back to closed by an ordinary signal: nothing refused, and nothing reaches props.
    refuse = false;
    dispatch(target, push());
    expect(String(typed.door)).toBe("door.closed(failure=N)");
  });
});
