import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  FAILURE,
  type FlowChange,
  HandlerResult,
  type InstanceOf,
  type Items,
  lock,
  mockHandlers,
  observe,
  type ReducerContext,
  ResultKind,
  type StateFlowLogEntry,
  type StateInstance,
  type StateManager,
  StateResult,
  setHandlersDisabled,
  stateVar,
  subscribeFlow,
  sync,
  type TransitionOptions,
} from "..";
import { Verdict } from "../result";

/**
 * A reducer declares an entry that waits for the world with `StateResult.transition(next, temp, failed, options?)`.
 * A first step commits temp at once with the dispatch's other answers. The work is every transition handler of every
 * asynchronous variant the step from temp to next enters, started together with one AbortSignal. When it settles OK or
 * Ignored its named results fold and next commits; a refusal, the timeout, or a refused end step takes the node to its
 * failed. An asynchronous variant is entered only that way. Every definition with reducers is made inside its test,
 * because defineFlow binds once per variant.
 */
describe("transition", () => {
  const start = defineSignal("start");
  const reset = defineSignal("reset");
  const bump = defineSignal("bump");

  const part = defineState<{ v: number }>()
    .name("part")
    .variant("a", { initial: true })
    .variant("b", { async: true })
    .build();
  type Parts = Items<typeof part>;

  const jobShape = () =>
    defineState<{ n: number; parts?: Parts }>()
      .name("job")
      .signals({ start, reset, bump })
      .variant("idle", { initial: true })
      .variant("running")
      .variant("done", { async: true })
      .variant("failed")
      // The job's parts are left out, so every job reads as its n.
      .stringRepr((s) => `n=${s.n}`)
      .build();
  type JobDef = ReturnType<typeof jobShape>;

  /** A fresh `job` whose idle reducer declares done (next, n + 1) through running (temp), with failed. */
  function defineJob(options?: TransitionOptions): JobDef {
    const job = jobShape();
    defineFlow(job.idle, {
      start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s), options),
    });
    defineFlow(job.done, { reset: () => job.idle({ n: 0 }) });
    defineFlow(job.failed, { reset: () => job.idle({ n: 0 }) });
    return job;
  }

  /** A fresh `job` whose idle reducer for `start` is `reducer`; done and failed reset to idle. */
  function defineJobReducer(
    reducer: (job: JobDef, s: { n: number; parts?: Parts }, ctx: ReducerContext) => StateResult,
  ): JobDef {
    const job = jobShape();
    defineFlow(job.idle, { start: (s, _signal, ctx) => reducer(job, s, ctx) });
    defineFlow(job.done, { reset: () => job.idle({ n: 0 }) });
    defineFlow(job.failed, { reset: () => job.idle({ n: 0 }) });
    return job;
  }

  type Target = { job: StateInstance<{ n: number; parts?: Parts }> };

  function make(job: JobDef, init: Parameters<typeof applyFlow>[2], entries: StateFlowLogEntry[] = []): Target {
    const target = { job: { n: 0 } };
    applyFlow(target, [job], init, { logHandlers: [(entry) => entries.push(entry)] });
    return target as unknown as Target;
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** A work that settles with `result` after `ms`. */
  const settling = (ms: number, result: () => HandlerResult) => async (): Promise<HandlerResult> => {
    await sleep(ms);
    return result();
  };

  /** An Error with no string form: its toString throws. */
  class ToStringThrows extends Error {
    override toString(): string {
      throw new Error("no string form");
    }
  }

  // Runs the timers due now (subscribeFlow and observers deliver on a 0 ms timer) and the pending
  // microtasks (log entries are delivered on one).
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setHandlersDisabled(false);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("the temp step", () => {
    it("temp commits at once: the getter, the temp entry, an observer and subscribeFlow see it", async () => {
      const job = defineJob();
      const entries: StateFlowLogEntry[] = [];
      const t = make(
        job,
        (sm) =>
          sm.addTransitionHandler(
            job.done,
            settling(100, () => HandlerResult.ok()),
          ),
        entries,
      );
      const observed: string[] = [];
      using _observer = observe(t, [job.running], (s) => observed.push(String(s)));
      const changes: string[] = [];
      using _subscriber = subscribeFlow(t, (c) => changes.push(`${c.prevVariant}->${c.nextVariant}`));

      const r = dispatch(t, start());

      expect(r.kind).toBe(ResultKind.InTransition);
      expect(String(t.job)).toBe("job.running(n=0)");
      await flush();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        transition: "temp",
        finalResult: "InTransition",
        stateChanges: [{ stateName: "job", oldState: "job.idle(n=0)", newState: "job.running(n=0)" }],
      });
      expect(observed).toEqual(["job.running(n=0)"]);
      expect(changes).toEqual(["idle->running"]);
    });

    it("is a full step with the other states: their answers and their enter handlers run in it, before the work starts", () => {
      const job = defineJob();
      const led = defineState<{ n: number }>()
        .name("led")
        .signals({ start })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      defineFlow(led.off, { start: (s) => led.on(s) });
      const order: string[] = [];
      const target = { job: { n: 0 }, led: { n: 0 } };
      applyFlow(target, [job, led], (sm) => {
        sm.addTransitionHandler(job.done, async () => {
          order.push(`work sees ${String(target.job)} and ${String(target.led)}`);
          return HandlerResult.ok();
        });
        sm.addEnterHandler(led.on, () => {
          order.push("led enter");
          return HandlerResult.ok();
        });
      });

      expect(dispatch(target, start()).kind).toBe(ResultKind.InTransition);

      expect(order).toEqual(["led enter", "work sees job.running(n=0) and led.on(n=0)"]);
    });

    it("refused, it follows ok: the failed path runs, every answer with a failed goes there, no transition starts, and the entry is marked failed", async () => {
      const job = defineJob();
      const lamp = defineState<{ n: number }>()
        .name("lamp")
        .signals({ start })
        .variant("off", { initial: true })
        .variant("on")
        .variant("broken")
        .build();
      defineFlow(lamp.off, { start: (s) => StateResult.ok(lamp.on(s), lamp.broken(s)) });
      const entries: StateFlowLogEntry[] = [];
      const work = vi.fn(async () => HandlerResult.ok());
      const target = { job: { n: 0 }, lamp: { n: 0 } };
      applyFlow(
        target,
        [job, lamp],
        (sm) => {
          sm.addTransitionHandler(job.done, work);
          sm.addEnterHandler(lamp.on, () => HandlerResult.rejected("no power"));
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );

      const r = dispatch(target, start());

      expect(String(r)).toBe("Rejected: no power");
      expect([String(target.job), String(target.lamp)]).toEqual(["job.failed(n=0)", "lamp.broken(n=0)"]);
      expect(work).not.toHaveBeenCalled();
      // A started transition would have armed its timer, and would make a bare dispatch throw.
      expect(vi.getTimerCount()).toBe(0);
      expect(dispatch(target, reset()).kind).toBe(ResultKind.OK);
      await flush();
      expect(entries[0]).toMatchObject({ transition: "failed", finalResult: "Rejected: no power" });
    });

    it("refused, with a failed that is the node's own instance and no other failed: nothing commits, the exit the refused step ran stays done and nothing enters again, the result is the refusal, and the entry keeps its temp mark", async () => {
      const job = defineJobReducer((job, s, ctx) =>
        StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job(ctx)),
      );
      const entries: StateFlowLogEntry[] = [];
      const calls: string[] = [];
      const t = make(
        job,
        (sm) => {
          sm.addExitHandler(job.idle, (s) => {
            calls.push(`exit ${String(s)}`);
            throw new Error("idle exit boom");
          });
          sm.addEnterHandler(job.idle, (s) => {
            calls.push(`enter ${String(s)}`);
            return HandlerResult.ok();
          });
          sm.addTransitionHandler(job.done, async () => HandlerResult.ok());
        },
        entries,
      );
      const before = t.job;

      const r = dispatch(t, start());

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe("idle exit boom");
      expect(t.job).toBe(before);
      expect(calls).toEqual(["exit job.idle(n=0)"]);
      expect(vi.getTimerCount()).toBe(0);
      await flush();
      expect(entries[0]).toMatchObject({ transition: "temp", finalStates: { job: "job.idle(n=0)" } });
    });

    // Whether the work succeeds or fails, and where the job ends.
    it.each([
      ["succeeds", () => HandlerResult.ok(), "job.done(n=1)", "final"],
      ["fails", () => HandlerResult.rejected("nope"), "job.failed(n=0)", "failed"],
    ] as const)("always runs: a temp that is the committed instance changes nothing there, while the other answers commit in it and keep their next when the work %s", async (_what, settle, end, mark) => {
      const job = defineJobReducer((job, s, ctx) =>
        StateResult.transition(job.done({ n: s.n + 1 }), job(ctx), job.failed(s)),
      );
      const lamp = defineState<{ n: number }>()
        .name("lamp")
        .signals({ start })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      defineFlow(lamp.off, { start: (l) => lamp.on(l) });
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = { job: { n: 0 }, lamp: { n: 0 } };
      applyFlow(
        target,
        [job, lamp],
        (sm) => {
          sm.addTransitionHandler(job.done, settling(10, settle));
          for (const variant of [job.idle, job.done, job.failed]) {
            sm.addEnterHandler(variant, (s) => {
              calls.push(`enter ${String(s)}`);
              return HandlerResult.ok();
            });
            sm.addExitHandler(variant, (s) => {
              calls.push(`exit ${String(s)}`);
              return HandlerResult.ok();
            });
            sm.addUpdateHandler(variant, (s) => {
              calls.push(`update ${String(s)}`);
              return HandlerResult.ok();
            });
          }
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const typed = target as unknown as { job: InstanceOf<typeof job>; lamp: InstanceOf<typeof lamp> };
      const jobBefore = typed.job;

      const r = dispatch(target, start());

      expect(r.kind).toBe(ResultKind.InTransition);
      expect(typed.job).toBe(jobBefore);
      expect(String(typed.lamp)).toBe("lamp.on(n=0)");
      // The temp step made no call on the job.
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);
      await r.done();
      expect(String(typed.job)).toBe(end);
      expect(String(typed.lamp)).toBe("lamp.on(n=0)");
      await flush();
      expect(entries.map((e) => [e.transition, e.stateChanges.map((c) => c.stateName)])).toEqual([
        ["temp", ["lamp"]],
        [mark, ["job"]],
      ]);
    });

    it("always runs and writes its entry: a temp that is the committed instance with no other answer is a step that changes nothing, and the end writes an entry of its own", async () => {
      const job = defineJobReducer((job, s, ctx) =>
        StateResult.transition(job.done({ n: s.n + 1 }), job(ctx), job.failed(s)),
      );
      const entries: StateFlowLogEntry[] = [];
      const t = make(
        job,
        (sm) =>
          sm.addTransitionHandler(
            job.done,
            settling(10, () => HandlerResult.ok()),
          ),
        entries,
      );
      const before = t.job;

      const r = dispatch(t, start());

      expect(r.kind).toBe(ResultKind.InTransition);
      expect(t.job).toBe(before);
      await flush();
      expect(entries).toEqual([
        expect.objectContaining({
          transition: "temp",
          finalResult: "InTransition",
          stateChanges: [],
          handlerResults: [],
        }),
      ]);
      await vi.advanceTimersByTimeAsync(10);
      expect((await r.done()).kind).toBe(ResultKind.OK);
      await flush();
      expect(entries[1]).toMatchObject({
        transition: "final",
        isAsync: true,
        finalResult: "OK",
        stateChanges: [{ stateName: "job", oldState: "job.idle(n=0)", newState: "job.done(n=1)" }],
        handlerResults: [expect.objectContaining({ type: "transition", result: "OK" })],
      });
    });
  });

  describe("the work", () => {
    it("is every transition handler of every asynchronous variant the end enters, nested states included, started together in the order of the enter calls, with one AbortSignal", async () => {
      const job = defineJobReducer((job, s) =>
        StateResult.transition(
          job.done({ n: s.n + 1, parts: part.items().with("k", part.b({ v: 1 })) }),
          job.running({ n: s.n, parts: part.items().with("k", part.a({ v: 0 })) }),
          job.failed(s),
        ),
      );
      const calls: Array<[string, AbortSignal, unknown]> = [];
      const t = make(job, (sm) => {
        for (const label of ["first", "second"]) {
          sm.addTransitionHandler(job.done, async (_next, _snapshot, _prev, key, signal) => {
            calls.push([`done ${label}`, signal, key]);
            await sleep(10);
            return HandlerResult.ok();
          });
        }
        sm.addTransitionHandler(part.b, async (_next, _snapshot, _prev, key, signal) => {
          calls.push(["part.b", signal, key]);
          return HandlerResult.ok();
        });
      });

      const r = dispatch(t, start());

      // All three started inside the send, before any settled.
      expect(calls.map(([label, , key]) => [label, key])).toEqual([
        ["done first", undefined],
        ["done second", undefined],
        ["part.b", "k"],
      ]);
      const [signal] = calls[0].slice(1) as [AbortSignal];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(calls.every(([, s]) => s === signal)).toBe(true);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect((await r.done()).kind).toBe(ResultKind.OK);
      expect(String(t.job)).toBe("job.done(n=1)");
    });

    it("none, or every one disabled with no mock: the end runs inside the send, next commits at once, and the dispatch writes two entries", async () => {
      for (const disabled of [false, true]) {
        const job = defineJob();
        const entries: StateFlowLogEntry[] = [];
        const work = vi.fn(async () => HandlerResult.rejected("never runs"));
        const t = make(
          job,
          (sm) => {
            if (disabled) {
              sm.addTransitionHandler(job.done, work);
            }
          },
          entries,
        );
        setHandlersDisabled(disabled);
        {
          await using send = await lock(t);
          const r = send(start());
          expect(r.kind, `disabled: ${disabled}`).toBe(ResultKind.OK);
          expect(String(t.job)).toBe("job.done(n=1)");
        }
        await flush();
        expect(work).not.toHaveBeenCalled();
        expect(entries.map((e) => [e.transition, e.finalResult, e.isAsync])).toEqual([
          ["temp", "InTransition", false],
          ["final", "OK", false],
        ]);
      }
    });

    it("a transition handler gets next as its reducer declared it, the end's snapshot before any fold, the instance it replaces, its key and the signal", async () => {
      const job = defineState<{ n: number; notes: string[] }>()
        .name("job")
        .signals({ start })
        .variant("idle", { initial: true })
        .variant("running")
        .variant("done", { async: true, results: { noted: (data) => String(data) } })
        .variant("failed")
        .build();
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ ...s, n: s.n + 1 }), job.running(s), job.failed(s)),
      });
      defineFlow(job.done, {}, { noted: (s, note) => ({ ...s, notes: [...s.notes, note] }) });
      const seen: unknown[][] = [];
      const target = { job: { n: 0, notes: [] } };
      applyFlow(target, [job], (sm) => {
        // The first returns a named result at once; the second still sees next unfolded.
        sm.addTransitionHandler(job.done, async () => job.done.results.noted("first"));
        sm.addTransitionHandler(job.done, async (next, snapshot, prev, key, signal) => {
          seen.push([String(next), snapshot.job === next, String(prev), key, signal instanceof AbortSignal]);
          await sleep(1);
          return HandlerResult.ok();
        });
      });
      const typed = target as unknown as { job: InstanceOf<typeof job> };

      const r = dispatch(target, start());
      await vi.advanceTimersByTimeAsync(1);
      await r.done();

      expect(seen).toEqual([["job.done(n=1 notes=[])", true, "job.running(n=0 notes=[])", undefined, true]]);
      expect(typed.job.notes).toEqual(["first"]);
    });
  });

  describe("the end", () => {
    it("OK or Ignored: the work's named results fold in call order before the end step, whose enter handlers see the fold; done() is OK; entries temp and final, with transition handler results", async () => {
      for (const last of ["ok", "ignored"] as const) {
        const job = defineState<{ n: number; notes: string[] }>()
          .name("job")
          .signals({ start })
          .variant("idle", { initial: true })
          .variant("running")
          .variant("done", { async: true, results: { noted: (data) => String(data) } })
          .variant("failed")
          .build();
        defineFlow(job.idle, { start: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s)) });
        defineFlow(job.done, {}, { noted: (s, note) => ({ ...s, notes: [...s.notes, note] }) });
        const entries: StateFlowLogEntry[] = [];
        const entered: string[][] = [];
        const target = { job: { n: 0, notes: [] } };
        applyFlow(
          target,
          [job],
          (sm) => {
            // The first settles last, and still folds first: the fold follows the call order.
            sm.addTransitionHandler(job.done, async function slow() {
              await sleep(20);
              return job.done.results.noted("a");
            });
            sm.addTransitionHandler(job.done, async function fast() {
              await sleep(10);
              return job.done.results.noted("b");
            });
            sm.addTransitionHandler(job.done, async function plain() {
              return last === "ok" ? HandlerResult.ok() : HandlerResult.ignored("nothing to load");
            });
            sm.addEnterHandler(job.done, function attach(s) {
              entered.push([...s.notes]);
              return HandlerResult.ok();
            });
          },
          { logHandlers: [(entry) => entries.push(entry)] },
        );
        const typed = target as unknown as { job: InstanceOf<typeof job> };

        const r = dispatch(target, start());
        await vi.advanceTimersByTimeAsync(20);

        expect((await r.done()).kind, last).toBe(ResultKind.OK);
        expect(typed.job.notes).toEqual(["a", "b"]);
        expect(entered).toEqual([["a", "b"]]);
        await flush();
        expect(entries.map((e) => e.transition)).toEqual(["temp", "final"]);
        expect(entries[1].handlerResults.map((line) => [line.type, line.handlerName, line.result])).toEqual([
          ["transition", "slow", "OK(noted)"],
          ["transition", "fast", "OK(noted)"],
          ["transition", "plain", last === "ok" ? "OK" : "Ignored: nothing to load"],
          ["enter", "attach", "OK"],
        ]);
        expect(entries[1]).toMatchObject({ isAsync: true, duration: 20 });
        expect(entries[1].dispatchOrder).toBeGreaterThan(entries[0].dispatchOrder as number);
      }
    });

    it.each([
      ["a Rejected", () => settling(10, () => HandlerResult.rejected("no route"))(), "Rejected: no route", "no route"],
      ["an Error", () => settling(10, () => HandlerResult.error(new Error("broken")))(), "Error: broken", "broken"],
      [
        "a rejection",
        async () => {
          await sleep(10);
          throw new Error("async boom");
        },
        "Error: async boom",
        "async boom",
      ],
      [
        "a rejection with no string form",
        async () => {
          await sleep(10);
          throw new ToStringThrows("boom");
        },
        "Error: a thrown value with no string form",
        "a thrown value with no string form",
      ],
      [
        "a synchronous throw",
        () => {
          throw new Error("sync boom");
        },
        "Error: sync boom",
        "sync boom",
      ],
      [
        "no promise",
        () => HandlerResult.ok(),
        "StateFlowError: Transition handler 'work' returned no promise [SF052] Make the transition handler async, or return a promise of its HandlerResult.",
        "Transition handler 'work' returned no promise [SF052] Make the transition handler async, or return a promise of its HandlerResult.",
      ],
      [
        "a value that is no HandlerResult",
        async () => 42,
        "StateFlowError: Handler 'work' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.",
        "Handler 'work' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.",
      ],
      [
        "a pending result",
        async () => Verdict.pending(Promise.resolve(Verdict.ok())),
        "StateFlowError: Handler 'work' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.",
        "Handler 'work' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.",
      ],
      [
        "a value whose prototype throws when it is checked",
        async () =>
          new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error("proto boom");
              },
            },
          ),
        "Error: proto boom",
        "proto boom",
      ],
      [
        "a return whose then throws when it is read",
        () => ({
          // biome-ignore lint/suspicious/noThenProperty: the case is a return whose `then` throws when the engine checks whether it is a promise.
          get then() {
            throw new Error("then getter boom");
          },
        }),
        "Error: then getter boom",
        "then getter boom",
      ],
    ])("a work that settles to %s takes the node to failed, whose FAILURE reducer, when its variant has one, gets the refusal's reason; done() gives the refusal, and the failed entry the work's handler result", async (_what, settle, text, reason) => {
      for (const withReducer of [true, false]) {
        const label = withReducer ? "with a FAILURE reducer" : "without one";
        const job = defineState<{ n: number; reason?: string }>()
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
        if (withReducer) {
          defineFlow(job.failed, {}, { [FAILURE]: (s, failure) => ({ ...s, reason: failure.reason }) });
        }
        const target = { job: { n: 0 } };
        const entries: StateFlowLogEntry[] = [];
        // The cases break the handler type on purpose, hence the cast.
        applyFlow(
          target,
          [job],
          (sm) => sm.addTransitionHandler(job.done, Object.defineProperty(settle, "name", { value: "work" }) as never),
          { logHandlers: [(entry) => entries.push(entry)] },
        );

        const r = dispatch(target, start());
        expect(r.kind, label).toBe(ResultKind.InTransition);
        await vi.advanceTimersByTimeAsync(10);
        const outcome = await r.done();

        expect(String(outcome), label).toBe(text);
        const typed = target as unknown as { job: InstanceOf<typeof job> };
        expect(stateVar(typed.job), label).toBe(job.failed);
        expect(typed.job.reason, label).toBe(withReducer ? reason : undefined);
        await flush();
        expect(
          entries.map((e) => e.transition),
          label,
        ).toEqual(["temp", "failed"]);
        expect(entries[1].handlerResults, label).toContainEqual(
          expect.objectContaining({ type: "transition", handlerName: "work", result: text }),
        );
      }
    });

    it("a context whose name cannot be read is refused when the handler is registered, before any transition", () => {
      const unnamed = {
        get [Symbol.toStringTag](): string {
          throw new Error("no name");
        },
      };
      const job = defineJob();

      expect(() =>
        make(job, (sm) => sm.addTransitionHandler(job.done, async () => HandlerResult.ok(), unnamed)),
      ).toThrow("no name");
    });

    // Each handler that can refuse the end step after the work's OK: temp's exit, next's enter, and the update of
    // a part at a key that temp and next both hold. failed shares temp's part, which the committed job holds, so the
    // failed step updates nothing. The failed end leaves temp too, so it calls temp's exit again: a refusing exit
    // refuses there a second time, and the failed end, which commits anyway, adds that refusal to the outcome as an
    // Error (an Error over a Rejected, two Errors as one).
    it.each([
      [
        "exit",
        "Rejected",
        "Rejected: end refuses",
        "StateFlowError: end refuses [SF029] Make the failed variant's handlers succeed; report trouble there through state, not a refusal.",
      ],
      ["exit", "throw", "Error: end boom", "AggregateError: end boom; end boom"],
      ["enter", "Rejected", "Rejected: end refuses", "Rejected: end refuses"],
      ["enter", "throw", "Error: end boom", "Error: end boom"],
      ["update", "Rejected", "Rejected: end refuses", "Rejected: end refuses"],
      ["update", "throw", "Error: end boom", "Error: end boom"],
    ] as const)("the end step refused by an %s handler (%s) goes to failed, whose step exits temp again", async (kind, failure, text, outcomeText) => {
      const kept = part.items().with("k", part.a({ v: 0 }));
      const job = defineJobReducer((job, s) =>
        StateResult.transition(
          job.done({ n: s.n + 1, parts: part.items().with("k", part.a({ v: 1 })) }),
          job.running({ n: s.n, parts: kept }),
          job.failed({ n: s.n, parts: kept }),
        ),
      );
      const fail = (): HandlerResult => {
        if (failure === "Rejected") {
          return HandlerResult.rejected("end refuses");
        }
        throw new Error("end boom");
      };
      const calls: string[] = [];
      const record = (label: string, refuses: boolean) => (): HandlerResult => {
        calls.push(label);
        return refuses ? fail() : HandlerResult.ok();
      };
      const entries: StateFlowLogEntry[] = [];
      const target = { job: { n: 0, parts: kept } };
      applyFlow(
        target,
        [job],
        (sm) => {
          sm.addTransitionHandler(
            job.done,
            settling(10, () => HandlerResult.ok()),
          );
          sm.addExitHandler(job.running, record("exit running", kind === "exit"));
          sm.addEnterHandler(job.done, record("enter done", kind === "enter"));
          sm.addUpdateHandler(part.a, record("update part", kind === "update"));
          sm.addEnterHandler(job.failed, record("enter failed", false));
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const t = target as unknown as Target;

      const r = dispatch(t, start());
      await vi.advanceTimersByTimeAsync(10);
      const outcome = await r.done();

      expect(String(outcome)).toBe(outcomeText);
      expect(String(t.job)).toBe("job.failed(n=0)");

      // The refused phase stops the end step; the failed end exits temp again and enters failed.
      const refusedStep = {
        exit: ["exit running"],
        update: ["exit running", "update part"],
        enter: ["exit running", "update part", "enter done"],
      }[kind];
      expect(calls).toEqual([...refusedStep, "exit running", "enter failed"]);

      // Nothing is pending: a bare dispatch would throw while a transition is.
      expect(dispatch(t, reset()).kind).toBe(ResultKind.OK);
      await flush();
      expect(entries[1]).toMatchObject({ transition: "failed", finalResult: outcomeText });
      expect(entries[1].handlerResults).toContainEqual(expect.objectContaining({ type: kind, result: text }));
    });

    it("a refused end step that exited the node, whose temp and failed are both its committed instance: the failed end gives it no call and folds no FAILURE, so the node keeps that instance and its exit stays done; the end's entry is marked failed", async () => {
      const job = jobShape();
      const failure = vi.fn((s: { n: number }) => s);
      defineFlow(
        job.idle,
        { start: (s, _signal, ctx) => StateResult.transition(job.done({ n: s.n + 1 }), job(ctx), job(ctx)) },
        { [FAILURE]: failure },
      );
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const t = make(
        job,
        (sm) => {
          sm.addTransitionHandler(
            job.done,
            settling(10, () => HandlerResult.ok()),
          );
          sm.addExitHandler(job.idle, (s) => {
            calls.push(`exit ${String(s)}`);
            return HandlerResult.ok();
          });
          sm.addEnterHandler(job.done, (s) => {
            calls.push(`enter ${String(s)}`);
            return HandlerResult.rejected("cannot attach");
          });
          sm.addEnterHandler(job.idle, (s) => {
            calls.push(`enter ${String(s)}`);
            return HandlerResult.ok();
          });
        },
        entries,
      );
      const before = t.job;

      const r = dispatch(t, start());
      await vi.advanceTimersByTimeAsync(10);

      expect(String(await r.done())).toBe("Rejected: cannot attach");
      expect(t.job).toBe(before);
      expect(failure).not.toHaveBeenCalled();
      expect(calls).toEqual(["exit job.idle(n=0)", "enter job.done(n=1)"]);
      await flush();
      expect(entries.map((e) => [e.transition, e.finalResult])).toEqual([
        ["temp", "InTransition"],
        ["failed", "Rejected: cannot attach"],
      ]);
    });

    it("a named result of the work that does not fold takes the node to failed without the end step", async () => {
      const job = defineState<{ n: number }>()
        .name("job")
        .signals({ start })
        .variant("idle", { initial: true })
        .variant("running")
        .variant("done", { async: true, results: { loaded: (data) => Number(data) } })
        .variant("failed")
        .build();
      defineFlow(job.idle, { start: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s)) });
      defineFlow(
        job.done,
        {},
        {
          loaded: () => {
            throw new Error("reducer broke");
          },
        },
      );
      const entered = vi.fn(() => HandlerResult.ok());
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) => {
        sm.addTransitionHandler(job.done, async () => job.done.results.loaded(1));
        sm.addEnterHandler(job.done, entered);
      });

      const r = dispatch(target, start());
      const outcome = await r.done();

      expect(String(outcome)).toBe("Error: reducer broke");
      expect(String(target.job)).toBe("job.failed(n=0)");
      expect(entered).not.toHaveBeenCalled();
    });

    it("a next or a failed that holds a nested state temp does not have puts it in at the end: next's part enters with its transition handler as the work, and when that refuses, failed's part enters", async () => {
      for (const refuses of [false, true]) {
        const job = defineJobReducer((job, s) =>
          StateResult.transition(
            job.done({ n: s.n + 1, parts: part.items().with("k", part.b({ v: 1 })) }),
            job.running({ n: s.n }),
            job.failed({ n: s.n, parts: part.items().with("e", part.a({ v: 9 })) }),
          ),
        );
        const calls: string[] = [];
        const t = make(job, (sm) => {
          sm.addTransitionHandler(part.b, async (_next, _snapshot, _prev, key) => {
            calls.push(`work ${String(key)}`);
            return refuses ? HandlerResult.rejected("no part") : HandlerResult.ok();
          });
          sm.addEnterHandler(part.a, (p, _snapshot, prev, key) => {
            calls.push(`enter ${String(p)} at ${String(key)} from ${String(prev)}`);
            return HandlerResult.ok();
          });
        });

        const outcome = await dispatch(t, start()).done();

        const parts = (t.job.parts as Parts).entries();
        if (refuses) {
          expect(String(outcome)).toBe("Rejected: no part");
          expect(stateVar(t.job)).toBe(job.failed);
          expect([...parts].map(([key, p]) => `${key}=${String(p)}`)).toEqual(["e=part.a(v=9)"]);
          expect(calls).toEqual(["work k", "enter part.a(v=9) at e from undefined"]);
        } else {
          expect(String(outcome)).toBe("OK");
          expect(stateVar(t.job)).toBe(job.done);
          expect([...parts].map(([key, p]) => `${key}=${String(p)}`)).toEqual(["k=part.b(v=1)"]);
          expect(calls).toEqual(["work k"]);
        }
      }
    });

    it("builds on what the temp step committed: folds there survive, below the declaring node and in another state; the end changes only the declaring node", async () => {
      const tag = defineState<{ label: string }>()
        .name("tag")
        .variant("blank", { initial: true })
        .variant("set", { results: { labeled: (data) => String(data) } })
        .build();
      defineFlow(tag.set, { labeled: (t, label) => ({ ...t, label }) });
      const job = defineState<{ n: number; tag: InstanceOf<typeof tag> }>()
        .name("job")
        .signals({ start })
        .variant("idle", { initial: true })
        .variant("running")
        .variant("done", { async: true })
        .variant("failed")
        .build();

      // next and temp share the new tag, which enters in the temp step. failed keeps the committed tag.
      defineFlow(job.idle, {
        start: (s) => {
          const tagged = { ...s, tag: tag.set({ label: "" }) };
          return StateResult.transition(job.done({ ...tagged, n: s.n + 1 }), job.running(tagged), job.failed(s));
        },
      });
      const cache = defineState<{ hits: number }>()
        .name("cache")
        .signals({ start })
        .variant("cold", { initial: true })
        .variant("warm", { results: { counted: (data) => Number(data) } })
        .build();
      defineFlow(cache.cold, { start: (c) => cache.warm(c) });
      defineFlow(cache.warm, {}, { counted: (c, hits) => ({ ...c, hits }) });
      const quiet = defineState<{ n: number }>().name("quiet").variant("x", { initial: true }).build();
      for (const work of [() => HandlerResult.ok(), () => HandlerResult.rejected("no")]) {
        const target = {
          job: { n: 0, tag: tag.blank({ label: "" }) },
          cache: { hits: 0 },
          quiet: { n: 0 },
        };
        applyFlow(target, [job, cache, quiet], (sm) => {
          sm.addEnterHandler(tag.set, () => tag.set.results.labeled("temp"));
          sm.addEnterHandler(cache.warm, () => cache.warm.results.counted(7));
          sm.addTransitionHandler(job.done, settling(10, work));
        });
        const typed = target as unknown as {
          job: InstanceOf<typeof job>;
          cache: InstanceOf<typeof cache>;
          quiet: InstanceOf<typeof quiet>;
        };
        const quietBefore = typed.quiet;

        const r = dispatch(target, start());
        const cacheAtTemp = typed.cache;
        expect(String(typed.job.tag)).toBe("tag.set(label=temp)");
        await vi.advanceTimersByTimeAsync(10);
        await r.done();

        const ok = work().kind === ResultKind.OK;
        expect(stateVar(typed.job)).toBe(ok ? job.done : job.failed);
        expect(String(typed.job.tag)).toBe(ok ? "tag.set(label=temp)" : "tag.blank(label=)");
        expect(typed.cache).toBe(cacheAtTemp);
        expect(typed.cache.hits).toBe(7);
        expect(typed.quiet).toBe(quietBefore);
      }
    });

    it("a parent whose parser throws after its first construction still commits a transition's end and its failed end: the engine's rebuilds run no parser", async () => {
      const job = defineJob();
      let parsed = 0;
      const strict = defineState<{ job: InstanceOf<typeof job> }>()
        .name("strict")
        .variant("x", { initial: true })
        .parser((p) => {
          parsed += 1;
          if (parsed > 1) {
            throw new Error("parsed twice");
          }
          return { ...(p as { job: InstanceOf<typeof job> }) };
        })
        .build();
      let refuse = false;
      const target = { strict: { job: job.idle({ n: 0 }) } };
      applyFlow(target, [strict], (sm) =>
        sm.addTransitionHandler(job.done, async () => (refuse ? HandlerResult.rejected("no") : HandlerResult.ok())),
      );

      expect((await dispatch(target, start()).done()).kind).toBe(ResultKind.OK);
      expect(String(target.strict)).toBe("strict.x(job=job.done(n=1))");
      dispatch(target, reset());
      refuse = true;
      expect((await dispatch(target, start()).done()).kind).toBe(ResultKind.Rejected);

      expect(String(target.strict)).toBe("strict.x(job=job.failed(n=0))");
      expect(parsed).toBe(1);
    });

    it("temp's exit handler gets temp when the failed end commits, and failed's enter handler gets temp as prev", async () => {
      const job = defineJob();
      const calls: Array<[string, unknown, unknown]> = [];
      const t = make(job, (sm) => {
        sm.addTransitionHandler(
          job.done,
          settling(10, () => HandlerResult.rejected("nope")),
        );
        sm.addExitHandler(job.running, (s, _snapshot, prev) => {
          calls.push(["exit running", s, prev]);
          return HandlerResult.ok();
        });
        sm.addEnterHandler(job.failed, (s, _snapshot, prev) => {
          calls.push(["enter failed", s, prev]);
          return HandlerResult.ok();
        });
      });

      const r = dispatch(t, start());
      const temp = t.job;
      await vi.advanceTimersByTimeAsync(10);
      await r.done();

      expect(calls.map(([label]) => label)).toEqual(["exit running", "enter failed"]);
      expect(calls[0][1]).toBe(temp);
      expect(calls[0][2]).toBe(temp);
      expect(calls[1][1]).toBe(t.job);
      expect(calls[1][2]).toBe(temp);
    });

    it.each([
      { end: "the work's OK", workMs: 100, endsAt: 100, kind: ResultKind.OK },
      { end: "the timeout", workMs: 1000, endsAt: 300, kind: ResultKind.Error },
      {
        end: "an accepted abort",
        workMs: 1000,
        endsAt: 50,
        kind: ResultKind.Rejected,
        cut: (t: Target) => dispatch(t, reset(), { abort: true }),
      },
      { end: "disposeFlow", workMs: 1000, endsAt: 50, kind: ResultKind.Error, cut: (t: Target) => disposeFlow(t) },
    ])("done() after $end spans the transition: startedAt is the dispatch, finishedAt the end", async ({
      workMs,
      endsAt,
      kind,
      cut,
    }) => {
      const job = defineJob({ timeoutMs: 300 });
      // An abort reducer of temp's variant.
      defineFlow(job.running, { reset: () => job.idle({ n: 0 }) });
      const t = make(job, (sm) =>
        sm.addTransitionHandler(
          job.done,
          (_next, _snapshot, _prev, _key, signal) =>
            new Promise<HandlerResult>((resolve) => {
              setTimeout(() => resolve(HandlerResult.ok()), workMs);
              // Settles at once when aborted, so an accepted abort's wait ends at once.
              signal.addEventListener("abort", () => resolve(HandlerResult.ignored("cut off")));
            }),
        ),
      );

      const t0 = Date.now();
      const r = dispatch(t, start());
      await vi.advanceTimersByTimeAsync(endsAt);
      cut?.(t);
      const outcome = await r.done();

      expect(outcome.kind).toBe(kind);
      expect([outcome.startedAt - t0, outcome.finishedAt - t0]).toEqual([0, endsAt]);
    });
  });

  describe("the end always has a failed", () => {
    // How the end fails, the result, and the kind and reason that FAILURE carries into failed.
    it.each([
      ["the work refuses", "refuse", "Rejected: no route", "rejected", "no route"],
      ["the work throws", "throw", "Error: work boom", "error", "work boom"],
      [
        "the work outlasts its timeout",
        "timeout",
        "TransitionAborted: job did not reach job.done within 100 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
        "timeout",
        "job did not reach job.done within 100 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
      ],
      ["a named result of the work does not fold", "fold", "Error: fold boom", "error", "fold boom"],
      ["the end step is refused", "end", "Rejected: cannot attach", "rejected", "cannot attach"],
      [
        "two handlers of the end step fail",
        "twice",
        "AggregateError: cannot attach; no screen",
        "error",
        "cannot attach; no screen",
      ],
    ] as const)("%s: the node ends in the failed its reducer declared, and FAILURE gives it the failure's kind, reason and error, merged", async (_what, how, text, kind, reason) => {
      const job = defineState<{ n: number; reason?: string }>()
        .name("job")
        .signals({ start })
        .variant("idle", { initial: true })
        .variant("running", { transitional: true })
        .variant("done", { async: true, results: { loaded: (data) => Number(data) } })
        .variant("failed")
        .build();
      const seen: Array<{ reason?: string; error?: unknown }> = [];
      defineFlow(job.idle, {
        start: (s) =>
          StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s), { timeoutMs: 100 }),
      });
      defineFlow(
        job.done,
        {},
        {
          loaded: () => {
            throw new Error("fold boom");
          },
        },
      );
      defineFlow(
        job.failed,
        {},
        {
          [FAILURE]: (s, failure) => {
            seen.push(failure);
            return { ...s, reason: failure.reason };
          },
        },
      );
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) => {
        sm.addTransitionHandler(job.done, async () => {
          if (how === "refuse") {
            return HandlerResult.rejected("no route");
          }
          if (how === "throw") {
            throw new Error("work boom");
          }
          if (how === "timeout") {
            return new Promise<HandlerResult>(() => {});
          }
          return how === "fold" ? job.done.results.loaded(1) : HandlerResult.ok();
        });
        // Reached only when the work succeeded and its result folded.
        sm.addEnterHandler(job.done, () =>
          how === "twice" ? HandlerResult.error(new Error("cannot attach")) : HandlerResult.rejected("cannot attach"),
        );
        sm.addEnterHandler(job.done, () =>
          how === "twice" ? HandlerResult.error(new Error("no screen")) : HandlerResult.ok(),
        );
      });
      const typed = target as unknown as { job: InstanceOf<typeof job> };

      const r = dispatch(target, start());
      await vi.advanceTimersByTimeAsync(100);
      const outcome = await r.done();

      expect(String(outcome)).toBe(text);
      expect(stateVar(typed.job)).toBe(job.failed);
      expect(typed.job.reason).toBe(reason);
      // A Rejected carries no error: its null is an absent error in FAILURE's data. Any other error is the result's
      // own, not a copy.
      expect(seen).toEqual([{ kind, reason, error: outcome.error ?? undefined }]);
      expect(seen[0]?.error).toBe(outcome.error ?? undefined);
    });

    it("through a temp of the node's own variant, a failed of that variant is an update, with no exit or enter", async () => {
      const go = defineSignal("go");
      const lamp = defineState<{ watts: number }>()
        .name("lamp")
        .variant("off", { initial: true })
        .variant("on", { async: true })
        .build();
      const job = defineState<{ n: number; lamp: InstanceOf<typeof lamp> }>()
        .name("job")
        .signals({ go })
        .variant("active", { initial: true })
        .build();
      // temp and failed change only props; the work is the lamp's entry into on.
      defineFlow(job.active, {
        go: (s) =>
          StateResult.transition(
            job.active({ ...s, lamp: lamp.on(s.lamp) }),
            job.active({ ...s, n: 1 }),
            job.active(s),
          ),
      });
      const calls: string[] = [];
      const target = { job: { n: 0, lamp: lamp.off({ watts: 5 }) } };
      applyFlow(target, [job], (sm) => {
        sm.addTransitionHandler(
          lamp.on,
          settling(10, () => HandlerResult.rejected("no power")),
        );
        for (const kind of ["enter", "exit", "update"] as const) {
          const record = (s: unknown): HandlerResult => {
            calls.push(`${kind} ${String(s)}`);
            return HandlerResult.ok();
          };
          if (kind === "enter") {
            sm.addEnterHandler(job.active, record);
          } else if (kind === "exit") {
            sm.addExitHandler(job.active, record);
          } else {
            sm.addUpdateHandler(job.active, record);
          }
        }
      });

      const r = dispatch(target, go());
      await vi.advanceTimersByTimeAsync(10);

      expect(String(await r.done())).toBe("Rejected: no power");
      expect(String(target.job)).toBe("job.active(n=0 lamp=lamp.off(watts=5))");
      expect(calls).toEqual([
        "update job.active(n=1 lamp=lamp.off(watts=5))",
        "update job.active(n=0 lamp=lamp.off(watts=5))",
      ]);
    });
  });

  describe("transitional variants", () => {
    /** A slot holding a producer, which can be creating (transitional), active or failed. */
    function defineSlot() {
      const producer = defineState<{ id: string }>()
        .name("producer")
        .variant("idle", { initial: true })
        .variant("creating", { transitional: true })
        .variant("active", { async: true })
        .variant("failed")
        .build();
      const slot = defineState<{ producer: InstanceOf<typeof producer> }>()
        .name("slot")
        .signals({ start })
        .variant("empty", { initial: true })
        .variant("busy")
        .build();
      return { producer, slot };
    }

    it("a reducer's answer into one, as next or as failed, at any depth, is an Error when the reducer returns, and nothing commits", () => {
      const reducers = {
        "ok's next": ({ producer, slot }: ReturnType<typeof defineSlot>) =>
          defineFlow(slot.empty, { start: (s) => slot.busy({ producer: producer.creating(s.producer) }) }),
        "ok's failed": ({ producer, slot }: ReturnType<typeof defineSlot>) =>
          defineFlow(slot.empty, {
            start: (s) => StateResult.ok(slot.busy(s), slot.busy({ producer: producer.creating(s.producer) })),
          }),
        "a transition's next": ({ producer, slot }: ReturnType<typeof defineSlot>) =>
          defineFlow(slot.empty, {
            start: (s) =>
              StateResult.transition(
                slot.busy({ producer: producer.creating(s.producer) }),
                slot.busy(s),
                slot.empty(s),
              ),
          }),
        "a transition's failed": ({ producer, slot }: ReturnType<typeof defineSlot>) =>
          defineFlow(slot.empty, {
            start: (s) =>
              StateResult.transition(
                slot.busy({ producer: producer.active(s.producer) }),
                slot.busy(s),
                slot.busy({ producer: producer.creating(s.producer) }),
              ),
          }),
      };
      for (const [label, define] of Object.entries(reducers)) {
        const made = defineSlot();
        define(made);
        const target = { slot: { producer: made.producer.idle({ id: "p" }) } };
        applyFlow(target, [made.slot], () => {});
        const before = target.slot;

        const r = dispatch(target, start());

        expect(r.kind, label).toBe(ResultKind.Error);
        expect(String(r.error), label).toContain("slot.producer");
        expect(String(r.error), label).toContain("transitional");
        expect(target.slot, label).toBe(before);
      }
    });

    it("as temp it commits, at the top level or inside temp; an ordinary variant may be temp too", async () => {
      const { producer, slot } = defineSlot();
      defineFlow(slot.empty, {
        start: (s) =>
          StateResult.transition(
            slot.busy({ producer: producer.active(s.producer) }),
            slot.busy({ producer: producer.creating(s.producer) }),
            slot.empty(s),
          ),
      });
      const target = { slot: { producer: producer.idle({ id: "p" }) } };
      applyFlow(target, [slot], (sm) =>
        sm.addTransitionHandler(
          producer.active,
          settling(10, () => HandlerResult.ok()),
        ),
      );
      const typed = target as unknown as { slot: InstanceOf<typeof slot> };

      const r = dispatch(target, start());

      expect(r.kind).toBe(ResultKind.InTransition);
      // The ordinary busy is temp, and holds the transitional creating.
      expect(String(typed.slot)).toBe("slot.busy(producer=producer.creating(id=p))");
      await vi.advanceTimersByTimeAsync(10);
      expect((await r.done()).kind).toBe(ResultKind.OK);
      expect(String(typed.slot)).toBe("slot.busy(producer=producer.active(id=p))");
    });

    it("applyFlow refuses an initial snapshot that holds one", () => {
      const { producer, slot } = defineSlot();

      expect(() => applyFlow({ slot: { producer: producer.creating({ id: "p" }) } }, [slot], () => {})).toThrow(
        "slot.producer starts in a transitional variant, which commits only as the temp of a declared transition",
      );
    });
  });

  describe("an asynchronous variant is entered only as a transition's next", () => {
    /** A lamp whose on is asynchronous, in a panel whose lit and done are asynchronous; the panel has no reducers. */
    function definePanel() {
      const lamp = defineState<{ watts: number }>()
        .name("lamp")
        .variant("off", { initial: true })
        .variant("on", { async: true })
        .build();
      const panel = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("panel")
        .signals({ start, bump })
        .variant("idle", { initial: true })
        .variant("lit", { async: true })
        .variant("busy")
        .variant("done", { async: true })
        .variant("broken")
        .build();
      return { lamp, panel };
    }
    type Panel = ReturnType<typeof definePanel>;
    type PanelTarget = { panel: InstanceOf<Panel["panel"]> };

    function makePanel({ lamp, panel }: Panel, init: (sm: StateManager) => void = () => {}): PanelTarget {
      const target = { panel: { lamp: lamp.off({ watts: 5 }) } };
      applyFlow(target, [panel], init);
      return target as unknown as PanelTarget;
    }

    it("an ok answer that enters one, at the top level or by a nested state, is an Error naming the path and the variant; the mark decides, whatever handlers or mocks there are and whatever the switch says", () => {
      const answers: Array<[string, (made: Panel) => void]> = [
        ["panel enters panel.lit", ({ panel }) => defineFlow(panel.idle, { start: (p) => panel.lit(p) })],
        [
          "panel.lamp enters lamp.on",
          ({ lamp, panel }) => defineFlow(panel.idle, { start: (p) => panel.busy({ lamp: lamp.on(p.lamp) }) }),
        ],
      ];
      for (const [entered, define] of answers) {
        for (const setting of ["no handler", "a transition handler", "the switch on", "a transition mock"] as const) {
          const made = definePanel();
          define(made);
          const { lamp, panel } = made;
          const t = makePanel(made, (sm) => {
            if (setting === "a transition handler") {
              sm.addTransitionHandler(panel.lit, async () => HandlerResult.ok());
              sm.addTransitionHandler(lamp.on, async () => HandlerResult.ok());
            }
          });
          setHandlersDisabled(setting === "the switch on");
          using _mock =
            setting === "a transition mock"
              ? mockHandlers(lamp.on, { transition: async () => HandlerResult.ok() })
              : undefined;
          const before = t.panel;

          const r = dispatch(t, start());

          const label = `${entered}, ${setting}`;
          expect(r.kind, label).toBe(ResultKind.Error);
          expect(r.error?.message, label).toBe(
            `${entered}, whose entry is asynchronous; declare a transition [SF024] Return StateResult.transition(next, temp, failed) to enter it.`,
          );
          expect(t.panel, label).toBe(before);
          setHandlersDisabled(false);
        }
      }
    });

    it("an ok answer that enters one two levels down is an Error naming that path", () => {
      const { lamp, panel } = definePanel();
      const rack = defineState<{ panel: InstanceOf<typeof panel> }>()
        .name("rack")
        .signals({ start })
        .variant("x", { initial: true })
        .build();
      defineFlow(rack.x, { start: (r) => rack.x({ panel: panel.busy({ lamp: lamp.on(r.panel.lamp) }) }) });
      const target = { rack: { panel: panel.idle({ lamp: lamp.off({ watts: 5 }) }) } };
      applyFlow(target, [rack], () => {});
      const before = target.rack;

      const r = dispatch(target, start());

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe(
        "rack.panel.lamp enters lamp.on, whose entry is asynchronous; declare a transition [SF024] Return StateResult.transition(next, temp, failed) to enter it.",
      );
      expect(target.rack).toBe(before);
    });

    it("an initial snapshot that holds one at any depth is an Error naming the path and the variant", () => {
      const { lamp, panel } = definePanel();
      const rack = defineState<{ panel: InstanceOf<typeof panel> }>()
        .name("rack")
        .variant("x", { initial: true })
        .build();

      expect(() => applyFlow({ panel: { lamp: lamp.on({ watts: 5 }) } }, [panel], () => {})).toThrow(
        "panel.lamp starts in lamp.on, whose entry is asynchronous; declare a transition into it",
      );
      expect(() =>
        applyFlow({ rack: { panel: panel.idle({ lamp: lamp.on({ watts: 5 }) }) } }, [rack], () => {}),
      ).toThrow("rack.panel.lamp starts in lamp.on, whose entry is asynchronous; declare a transition into it");
    });

    it("a temp that enters one, and a failed instance that would enter one, at the top level or by a nested state, are Errors when the reducer returns", () => {
      // Each case: its reducers, the signal it sends, and the message. A case with startFirst sends start before: a
      // transition with no transition handler has no work, so it commits at once and puts the node where the case
      // starts.
      type Case = { reducers: (made: Panel) => void; startFirst?: true; send: "start" | "bump"; message: string };
      const cases: Record<string, Case> = {
        "a temp": {
          reducers: ({ panel }) =>
            defineFlow(panel.idle, {
              start: (p) => StateResult.transition(panel.done(p), panel.lit(p), panel.idle(p)),
            }),
          send: "start",
          message:
            "panel enters panel.lit, whose entry is asynchronous; declare a transition [SF024] Return StateResult.transition(next, temp, failed) to enter it.",
        },
        "a temp, nested": {
          reducers: ({ lamp, panel }) =>
            defineFlow(panel.idle, {
              start: (p) => StateResult.transition(panel.done(p), panel.busy({ lamp: lamp.on(p.lamp) }), panel.idle(p)),
            }),
          send: "start",
          message:
            "panel.lamp enters lamp.on, whose entry is asynchronous; declare a transition [SF024] Return StateResult.transition(next, temp, failed) to enter it.",
        },
        "an ok answer's failed": {
          reducers: ({ panel }) =>
            defineFlow(panel.idle, { start: (p) => StateResult.ok(panel.busy(p), panel.lit(p)) }),
          send: "start",
          message:
            "panel enters panel.lit, whose entry is asynchronous, in the failed step; declare a transition [SF025] Declare a failed whose variants are synchronous.",
        },
        "an ok answer's failed, nested": {
          reducers: ({ lamp, panel }) =>
            defineFlow(panel.idle, {
              start: (p) => StateResult.ok(panel.busy(p), panel.broken({ lamp: lamp.on(p.lamp) })),
            }),
          send: "start",
          message:
            "panel.lamp enters lamp.on, whose entry is asynchronous, in the failed step; declare a transition [SF025] Declare a failed whose variants are synchronous.",
        },
        // From lit to a new instance of lit: for the failed step of a refused temp step that is an update, but the
        // failed end comes from busy, and enters lit with no transition handler running.
        "a transition's failed that enters an asynchronous variant from temp": {
          reducers: ({ panel }) => {
            defineFlow(panel.idle, {
              start: (p) => StateResult.transition(panel.lit(p), panel.busy(p), panel.idle(p)),
            });
            defineFlow(panel.lit, { bump: (p) => StateResult.transition(panel.done(p), panel.busy(p), panel.lit(p)) });
          },
          startFirst: true,
          send: "bump",
          message:
            "panel enters panel.lit, whose entry is asynchronous, at the failed end of the transition; declare a transition [SF025] Declare a failed whose variants are synchronous.",
        },
        // The lamp on, then a temp that turns it off and a failed that keeps the lamp's instance: the failed step of a
        // refused temp step keeps it with no call, but the failed end comes from temp's lamp, which is off.
        "a transition's failed, nested": {
          reducers: ({ lamp, panel }) => {
            defineFlow(panel.idle, {
              start: (p) => StateResult.transition(panel.busy({ lamp: lamp.on(p.lamp) }), panel.busy(p), panel.idle(p)),
            });
            defineFlow(panel.busy, {
              bump: (p) => StateResult.transition(panel.done(p), panel.busy({ lamp: lamp.off(p.lamp) }), panel.busy(p)),
            });
          },
          startFirst: true,
          send: "bump",
          message:
            "panel.lamp enters lamp.on, whose entry is asynchronous, at the failed end of the transition; declare a transition [SF025] Declare a failed whose variants are synchronous.",
        },
      };
      for (const [label, { reducers, startFirst, send, message }] of Object.entries(cases)) {
        const made = definePanel();
        reducers(made);
        const t = makePanel(made);
        if (startFirst) {
          expect(dispatch(t, start()).kind, label).toBe(ResultKind.OK);
        }
        const before = t.panel;

        const r = dispatch(t, send === "start" ? start() : bump());

        expect(r.kind, label).toBe(ResultKind.Error);
        expect(r.error?.message, label).toBe(message);
        expect(t.panel, label).toBe(before);
      }
    });

    it("addTransitionHandler and a transition mock on a variant not declared asynchronous throw, a transitional one included", () => {
      const lamp = defineState<{ watts: number }>()
        .name("lamp")
        .variant("off", { initial: true })
        .variant("warming", { transitional: true })
        .variant("on", { async: true })
        .build();
      for (const variant of [lamp.warming, lamp.off]) {
        const message = `${String(variant)} is not asynchronous: only a variant declared with { async: true } has transition handlers`;

        // Cast, as plain JavaScript would pass it: the variant's type refuses it too.
        expect(() =>
          applyFlow({ lamp: { watts: 5 } }, [lamp], (sm) =>
            sm.addTransitionHandler(variant as never, async () => HandlerResult.ok()),
          ),
        ).toThrow(message);
        expect(() => mockHandlers(variant, { transition: async () => HandlerResult.ok() } as never)).toThrow(message);
        // Its other kinds take handlers and mocks.
        using _enter = mockHandlers(variant, { enter: () => HandlerResult.ok() });
      }
    });

    it("a transition whose end enters no asynchronous variant has no work and commits next at once, with the handlers on", () => {
      const made = definePanel();
      const { panel } = made;
      defineFlow(panel.idle, { start: (p) => StateResult.transition(panel.broken(p), panel.busy(p), panel.idle(p)) });
      const t = makePanel(made);

      expect(dispatch(t, start()).kind).toBe(ResultKind.OK);
      expect(stateVar(t.panel)).toBe(panel.broken);
    });

    it("a transition whose end enters an asynchronous variant with no transition handler registered has no work and commits next at once, with the handlers on", () => {
      const made = definePanel();
      const { panel } = made;
      defineFlow(panel.idle, { start: (p) => StateResult.transition(panel.done(p), panel.busy(p), panel.idle(p)) });
      const t = makePanel(made);

      expect(dispatch(t, start()).kind).toBe(ResultKind.OK);
      expect(stateVar(t.panel)).toBe(panel.done);
    });
  });

  describe("entry is a change of variant", () => {
    it("a transition to the node's own variant with its own instance as temp is an update without work; through a temp of another variant the node exits and enters again, with work", async () => {
      const go = defineSignal("go");
      for (const through of [false, true]) {
        const track = defineState<{ id: number }>()
          .name("track")
          .signals({ start, go })
          .variant("idle", { initial: true })
          .variant("active", { async: true })
          .variant("switching")
          .variant("failed")
          .build();
        defineFlow(track.idle, {
          start: (s) => StateResult.transition(track.active(s), track.switching(s), track.failed(s)),
        });
        defineFlow(track.active, {
          go: (s, _signal, ctx) =>
            StateResult.transition(
              track.active({ id: s.id + 1 }),
              through ? track.switching(s) : track(ctx),
              track.failed(s),
            ),
        });
        const calls: string[] = [];
        const target = { track: { id: 0 } };
        applyFlow(target, [track], (sm) => {
          sm.addTransitionHandler(track.active, async () => {
            calls.push("work");
            return HandlerResult.ok();
          });
          sm.addUpdateHandler(track.active, () => {
            calls.push("update active");
            return HandlerResult.ok();
          });
          sm.addExitHandler(track.active, () => {
            calls.push("exit active");
            return HandlerResult.ok();
          });
          sm.addEnterHandler(track.active, () => {
            calls.push("enter active");
            return HandlerResult.ok();
          });
        });
        await dispatch(target, start()).done();
        calls.length = 0;

        const r = dispatch(target, go());

        if (through) {
          expect(r.kind).toBe(ResultKind.InTransition);
          expect((await r.done()).kind).toBe(ResultKind.OK);
          expect(calls).toEqual(["exit active", "work", "enter active"]);
        } else {
          expect(r.kind).toBe(ResultKind.OK);
          expect(calls).toEqual(["update active"]);
        }
        expect(String(target.track)).toBe("track.active(id=1)");
      }
    });
  });

  describe("the lock and the log", () => {
    it("a lock() caller waits until the end commits, and the holder's dispose waits too; so does sync()", async () => {
      const job = defineJob();
      const t = make(job, (sm) =>
        sm.addTransitionHandler(
          job.done,
          settling(100, () => HandlerResult.ok()),
        ),
      );
      const holder = await lock(t);
      expect(holder(start()).kind).toBe(ResultKind.InTransition);

      let disposed = false;
      const disposing = holder[Symbol.asyncDispose]().then(() => {
        disposed = true;
      });
      let synced = false;
      const syncing = sync(t).then(() => {
        synced = true;
      });
      let seenByNext: string | null = null;
      const next = lock(t).then(async (send) => {
        seenByNext = String(t.job);
        await send[Symbol.asyncDispose]();
      });

      await vi.advanceTimersByTimeAsync(99);
      expect([disposed, synced, seenByNext]).toEqual([false, false, null]);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([disposing, syncing, next]);
      expect(seenByNext).toBe("job.done(n=1)");
    });

    it("both commits deliver a FlowChange: prev to temp, then temp to next", async () => {
      const job = defineJob();
      const t = make(job, (sm) =>
        sm.addTransitionHandler(
          job.done,
          settling(10, () => HandlerResult.ok()),
        ),
      );
      const changes: FlowChange[] = [];
      using _subscriber = subscribeFlow(t, (c) => changes.push(c));

      const r = dispatch(t, start());
      await vi.advanceTimersByTimeAsync(10);
      await r.done();
      // The end committed inside a fake-timer tick, where a 0 ms timer is due 1 ms later.
      await vi.advanceTimersByTimeAsync(1);

      expect(changes.map((c) => `${c.prevVariant}->${c.nextVariant}`)).toEqual(["idle->running", "running->done"]);
      expect(changes.map((c) => c.signal)).toEqual(["start{}", "start{}"]);
    });
  });

  describe("refusals", () => {
    it("declarations the reducers or the plan refuse are Errors that commit nothing: a pending result, another state's instances, an invalid timeoutMs, two transitions in one dispatch", () => {
      const other = defineState<{ n: number }>()
        .name("other")
        .signals({ start })
        .variant("a", { initial: true })
        .variant("b")
        .variant("c")
        .build();
      const cases: Array<[string, (job: JobDef, s: { n: number }) => StateResult]> = [
        // A pending result is the engine's, not a reducer's, and its type is no StateResult, hence the cast.
        ["returned no StateResult, instance or props", () => Verdict.pending(Promise.resolve(Verdict.ok())) as never],
        [
          "not an instance of job",
          () => StateResult.transition(other.a({ n: 1 }), other.b({ n: 0 }), other.c({ n: 0 })),
        ],
        ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648].map(
          (timeoutMs): [string, (job: JobDef, s: { n: number }) => StateResult] => [
            "timeoutMs",
            (job, s) => StateResult.transition(job.done({ n: 1 }), job.running(s), job.failed(s), { timeoutMs }),
          ],
        ),
      ];
      for (const [message, reducer] of cases) {
        const job = defineJobReducer(reducer);
        const work = vi.fn(async () => HandlerResult.ok());
        const t = make(job, (sm) => sm.addTransitionHandler(job.done, work));

        const r = dispatch(t, start());

        expect(r.kind, message).toBe(ResultKind.Error);
        expect(String(r.error), message).toContain(message);
        expect(String(t.job), message).toBe("job.idle(n=0)");
        expect(work, message).not.toHaveBeenCalled();
      }

      // Two states of one flow both declare a transition for the same signal.
      const job = defineJob();
      const aux = defineState<{ n: number }>()
        .name("aux")
        .signals({ start })
        .variant("off", { initial: true })
        .variant("busy")
        .variant("on")
        .build();
      defineFlow(aux.off, { start: (s) => StateResult.transition(aux.on(s), aux.busy(s), aux.off(s)) });
      const both = { job: { n: 0 }, aux: { n: 0 } };
      applyFlow(both, [job, aux], () => {});

      const r = dispatch(both, start());

      expect(r.kind).toBe(ResultKind.Error);
      expect(String(r.error)).toContain("two transitions declared in one dispatch: job and aux");
      expect(String(both.job)).toBe("job.idle(n=0)");
      expect(String(both.aux)).toBe("aux.off(n=0)");
    });

    it("a handler that returns a reducer's StateResult, or an enter handler that returns a promise, is an Error that refuses the dispatch", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const lamp = defineState<{ n: number }>()
          .name("lamp")
          .signals({ start })
          .variant("off", { initial: true })
          .variant("on")
          .variant("broken")
          .build();
        defineFlow(lamp.off, { start: (s) => lamp.on(s) });
        const cases: [string, Parameters<typeof applyFlow>[2], string][] = [
          [
            "exit",
            (sm) =>
              sm.addExitHandler(lamp.off, function declares() {
                // A reducer's result breaks the handler type on purpose, hence the cast.
                return StateResult.transition(lamp.on({ n: 1 }), lamp.broken({ n: 1 }), lamp.off({ n: 1 })) as never;
              }),
            "StateFlowError: Handler 'declares' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.",
          ],
          [
            "enter",
            (sm) =>
              sm.addEnterHandler(lamp.on, async function asyncEnter() {
                throw new Error("rejected later");
              } as never),
            "StateFlowError: Handler 'asyncEnter' returned a promise; enter, exit and update handlers are synchronous [SF050] Return a HandlerResult synchronously; put the waiting in a transition handler.",
          ],
        ];
        for (const [type, init, text] of cases) {
          const entries: StateFlowLogEntry[] = [];
          const target = { lamp: { n: 0 } };
          applyFlow(target, [lamp], init, { logHandlers: [(entry) => entries.push(entry)] });

          const r = dispatch(target, start());

          expect(r.kind).toBe(ResultKind.Error);
          expect(String(r)).toBe(text);
          expect(String(target.lamp)).toBe("lamp.off(n=0)");
          await flush();
          expect(entries[0].handlerResults).toEqual([expect.objectContaining({ type, result: text })]);
        }
        // Real timers would let an unhandled rejection surface on the next macrotask; run one.
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  describe("an observer compare that throws", () => {
    it("during the temp commit: temp commits and the transition runs to its end; the temp entry logs the throw as that observer's result, and console.error reports it", async () => {
      const job = defineJob();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const entries: StateFlowLogEntry[] = [];
      const t = make(
        job,
        (sm) =>
          sm.addTransitionHandler(
            job.done,
            settling(10, () => HandlerResult.ok()),
          ),
        entries,
      );
      const thrown = new Error("compare boom");
      using _observer = observe(
        t,
        [job.running],
        function seen() {},
        () => {
          throw thrown;
        },
      );

      const r = dispatch(t, start());

      expect(r.kind).toBe(ResultKind.InTransition);
      expect(String(t.job)).toBe("job.running(n=0)");
      expect(error).toHaveBeenCalledWith("[SF/Object] the compare of observer seen on job.running threw:", thrown);
      await vi.advanceTimersByTimeAsync(10);
      expect((await r.done()).kind).toBe(ResultKind.OK);
      expect(String(t.job)).toBe("job.done(n=1)");
      await flush();
      expect(entries.map((e) => [e.transition, e.finalResult])).toEqual([
        ["temp", "InTransition"],
        ["final", "OK"],
      ]);
      expect(entries[0].observers).toEqual([
        { stateName: "job", observerName: "seen", needObserve: false, error: "Error: compare boom" },
      ]);
    });

    it("during the end step's commit after the work: next commits, done() is OK, the end's entry logs the throw, console.error reports it, and the work's signal never aborts", async () => {
      const job = defineJob();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let workSignal: AbortSignal | undefined;
      const entries: StateFlowLogEntry[] = [];
      const t: Target = make(
        job,
        (sm) =>
          sm.addTransitionHandler(job.done, async (_next, _snapshot, _prev, _key, signal) => {
            workSignal = signal;
            await sleep(100);
            return HandlerResult.ok();
          }),
        entries,
      );
      const thrown = new Error("compare boom");
      using _observer = observe(
        t,
        [job.done],
        function seen() {},
        () => {
          throw thrown;
        },
      );

      const r = dispatch(t, start());
      await vi.advanceTimersByTimeAsync(100);

      expect((await r.done()).kind).toBe(ResultKind.OK);
      expect(String(t.job)).toBe("job.done(n=1)");
      expect(error).toHaveBeenCalledWith("[SF/Object] the compare of observer seen on job.done threw:", thrown);
      expect(workSignal?.aborted).toBe(false);
      await flush();
      expect(entries[1]).toMatchObject({ transition: "final", finalResult: "OK" });
      expect(entries[1].observers).toEqual([
        { stateName: "job", observerName: "seen", needObserve: false, error: "Error: compare boom" },
      ]);
    });

    it("during the failed end's commit (here the timeout's): failed commits, done() is the timeout's Error, the failed end's entry logs the throw, console.error reports it, and the queued sends settle", async () => {
      const job = defineJob({ timeoutMs: 100 });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const entries: StateFlowLogEntry[] = [];
      const t = make(
        job,
        (sm) =>
          sm.addTransitionHandler(
            job.done,
            settling(1000, () => HandlerResult.ok()),
          ),
        entries,
      );
      const thrown = new Error("compare boom");
      using _observer = observe(
        t,
        [job.failed],
        function seen() {},
        () => {
          throw thrown;
        },
      );
      const holder = await lock(t);
      const r = holder(start());
      // Only failed and done take reset: OK shows that failed committed.
      const queued = holder(reset());

      await vi.advanceTimersByTimeAsync(100);

      expect((await r.done()).error).toMatchObject({ kind: "timeout" });
      expect(error).toHaveBeenCalledWith("[SF/Object] the compare of observer seen on job.failed threw:", thrown);
      expect((await queued.done()).kind).toBe(ResultKind.OK);
      expect(String(t.job)).toBe("job.idle(n=0)");
      await holder[Symbol.asyncDispose]();
      expect(entries[1]).toMatchObject({
        transition: "failed",
        finalResult:
          "TransitionAborted: job did not reach job.done within 100 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
      });
      expect(entries[1].observers).toEqual([
        { stateName: "job", observerName: "seen", needObserve: false, error: "Error: compare boom" },
      ]);
    });
  });

  describe("a string form that throws while a step is logged", () => {
    /** A job whose string form throws for n = 13, so a step into such an instance throws while its changes are
     * logged, before its commit. */
    const brittleShape = () =>
      defineState<{ n: number }>()
        .name("job")
        .signals({ start, bump })
        .variant("idle", { initial: true })
        .variant("running")
        .variant("done", { async: true })
        .variant("failed")
        .stringRepr((s) => {
          if (s.n === 13) {
            throw new Error("no string form for 13");
          }
          return `n=${s.n}`;
        })
        .build();

    it("in the temp step: the throw leaves the dispatch, nothing commits, and no transition starts", async () => {
      const job = brittleShape();
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: 1 }), job.running({ n: 13 }), job.failed(s)),
      });
      const entries: StateFlowLogEntry[] = [];
      const work = vi.fn(async () => HandlerResult.ok());
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) => sm.addTransitionHandler(job.done, work), {
        logHandlers: [(entry) => entries.push(entry)],
      });

      expect(() => dispatch(target, start())).toThrow("no string form for 13");

      expect(String(target.job)).toBe("job.idle(n=0)");
      expect(work).not.toHaveBeenCalled();
      // A started transition would have armed its timer, and would make a bare dispatch throw.
      expect(vi.getTimerCount()).toBe(0);
      await flush();
      expect(entries[0]).toMatchObject({ transition: "temp", finalResult: "Error: no string form for 13" });
    });

    it("in the end step: next does not commit, failed does, done() is the Error, and the work's signal aborts as failed", async () => {
      const job = brittleShape();
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: 13 }), job.running(s), job.failed(s)),
      });
      let workSignal: AbortSignal | undefined;
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) =>
        sm.addTransitionHandler(job.done, async (_next, _snapshot, _prev, _key, signal) => {
          workSignal = signal;
          return HandlerResult.ok();
        }),
      );

      const outcome = await dispatch(target, start()).done();

      expect(outcome.kind).toBe(ResultKind.Error);
      expect(outcome.error?.message).toBe("no string form for 13");
      expect(String(target.job)).toBe("job.failed(n=0)");
      expect(workSignal?.reason).toMatchObject({
        kind: "failed",
        message:
          "failed: no string form for 13 [SF034] Read the refusal in the message; stop the work and release what it acquired.",
      });
    });

    it("in the failed end: nothing commits, done() resolves to the Error, the holder's lock is released and the queued sends settle", async () => {
      const job = brittleShape();
      defineFlow(job.idle, {
        start: (s) =>
          StateResult.transition(job.done({ n: 1 }), job.running(s), job.failed({ n: 13 }), { timeoutMs: 100 }),
      });
      defineFlow(job.running, { bump: (s) => ({ n: s.n + 1 }) });
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) => sm.addTransitionHandler(job.done, () => new Promise<HandlerResult>(() => {})));
      const holder = await lock(target);
      const r = holder(start());
      const queued = holder(bump());

      await vi.advanceTimersByTimeAsync(100);

      const final = await r.done();
      expect(final.kind).toBe(ResultKind.Error);
      expect(final.error?.message).toBe("no string form for 13");
      // failed did not commit: the job is in running, where the failed end started, and running takes bump.
      expect((await queued.done()).kind).toBe(ResultKind.OK);
      expect(String(target.job)).toBe("job.running(n=1)");
      await holder[Symbol.asyncDispose]();
      const next = await lock(target);
      await next[Symbol.asyncDispose]();
    });
  });
});
