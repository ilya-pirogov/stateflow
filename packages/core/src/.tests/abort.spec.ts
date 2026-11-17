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
  lock,
  observe,
  ResultKind,
  StateFlowError,
  type StateFlowLogEntry,
  type StateInstance,
  StateResult,
  stateVar,
  subscribeFlow,
  sync,
  TransitionAborted,
  type TransitionHandler,
  type TransitionOptions,
} from "..";

/**
 * A transition's work shares one AbortSignal, whose reason is always a TransitionAborted. The engine aborts it on an
 * accepted abort (kind aborted, "aborted by <signal>"), on the timeout (kind timeout, after failed committed), on
 * disposeFlow (kind disposed, "flow disposed"), and when the work's result will not commit (kind failed, after
 * failed committed): a handler of the work refused or failed, or the end step was refused or a fold failed.
 * `send(signal, { abort: true })` and `dispatch(target, signal, { abort: true })` run every reducer the signal reaches
 * on the committed snapshot; when they commit something and leave no transitional variant, the abort is accepted: the
 * signal aborts, the engine waits for the work no longer than what is left of its timeout, drops what the work gives,
 * and runs the abort's own step.
 */
describe("abort", () => {
  const start = defineSignal("start");
  const stop = defineSignal("stop");
  const quit = defineSignal<{ why: string }>("quit");
  const hold = defineSignal("hold");
  const refuse = defineSignal("refuse");
  const noop = defineSignal("noop");
  const keep = defineSignal("keep");
  const retry = defineSignal("retry");
  const reset = defineSignal("reset");
  const poke = defineSignal("poke");
  const redo = defineSignal("redo");
  const deny = defineSignal("deny");
  const crash = defineSignal("crash");

  const jobShape = () =>
    defineState<{ n: number }>()
      .name("job")
      .signals({ start, stop, quit, hold, refuse, noop, keep, retry, reset, poke, redo, deny, crash })
      .variant("idle", { initial: true })
      .variant("running", { transitional: true })
      .variant("retrying", { transitional: true })
      .variant("done", { async: true })
      .variant("failed")
      .variant("stopped")
      .build();
  type JobDef = ReturnType<typeof jobShape>;

  /** idle declares done through running (transitional), with failed; running's reducers are the abort cases. */
  function defineJob(options?: TransitionOptions): JobDef {
    const job = jobShape();
    defineFlow(job.idle, {
      start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s), options),
      poke: (s) => ({ n: s.n + 1 }),
    });
    defineFlow(job.running, {
      stop: (s) => job.stopped(s),
      quit: (s) => job.stopped(s),
      // Keeps running, a transitional variant.
      hold: (s) => ({ n: s.n + 100 }),
      refuse: () => StateResult.rejected("not now"),
      // A refusal and a throw without a message.
      deny: () => StateResult.rejected(""),
      crash: () => {
        throw new Error();
      },
      noop: () => StateResult.ignored("nothing to do"),
      // The reducer's own instance changes nothing.
      keep: (_s, _signal, ctx) => StateResult.ok(job(ctx)),
      retry: (s) => StateResult.transition(job.done({ n: s.n + 10 }), job.retrying(s), job.failed(s), options),
    });
    defineFlow(job.done, { reset: () => job.idle({ n: 0 }) });
    defineFlow(job.failed, { reset: () => job.idle({ n: 0 }) });
    defineFlow(job.stopped, { reset: () => job.idle({ n: 0 }) });
    return job;
  }

  type Target = { job: StateInstance<{ n: number }> };

  function make(job: JobDef, init: Parameters<typeof applyFlow>[2], entries: StateFlowLogEntry[] = []): Target {
    const target = { job: { n: 0 } };
    applyFlow(target, [job], init, { logHandlers: [(entry) => entries.push(entry)] });
    return target as unknown as Target;
  }

  /** A target whose transition into done has `work` as its only handler. */
  function makeWithWork(job: JobDef, work: TransitionHandler<JobDef["done"]>, entries: StateFlowLogEntry[] = []) {
    return make(job, (sm) => sm.addTransitionHandler(job.done, work), entries);
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  /** Resolves after `ms`, or as soon as `signal` aborts. */
  function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** A work that honours the signal: it ends at once when the signal aborts, by throwing its reason. */
  const honouring: TransitionHandler<JobDef["done"]> = async function work(_next, _snapshot, _prev, _key, signal) {
    await abortableSleep(1000, signal);
    signal.throwIfAborted();
    return HandlerResult.ok();
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("the signal", () => {
    it("every handler of the work gets one AbortSignal, whose reason is a TransitionAborted whose kind says what ended the work: an accepted abort, the timeout, disposeFlow, or a failure", async () => {
      const ends: Array<[TransitionAborted["kind"], string, (t: Target) => void]> = [
        [
          "aborted",
          "aborted by quit [SF040] Stop the work on abort and release what it acquired; expect Rejected where an abort may come.",
          (t) => dispatch(t, quit({ why: "user" }), { abort: true }),
        ],
        [
          "timeout",
          "job did not reach job.done within 100 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
          () => {},
        ],
        [
          "disposed",
          "flow disposed [SF046] Stop the work on abort and release what it acquired.",
          (t) => disposeFlow(t),
        ],
        [
          "failed",
          "failed: no route [SF034] Read the refusal in the message; stop the work and release what it acquired.",
          () => {},
        ],
      ];
      for (const [kind, message, end] of ends) {
        const job = defineJob({ timeoutMs: 100 });
        const signals: AbortSignal[] = [];
        const t = make(job, (sm) => {
          for (let i = 0; i < 2; i++) {
            sm.addTransitionHandler(job.done, (_next, _snapshot, _prev, _key, signal) => {
              signals.push(signal);
              return new Promise<HandlerResult>(() => {});
            });
          }
          if (kind === "failed") {
            // Refuses in 10 ms, while the others never settle.
            sm.addTransitionHandler(job.done, async () => {
              await sleep(10);
              return HandlerResult.rejected("no route");
            });
          }
        });

        dispatch(t, start());
        await vi.advanceTimersByTimeAsync(kind === "timeout" ? 100 : 10);
        end(t);

        expect(signals[0], kind).toBe(signals[1]);
        expect(signals[0].aborted, kind).toBe(true);
        expect(signals[0].reason, kind).toBeInstanceOf(TransitionAborted);
        // The signal's name, not its string form with its arguments.
        expect(signals[0].reason, kind).toMatchObject({ kind, message, name: "TransitionAborted" });
        await vi.advanceTimersByTimeAsync(1000);
      }
    });
  });

  describe("the timeout", () => {
    it("commits failed at once with an Error whose error is the TransitionAborted of kind timeout, then aborts the signal with that reason; the work's late result is dropped with no word", async () => {
      const job = defineJob({ timeoutMs: 200 });
      const entries: StateFlowLogEntry[] = [];
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let workSignal: AbortSignal | undefined;
      let seenAtAbort: string | undefined;
      const t: Target = makeWithWork(
        job,
        async (_next, _snapshot, _prev, _key, signal) => {
          workSignal = signal;
          signal.addEventListener("abort", () => {
            seenAtAbort = String(t.job);
          });
          await sleep(1000);
          return HandlerResult.ok();
        },
        entries,
      );

      const r = dispatch(t, start());
      await vi.advanceTimersByTimeAsync(199);
      expect(String(t.job)).toBe("job.running(n=0)");
      expect(workSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const outcome = await r.done();
      expect(outcome.kind).toBe(ResultKind.Error);
      expect(outcome.error).toBeInstanceOf(TransitionAborted);
      expect(outcome.error).toMatchObject({
        kind: "timeout",
        message:
          "job did not reach job.done within 200 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
      });
      expect(String(t.job)).toBe("job.failed(n=0)");
      expect(workSignal?.reason).toBe(outcome.error);
      expect(seenAtAbort).toBe("job.failed(n=0)");

      await vi.advanceTimersByTimeAsync(800);
      expect(String(t.job)).toBe("job.failed(n=0)");
      expect(error).not.toHaveBeenCalled();
      await flush();
      expect(entries.map((e) => e.transition)).toEqual(["temp", "failed"]);
      expect(entries[1].handlerResults).toEqual([
        expect.objectContaining({ type: "transition", result: "unsettled at timeout" }),
      ]);
    });
    it("after a successful end the signal never aborts, and past timeoutMs neither failed commits nor an entry is written; every end clears the engine's timer", async () => {
      const job = defineJob({ timeoutMs: 200 });
      const entries: StateFlowLogEntry[] = [];
      let workSignal: AbortSignal | undefined;
      const t = makeWithWork(
        job,
        async (_next, _snapshot, _prev, _key, signal) => {
          workSignal = signal;
          await sleep(50);
          return HandlerResult.ok();
        },
        entries,
      );

      const r = dispatch(t, start());
      await vi.advanceTimersByTimeAsync(50);
      expect((await r.done()).kind).toBe(ResultKind.OK);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);

      expect(workSignal?.aborted).toBe(false);
      expect(String(t.job)).toBe("job.done(n=1)");
      expect(entries.map((e) => e.transition)).toEqual(["temp", "final"]);

      // An accepted abort clears it too once its wait ends, and so does disposeFlow.
      for (const end of [
        (target: Target) => dispatch(target, stop(), { abort: true }),
        (target: Target) => disposeFlow(target),
      ]) {
        const other = defineJob({ timeoutMs: 200 });
        const target = makeWithWork(other, honouring);
        dispatch(target, start());
        end(target);
        await flush();
        expect(vi.getTimerCount()).toBe(0);
      }
    });
  });

  describe("failure", () => {
    it("the first handler of the work that refuses ends the transition at once: failed commits, the queue drains, then the signal aborts as failed; the entry lists the other works as settled or unsettled at failure, and a later settle is dropped with no word", async () => {
      const job = defineJob();
      const entries: StateFlowLogEntry[] = [];
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let workSignal: AbortSignal | undefined;
      let seenAtAbort: string | undefined;
      const t: Target = make(
        job,
        (sm) => {
          sm.addTransitionHandler(job.done, async function quick(_next, _snapshot, _prev, _key, signal) {
            workSignal = signal;
            signal.addEventListener("abort", () => {
              seenAtAbort = String(t.job);
            });
            await sleep(5);
            return HandlerResult.ok();
          });
          sm.addTransitionHandler(job.done, async function refuser() {
            await sleep(10);
            return HandlerResult.rejected("no route");
          });
          // Ignores the signal and settles long after the failure.
          sm.addTransitionHandler(job.done, async function slow() {
            await sleep(50);
            return HandlerResult.ok();
          });
        },
        entries,
      );
      const send = await lock(t);

      const r = send(start());
      // Queued behind the transition: failed takes reset, so the listener's idle shows failed committed and the queue
      // drained before the signal aborted.
      const queued = send(reset());
      await vi.advanceTimersByTimeAsync(10);

      const outcome = await r.done();
      expect(String(outcome)).toBe("Rejected: no route");
      expect((await queued.done()).kind).toBe(ResultKind.OK);
      expect(workSignal?.reason).toBeInstanceOf(TransitionAborted);
      expect(workSignal?.reason).toMatchObject({
        kind: "failed",
        message:
          "failed: no route [SF034] Read the refusal in the message; stop the work and release what it acquired.",
      });
      expect(seenAtAbort).toBe("job.idle(n=0)");
      // The transition's timer went with it; the slow work's sleep is left.
      expect(vi.getTimerCount()).toBe(1);
      await send[Symbol.asyncDispose]();
      await flush();
      expect(entries.map((e) => e.transition)).toEqual(["temp", "failed", undefined]);
      expect(entries[1].handlerResults.map((line) => [line.handlerName, line.result])).toEqual([
        ["quick", "OK"],
        ["refuser", "Rejected: no route"],
        ["slow", "unsettled at failure"],
      ]);

      await vi.advanceTimersByTimeAsync(40);

      expect(String(t.job)).toBe("job.idle(n=0)");
      expect(error).not.toHaveBeenCalled();
      await flush();
      expect(entries).toHaveLength(3);
    });

    it.each([
      [
        "an Error",
        async () => HandlerResult.error(new Error("broken")),
        "failed: broken [SF034] Read the refusal in the message; stop the work and release what it acquired.",
      ],
      [
        "a throw",
        async () => {
          throw new Error("boom");
        },
        "failed: boom [SF034] Read the refusal in the message; stop the work and release what it acquired.",
      ],
      [
        "a return that is no promise",
        () => HandlerResult.ok(),
        "failed: Transition handler 'work' returned no promise [SF052] Make the transition handler async, or return a promise of its HandlerResult. [SF034] Read the refusal in the message; stop the work and release what it acquired.",
      ],
      [
        "a value that is no HandlerResult",
        async () => 42,
        "failed: Handler 'work' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant. [SF034] Read the refusal in the message; stop the work and release what it acquired.",
      ],
    ])("a handler that settles to %s rolls the transition back at once, without waiting for the others", async (_what, settle, message) => {
      const job = defineJob();
      let workSignal: AbortSignal | undefined;
      const t = make(job, (sm) => {
        sm.addTransitionHandler(job.done, (_next, _snapshot, _prev, _key, signal) => {
          workSignal = signal;
          return new Promise<HandlerResult>(() => {});
        });
        // The cases break the handler type on purpose, hence the cast.
        sm.addTransitionHandler(job.done, Object.defineProperty(settle, "name", { value: "work" }) as never);
      });

      const r = dispatch(t, start());
      const outcome = await r.done();

      expect(outcome.kind).toBe(ResultKind.Error);
      expect(String(t.job)).toBe("job.failed(n=0)");
      expect(workSignal?.reason).toMatchObject({ kind: "failed", message });
    });

    it.each([
      [
        "the end step is refused",
        "refused",
        "failed: cannot attach [SF034] Read the refusal in the message; stop the work and release what it acquired.",
      ],
      [
        "a named result of the work does not fold",
        "fold",
        "failed: fold boom [SF034] Read the refusal in the message; stop the work and release what it acquired.",
      ],
    ])("every handler of the work succeeded but %s: failed commits, the queue drains, then the signal aborts as failed", async (_what, how, message) => {
      const job = defineState<{ n: number }>()
        .name("job")
        .signals({ start, reset })
        .variant("idle", { initial: true })
        .variant("running", { transitional: true })
        .variant("done", { async: true, results: { loaded: (data) => Number(data) } })
        .variant("failed")
        .build();
      defineFlow(job.idle, { start: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s)) });
      defineFlow(job.failed, { reset: () => job.idle({ n: 0 }) });
      defineFlow(
        job.done,
        {},
        {
          loaded: () => {
            throw new Error("fold boom");
          },
        },
      );
      let workSignal: AbortSignal | undefined;
      let seenAtAbort: string | undefined;
      const t = { job: { n: 0 } };
      applyFlow(t, [job], (sm) => {
        sm.addTransitionHandler(job.done, async (_next, _snapshot, _prev, _key, signal) => {
          workSignal = signal;
          signal.addEventListener("abort", () => {
            seenAtAbort = String(t.job);
          });
          return how === "fold" ? job.done.results.loaded(1) : HandlerResult.ok();
        });
        sm.addEnterHandler(job.done, () => HandlerResult.rejected("cannot attach"));
      });
      const send = await lock(t);

      const r = send(start());
      // Queued behind the transition: failed takes reset, so the listener's idle shows failed committed and the queue
      // drained before the signal aborted.
      const queued = send(reset());
      await r.done();

      expect((await queued.done()).kind).toBe(ResultKind.OK);
      expect(workSignal?.reason).toMatchObject({ kind: "failed", message });
      expect(seenAtAbort).toBe("job.idle(n=0)");
      await send[Symbol.asyncDispose]();
    });
  });

  describe("acceptance", () => {
    it("send(s, { abort: true }): the signal aborts, the abort's step commits once the work settled, the original done() is Rejected 'aborted by s', the abort's done() is its step's result, and the abort's entry lists the work as dropped", async () => {
      const job = defineJob();
      const entries: StateFlowLogEntry[] = [];
      const t = makeWithWork(job, honouring, entries);
      const send = await lock(t);
      const original = send(start());
      expect(original.kind).toBe(ResultKind.InTransition);

      const aborting = send(stop(), { abort: true });

      expect(aborting.kind).toBe(ResultKind.InTransition);
      expect(String(t.job)).toBe("job.running(n=0)");
      await flush();
      expect(String(t.job)).toBe("job.stopped(n=0)");
      // The work settled at once, so the abort's wait cleared its timer.
      expect(vi.getTimerCount()).toBe(0);
      expect((await aborting.done()).kind).toBe(ResultKind.OK);
      const was = await original.done();
      expect(was.kind).toBe(ResultKind.Rejected);
      expect(was.message).toBe("aborted by stop");
      await send[Symbol.asyncDispose]();
      await flush();
      expect(entries.map((e) => [e.signal, e.transition, e.aborted])).toEqual([
        ["start{}", "temp", undefined],
        ["stop{}", undefined, "job"],
      ]);
      expect(entries[1].handlerResults).toEqual([
        {
          type: "transition",
          handlerName: "work",
          stateName: "job",
          result:
            "dropped after abort: TransitionAborted: aborted by stop [SF040] Stop the work on abort and release what it acquired; expect Rejected where an abort may come.",
        },
      ]);
    });

    it("dispatch(t, s, { abort: true }) aborts while another caller holds the lock", async () => {
      const job = defineJob();
      const t = makeWithWork(job, honouring);
      const holder = await lock(t);
      expect(holder(start()).kind).toBe(ResultKind.InTransition);

      const r = dispatch(t, stop(), { abort: true });

      expect(r.kind).toBe(ResultKind.InTransition);
      await flush();
      expect(String(t.job)).toBe("job.stopped(n=0)");
      expect((await r.done()).kind).toBe(ResultKind.OK);
      await holder[Symbol.asyncDispose]();
    });

    it("the reducers run on the committed snapshot, which holds temp: running, or the node's own instance kept as temp", async () => {
      for (const withTemp of [true, false]) {
        const job = jobShape();
        defineFlow(job.idle, {
          start: (s, _signal, ctx) =>
            StateResult.transition(job.done({ n: s.n + 1 }), withTemp ? job.running(s) : job(ctx), job.failed(s)),
          stop: () => job.stopped({ n: 1 }),
        });
        defineFlow(job.running, { stop: () => job.stopped({ n: 2 }) });
        const t = makeWithWork(job, honouring);
        const holder = await lock(t);
        holder(start());

        const r = holder(stop(), { abort: true });
        await flush();

        expect((await r.done()).kind).toBe(ResultKind.OK);
        expect(String(t.job), String(withTemp)).toBe(withTemp ? "job.stopped(n=2)" : "job.stopped(n=1)");
        await holder[Symbol.asyncDispose]();
      }
    });

    it("refused, the transition continues: reducers that change nothing give Rejected, reducers that refuse their refusal, and an answer that would leave a transitional variant an Error; a second abort during the first is Rejected", async () => {
      const job = defineJob();
      let workSignal: AbortSignal | undefined;
      const t = makeWithWork(job, async (_next, _snapshot, _prev, _key, signal) => {
        workSignal = signal;
        await abortableSleep(100, signal);
        return HandlerResult.ok();
      });
      const send = await lock(t);
      const original = send(start());

      const leftTransitional =
        "job would be left in job.running, a transitional variant, which commits only as the temp of a declared transition [SF021] Return that variant as the temp of StateResult.transition, or another variant as next.; the transition continues [SF039] Fix the reducer's error named in the message.";
      const cases: Array<[() => ReturnType<typeof refuse>, ResultKind, string]> = [
        [refuse, ResultKind.Rejected, "not now; the transition continues"],
        // Without a message, the refusal names the signal.
        [deny, ResultKind.Rejected, "deny was rejected; the transition continues"],
        [
          crash,
          ResultKind.Error,
          "crash failed; the transition continues [SF039] Fix the reducer's error named in the message.",
        ],
        [noop, ResultKind.Rejected, "noop changes nothing; the transition continues"],
        // running has no reducer for reset.
        [reset, ResultKind.Rejected, "reset changes nothing; the transition continues"],
        [hold, ResultKind.Error, leftTransitional],
        // The reducer's own instance keeps the node in running too.
        [keep, ResultKind.Error, leftTransitional],
      ];
      for (const [signal, kind, message] of cases) {
        const r = send(signal(), { abort: true });
        expect(r.kind, message).toBe(kind);
        expect(kind === ResultKind.Error ? r.error?.message : r.message).toBe(message);
      }
      expect(workSignal?.aborted).toBe(false);
      expect(String(t.job)).toBe("job.running(n=0)");

      const first = send(stop(), { abort: true });
      const second = send(stop(), { abort: true });
      expect(first.kind).toBe(ResultKind.InTransition);
      expect(second.kind).toBe(ResultKind.Rejected);
      expect(second.message).toBe("an abort of job is already in progress");
      await flush();
      expect((await original.done()).message).toBe("aborted by stop");
      expect(String(t.job)).toBe("job.stopped(n=0)");
      await send[Symbol.asyncDispose]();
    });

    it("the wait ends when the work settles, and no later than what is left of the timeout; what the work gives after that is dropped and reported on the console, with no entry", async () => {
      const job = defineJob({ timeoutMs: 300 });
      const entries: StateFlowLogEntry[] = [];
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const t = makeWithWork(
        job,
        async function stubborn() {
          await sleep(1000);
          return HandlerResult.ok();
        },
        entries,
      );
      const send = await lock(t);
      const original = send(start());
      await vi.advanceTimersByTimeAsync(100);

      const r = send(stop(), { abort: true });

      await vi.advanceTimersByTimeAsync(199);
      expect(String(t.job)).toBe("job.running(n=0)");
      await vi.advanceTimersByTimeAsync(1);
      expect(String(t.job)).toBe("job.stopped(n=0)");
      expect((await r.done()).kind).toBe(ResultKind.OK);
      expect((await original.done()).message).toBe("aborted by stop");
      await send[Symbol.asyncDispose]();
      await flush();
      expect(entries[1].handlerResults).toEqual([
        expect.objectContaining({
          type: "transition",
          handlerName: "stubborn",
          result: "dropped after abort: unsettled",
        }),
      ]);
      expect(error).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(700);

      expect(String(t.job)).toBe("job.stopped(n=0)");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[SF/Object] transition handler stubborn on job: dropped after abort: OK");
      await flush();
      expect(entries).toHaveLength(2);
    });

    it("sends queued behind the transition are reduced in order after an accepted abort's step", async () => {
      const job = defineJob();
      const t = makeWithWork(job, honouring);
      const send = await lock(t);
      expect(send(start()).kind).toBe(ResultKind.InTransition);
      // Reduced from stopped, the abort's state: reset moves job to idle, then poke bumps it. In the other
      // order poke would be Ignored, because stopped has no poke reducer.
      const resetting = send(reset());
      const poking = send(poke());

      const aborting = send(stop(), { abort: true });

      await flush();
      expect(String(t.job)).toBe("job.idle(n=1)");
      expect((await aborting.done()).kind).toBe(ResultKind.OK);
      expect((await resetting.done()).kind).toBe(ResultKind.OK);
      expect((await poking.done()).kind).toBe(ResultKind.OK);
      await send[Symbol.asyncDispose]();
    });

    it("an accepted abort whose step throws (a string form that throws while it is logged) resolves the abort's done() with the Error, and the queued sends still settle", async () => {
      const job = defineState<{ n: number }>()
        .name("job")
        .signals({ start, stop, poke })
        .variant("idle", { initial: true })
        .variant("running")
        .variant("done", { async: true })
        .variant("failed")
        .variant("stopped")
        .stringRepr((s) => {
          if (s.n === 13) {
            throw new Error("no string form for 13");
          }
          return `n=${s.n}`;
        })
        .build();
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s)),
      });
      defineFlow(job.running, { stop: () => job.stopped({ n: 13 }) });
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) =>
        sm.addTransitionHandler(job.done, async (_next, _snapshot, _prev, _key, signal) => {
          await abortableSleep(1000, signal);
          signal.throwIfAborted();
          return HandlerResult.ok();
        }),
      );
      const send = await lock(target);
      const original = send(start());
      const queued = send(poke());

      const aborting = send(stop(), { abort: true });

      await flush();
      const a = await aborting.done();
      expect(a.kind).toBe(ResultKind.Error);
      expect(a.error?.message).toBe("no string form for 13");
      expect((await original.done()).kind).toBe(ResultKind.Rejected);
      // The throw stopped the abort's commit, so the job stays in running, which has no poke reducer.
      expect(String(target.job)).toBe("job.running(n=0)");
      expect((await queued.done()).kind).toBe(ResultKind.Ignored);
      await send[Symbol.asyncDispose]();
    });

    it("an aborting reducer that declares a new transition starts it, and the holder's dispose and sync() wait for its end", async () => {
      const job = defineJob();
      const entries: StateFlowLogEntry[] = [];
      const t = makeWithWork(
        job,
        async (_next, _snapshot, prev, _key, signal) => {
          // The retry's work, from retrying, takes 100 ms; the first, from running, honours the abort.
          if (String(prev).startsWith("job.retrying")) {
            await sleep(100);
            return HandlerResult.ok();
          }
          await abortableSleep(1000, signal);
          signal.throwIfAborted();
          return HandlerResult.ok();
        },
        entries,
      );
      const holder = await lock(t);
      const original = holder(start());

      const aborting = holder(retry(), { abort: true });
      // Both start waiting while the first transition is still pending; the abort ends it and starts the
      // second, and both must go on waiting for that one.
      let disposed = false;
      const disposing = holder[Symbol.asyncDispose]().then(() => {
        disposed = true;
      });
      let synced = false;
      const syncing = sync(t).then(() => {
        synced = true;
      });

      await flush();
      expect(String(t.job)).toBe("job.retrying(n=0)");
      await vi.advanceTimersByTimeAsync(99);
      expect([disposed, synced]).toEqual([false, false]);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([disposing, syncing]);
      expect(String(t.job)).toBe("job.done(n=10)");
      expect((await aborting.done()).kind).toBe(ResultKind.OK);
      expect((await original.done()).kind).toBe(ResultKind.Rejected);
      await flush();
      expect(entries.map((e) => [e.signal, e.transition, e.aborted])).toEqual([
        ["start{}", "temp", undefined],
        ["retry{}", "temp", "job"],
        ["retry{}", "final", undefined],
      ]);
    });

    it("an aborting reducer whose transition keeps the committed temp as its own temp is accepted: its temp step changes nothing and writes the abort's entry, after the dropped work, and its end writes one of its own", async () => {
      for (const outcome of ["OK", "Rejected: no"] as const) {
        const job = jobShape();
        defineFlow(job.idle, {
          start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s)),
        });
        // running stays while the redo's work runs: it is that transition's temp now.
        defineFlow(job.running, {
          redo: (s, _signal, ctx) => StateResult.transition(job.done({ n: s.n + 10 }), job(ctx), job.failed(s)),
        });
        const entries: StateFlowLogEntry[] = [];
        const t = makeWithWork(
          job,
          async function work(next, _snapshot, _prev, _key, signal) {
            // The start's work honours the abort; the redo's settles after 10 ms.
            if (next.n === 1) {
              await abortableSleep(1000, signal);
              signal.throwIfAborted();
              return HandlerResult.ok();
            }
            await sleep(10);
            return outcome === "OK" ? HandlerResult.ok() : HandlerResult.rejected("no");
          },
          entries,
        );
        const send = await lock(t);
        const started = send(start());
        const running = t.job;

        const redoing = send(redo(), { abort: true });
        await flush();

        expect(redoing.kind, outcome).toBe(ResultKind.InTransition);
        expect((await started.done()).message, outcome).toBe("aborted by redo");
        expect(t.job, outcome).toBe(running);
        await vi.advanceTimersByTimeAsync(10);
        expect(String(await redoing.done()), outcome).toBe(outcome);
        expect(String(t.job), outcome).toBe(outcome === "OK" ? "job.done(n=10)" : "job.failed(n=0)");
        await send[Symbol.asyncDispose]();
        await flush();
        expect(
          entries.map((e) => [e.signal, e.transition, e.aborted, e.stateChanges.length]),
          outcome,
        ).toEqual([
          ["start{}", "temp", undefined, 1],
          ["redo{}", "temp", "job", 0],
          ["redo{}", outcome === "OK" ? "final" : "failed", undefined, 1],
        ]);
        expect(
          entries[1].handlerResults.map((line) => [line.type, line.handlerName, line.result]),
          outcome,
        ).toEqual([["transition", "work", expect.stringMatching(/^dropped after abort: /)]]);
      }
    });

    it("with nothing pending: send dispatches as usual; dispatch too with a free lock, and Rejected under a held lock", async () => {
      const job = defineJob();
      const t = make(job, () => {});
      {
        await using send = await lock(t);
        expect(send(poke(), { abort: true }).kind).toBe(ResultKind.OK);
      }
      expect(String(t.job)).toBe("job.idle(n=1)");
      expect(dispatch(t, poke(), { abort: true }).kind).toBe(ResultKind.OK);
      expect(String(t.job)).toBe("job.idle(n=2)");

      const holder = await lock(t);
      const r = dispatch(t, poke(), { abort: true });

      expect(r.kind).toBe(ResultKind.Rejected);
      expect(r.message).toBe("nothing to abort: no transition is pending and the lock is held");
      expect(String(t.job)).toBe("job.idle(n=2)");
      await holder[Symbol.asyncDispose]();
    });
  });

  describe("a refused abort step", () => {
    it("whose failed face keeps the transitional temp: the aborted transition ends in its failed in the same step and entry, and the abort's other failed states commit with it", async () => {
      const job = defineJob();
      const lamp = defineState<{ n: number }>()
        .name("lamp")
        .signals({ stop })
        .variant("on", { initial: true })
        .variant("off")
        .variant("broken")
        .build();
      defineFlow(lamp.on, { stop: (s) => StateResult.ok(lamp.off(s), lamp.broken(s)) });
      const entries: StateFlowLogEntry[] = [];
      const target = { job: { n: 0 }, lamp: { n: 0 } };
      applyFlow(
        target,
        [job, lamp],
        (sm) => {
          sm.addTransitionHandler(job.done, honouring);
          sm.addEnterHandler(job.stopped, () => HandlerResult.rejected("cannot stop"));
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const send = await lock(target);
      const original = send(start());

      const aborting = send(stop(), { abort: true });

      await flush();
      const a = await aborting.done();
      expect(String(a)).toBe("Rejected: cannot stop");
      expect((await original.done()).message).toBe("aborted by stop");
      expect([String(target.job), String(target.lamp)]).toEqual(["job.failed(n=0)", "lamp.broken(n=0)"]);
      // Nothing is pending, so the holder's send is reduced at once.
      expect(send(reset()).kind).toBe(ResultKind.OK);
      await send[Symbol.asyncDispose]();
      await flush();
      expect(entries[1].aborted).toBe("job");
      expect(entries[1].finalStates).toEqual({ job: "job.failed(n=0)", lamp: "lamp.broken(n=0)" });
    });

    it("ends the aborted transition in its failed and the abort's answers in theirs, which FAILURE gives the refusal of the abort's step as their reason", async () => {
      const job = defineState<{ n: number; reason?: string }>()
        .name("job")
        .signals({ start, stop })
        .variant("idle", { initial: true })
        .variant("running", { transitional: true })
        .variant("done", { async: true })
        .variant("failed")
        .variant("stopped")
        .build();
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s)),
      });
      defineFlow(job.running, { stop: (s) => job.stopped(s) });
      defineFlow(job.failed, {}, { [FAILURE]: (s, { reason }) => ({ ...s, reason }) });
      const lamp = defineState<{ n: number; reason?: string }>()
        .name("lamp")
        .signals({ stop })
        .variant("on", { initial: true })
        .variant("off")
        .variant("broken")
        .build();
      defineFlow(lamp.on, { stop: (s) => StateResult.ok(lamp.off(s), lamp.broken(s)) });
      defineFlow(lamp.broken, {}, { [FAILURE]: (s, { reason }) => ({ ...s, reason }) });
      const target = { job: { n: 0 }, lamp: { n: 0 } };
      applyFlow(target, [job, lamp], (sm) => {
        sm.addTransitionHandler(job.done, async (_next, _snapshot, _prev, _key, signal) => {
          await abortableSleep(1000, signal);
          signal.throwIfAborted();
          return HandlerResult.ok();
        });
        sm.addEnterHandler(job.stopped, () => HandlerResult.rejected("cannot stop"));
      });
      const typed = target as unknown as { job: InstanceOf<typeof job>; lamp: InstanceOf<typeof lamp> };
      const send = await lock(target);
      send(start());

      const aborting = send(stop(), { abort: true });
      await flush();

      expect(String(await aborting.done())).toBe("Rejected: cannot stop");
      expect([stateVar(typed.job), typed.job.reason]).toEqual([job.failed, "cannot stop"]);
      expect([stateVar(typed.lamp), typed.lamp.reason]).toEqual([lamp.broken, "cannot stop"]);
      await send[Symbol.asyncDispose]();
    });

    /** A lamp that stop switches off, going to broken when its step is refused; broken records its FAILURE data. */
    function defineLamp(seen: Array<[string, unknown]>) {
      const lamp = defineState<{ n: number }>()
        .name("lamp")
        .signals({ stop })
        .variant("on", { initial: true })
        .variant("off")
        .variant("broken")
        .build();
      defineFlow(lamp.on, { stop: (s) => StateResult.ok(lamp.off(s), lamp.broken(s)) });
      defineFlow(
        lamp.broken,
        {},
        {
          [FAILURE]: (s, failure) => {
            seen.push(["lamp", failure]);
            return s;
          },
        },
      );
      return lamp;
    }

    const stopBoom = new Error("cannot stop");
    it.each([
      ["a Rejected", (): HandlerResult => HandlerResult.rejected("cannot stop"), undefined],
      [
        "a throw",
        (): HandlerResult => {
          throw stopBoom;
        },
        stopBoom,
      ],
    ] as const)("refused by %s while the temp is transitional and the abort's answer there names no failed: FAILURE is of kind aborted for every node the step enters, the aborted transition's failed and the abort's answers' alike, with the refusal's reason and error", async (_what, refuse, error) => {
      const seen: Array<[string, unknown]> = [];
      const job = jobShape();
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed(s)),
      });
      defineFlow(job.running, { stop: (s) => job.stopped(s) });
      defineFlow(
        job.failed,
        {},
        {
          [FAILURE]: (s, failure) => {
            seen.push(["job", failure]);
            return s;
          },
        },
      );
      const lamp = defineLamp(seen);
      const target = { job: { n: 0 }, lamp: { n: 0 } };
      applyFlow(target, [job, lamp], (sm) => {
        sm.addTransitionHandler(job.done, honouring);
        sm.addEnterHandler(job.stopped, refuse);
      });
      const send = await lock(target);
      const original = send(start());

      const aborting = send(stop(), { abort: true });
      await flush();
      await aborting.done();

      expect([String(target.job), String(target.lamp)]).toEqual(["job.failed(n=0)", "lamp.broken(n=0)"]);
      const data = { kind: "aborted", reason: "cannot stop", error };
      expect(seen).toEqual([
        ["job", data],
        ["lamp", data],
      ]);
      expect((seen[0]?.[1] as { error: unknown }).error).toBe(error);
      expect((await original.done()).message).toBe("aborted by stop");
      await send[Symbol.asyncDispose]();
    });

    it("refused while the temp is an ordinary variant, which stays: the step ends no transition, so FAILURE gives the abort's answers the refusal's own kind", async () => {
      const seen: Array<[string, unknown]> = [];
      const job = jobShape();
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.stopped(s), job.failed(s)),
      });
      defineFlow(job.stopped, { stop: (s) => job.idle({ n: s.n + 5 }) });
      const lamp = defineLamp(seen);
      const target = { job: { n: 0 }, lamp: { n: 0 } };
      applyFlow(target, [job, lamp], (sm) => {
        sm.addTransitionHandler(job.done, honouring);
        sm.addEnterHandler(job.idle, () => HandlerResult.rejected("cannot go back"));
      });
      const send = await lock(target);
      const original = send(start());

      const aborting = send(stop(), { abort: true });
      await flush();

      expect(String(await aborting.done())).toBe("Rejected: cannot go back");
      expect((await original.done()).message).toBe("aborted by stop");
      expect([String(target.job), String(target.lamp)]).toEqual(["job.stopped(n=0)", "lamp.broken(n=0)"]);
      expect(seen).toEqual([["lamp", { kind: "rejected", reason: "cannot go back", error: undefined }]]);
      await send[Symbol.asyncDispose]();
    });

    it("whose temp is an ordinary variant: the temp may stay, and nothing is pending", async () => {
      const job = jobShape();
      // A temp of the ordinary stopped, so a refused abort may leave the node there.
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.stopped(s), job.failed(s)),
      });
      defineFlow(job.stopped, {
        stop: (s) => job.idle({ n: s.n + 5 }),
        poke: (s) => ({ n: s.n + 1 }),
        keep: (_s, _signal, ctx) => StateResult.ok(job(ctx)),
      });
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) => {
        sm.addTransitionHandler(job.done, honouring);
        sm.addEnterHandler(job.idle, () => HandlerResult.rejected("cannot go back"));
      });
      const typed = target as unknown as Target;
      const send = await lock(target);
      const original = send(start());
      // Its own instance commits nothing, so this abort is refused as one that changes nothing.
      expect(send(keep(), { abort: true }).message).toBe("keep changes nothing; the transition continues");

      const aborting = send(stop(), { abort: true });
      await flush();

      expect(String(await aborting.done())).toBe("Rejected: cannot go back");
      expect((await original.done()).message).toBe("aborted by stop");
      expect(String(typed.job)).toBe("job.stopped(n=0)");
      expect(send(poke()).kind).toBe(ResultKind.OK);
      await send[Symbol.asyncDispose]();
    });

    it("whose failed is the temp as it committed: the failed step gives it no call, so the temp stays with the exit the refused step ran done, and nothing is pending", async () => {
      const job = jobShape();
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.stopped(s), job.failed(s)),
      });
      // The abort's failed is the node's own instance, the temp: the failed step keeps it.
      defineFlow(job.stopped, { stop: (s, _signal, ctx) => StateResult.ok(job.idle({ n: s.n + 5 }), job(ctx)) });
      const calls: string[] = [];
      const target = { job: { n: 0 } };
      applyFlow(target, [job], (sm) => {
        sm.addTransitionHandler(job.done, honouring);
        sm.addEnterHandler(job.stopped, (s) => {
          calls.push(`enter ${String(s)}`);
          return HandlerResult.ok();
        });
        sm.addExitHandler(job.stopped, (s) => {
          calls.push(`exit ${String(s)}`);
          return HandlerResult.ok();
        });
        sm.addEnterHandler(job.idle, () => HandlerResult.rejected("cannot go back"));
      });
      const send = await lock(target);
      send(start());

      const aborting = send(stop(), { abort: true });
      await flush();

      expect(String(await aborting.done())).toBe("Rejected: cannot go back");
      expect(String((target as unknown as Target).job)).toBe("job.stopped(n=0)");
      // The temp step entered stopped; the abort's refused step exited it.
      expect(calls).toEqual(["enter job.stopped(n=0)", "exit job.stopped(n=0)"]);
      expect(send(stop()).kind).toBe(ResultKind.Rejected);
      await send[Symbol.asyncDispose]();
    });

    it("whose failed face keeps the temp of a transition that itself aborted another: that transition ends in its failed, and the one it aborted in turn is left alone", async () => {
      const job = jobShape();
      // start's failed (n=1) would commit only if the failed end of start, the transition retry aborted, were reached.
      defineFlow(job.idle, {
        start: (s) => StateResult.transition(job.done({ n: s.n + 1 }), job.running(s), job.failed({ n: 1 })),
      });
      defineFlow(job.running, {
        retry: (s) => StateResult.transition(job.done({ n: s.n + 10 }), job.retrying(s), job.failed({ n: 7 })),
      });
      defineFlow(job.retrying, { stop: (s) => job.stopped(s) });
      const entries: StateFlowLogEntry[] = [];
      const t = make(
        job,
        (sm) => {
          sm.addTransitionHandler(job.done, honouring);
          sm.addEnterHandler(job.stopped, () => HandlerResult.rejected("cannot stop"));
        },
        entries,
      );
      const send = await lock(t);
      const started = send(start());
      const retried = send(retry(), { abort: true });
      await flush();
      expect(String(t.job)).toBe("job.retrying(n=0)");

      const stopping = send(stop(), { abort: true });
      await flush();

      expect(String(await stopping.done())).toBe("Rejected: cannot stop");
      expect((await retried.done()).message).toBe("aborted by stop");
      expect((await started.done()).message).toBe("aborted by retry");
      expect(String(t.job)).toBe("job.failed(n=7)");
      await send[Symbol.asyncDispose]();
      await flush();
      expect(entries.map((e) => [e.transition, e.aborted, e.finalStates])).toEqual([
        ["temp", undefined, { job: "job.running(n=0)" }],
        ["temp", "job", { job: "job.retrying(n=0)" }],
        [undefined, "job", { job: "job.failed(n=7)" }],
      ]);
    });

    it("of an abort that a transitional child and its parent both answer, the parent with failed: with the child's own failed, the plan accepts and the parent's failed holds it; with none, the abort is an Error and the transition continues", async () => {
      const add = defineSignal("add");
      const close = defineSignal("close");
      for (const childFailed of ["an instance", "none"] as const) {
        const producer = defineState<{ id: string }>()
          .name("producer")
          .signals({ close })
          .variant("idle", { initial: true })
          .variant("creating", { transitional: true })
          .variant("active", { async: true })
          .variant("closed")
          .variant("failed")
          .build();
        defineFlow(producer.creating, {
          close: (p) =>
            childFailed === "an instance" ? StateResult.ok(producer.closed(p), producer.failed(p)) : producer.closed(p),
        });
        const media = defineState<{ producer: InstanceOf<typeof producer> }>()
          .name("media")
          .signals({ add, close })
          .variant("idle", { initial: true })
          .variant("active")
          .variant("broken")
          .build();
        defineFlow(media.idle, {
          add: (m) =>
            StateResult.transition(
              media.active({ producer: producer.active(m.producer) }),
              media.active({ producer: producer.creating(m.producer) }),
              media.idle(m),
            ),
        });
        // Both keep the producer, whose own reducer answers too.
        defineFlow(media.active, { close: (m) => StateResult.ok(media.idle(m), media.broken(m)) });
        let workSignal: AbortSignal | undefined;
        const target = { media: { producer: producer.idle({ id: "cam" }) } };
        applyFlow(target, [media], (sm) => {
          sm.addTransitionHandler(producer.active, async (_next, _snapshot, _prev, _key, signal) => {
            workSignal = signal;
            await abortableSleep(1000, signal);
            signal.throwIfAborted();
            return HandlerResult.ok();
          });
          sm.addEnterHandler(media.idle, () => HandlerResult.rejected("cannot close"));
        });
        const typed = target as unknown as { media: InstanceOf<typeof media> };
        const send = await lock(target);
        send(add());

        const closing = send(close(), { abort: true });
        await flush();

        if (childFailed === "an instance") {
          expect(String(await closing.done())).toBe("Rejected: cannot close");
          expect(String(typed.media)).toBe("media.broken(producer=producer.failed(id=cam))");
        } else {
          expect(closing.kind, childFailed).toBe(ResultKind.Error);
          expect(closing.error?.message, childFailed).toBe(
            "media: its failed media.broken(producer=producer.creating(id=cam)) would leave media.producer in a transitional variant [SF022] Declare a failed that holds no transitional variant.; the transition continues [SF039] Fix the reducer's error named in the message.",
          );
          expect(workSignal?.aborted, childFailed).toBe(false);
          expect(String(typed.media), childFailed).toBe("media.active(producer=producer.creating(id=cam))");
          disposeFlow(target);
        }
        await send[Symbol.asyncDispose]();
      }
    });
  });

  describe("dropped work", () => {
    it("a work the abort waits for, with the flow disposed during that wait: nothing is reported when it settles", async () => {
      const job = defineJob({ timeoutMs: 300 });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const t = makeWithWork(job, async () => {
        await sleep(1000);
        return HandlerResult.ok();
      });
      const holder = await lock(t);
      holder(start());
      dispatch(t, stop(), { abort: true });

      disposeFlow(t);
      await vi.advanceTimersByTimeAsync(1000);

      expect(error).not.toHaveBeenCalled();
      await holder[Symbol.asyncDispose]();
    });

    it("a work that settles after disposeFlow is dropped with no word", async () => {
      const job = defineJob();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const entries: StateFlowLogEntry[] = [];
      const t = makeWithWork(
        job,
        async () => {
          await sleep(100);
          return HandlerResult.ok();
        },
        entries,
      );
      dispatch(t, start());

      disposeFlow(t);
      await vi.advanceTimersByTimeAsync(100);

      expect(error).not.toHaveBeenCalled();
      await flush();
      expect(entries.map((e) => e.transition)).toEqual(["temp"]);
    });
  });

  describe("disposeFlow", () => {
    // toThrow given an Error instance compares the message only, so the class is checked on its own.
    const throwsStateFlowError = (call: () => unknown, message: string): void => {
      expect(call).toThrow(StateFlowError);
      expect(call).toThrow(message);
    };

    it("during the work: nothing more commits or is logged, done() is an Error, queued sends are Errors, and the signal aborts last with 'flow disposed'", async () => {
      const job = defineJob();
      const entries: StateFlowLogEntry[] = [];
      let workSignal: AbortSignal | undefined;
      let tornDownAtAbort: boolean | undefined;
      const t: Target = makeWithWork(
        job,
        async (_next, _snapshot, _prev, _key, signal) => {
          workSignal = signal;
          signal.addEventListener("abort", () => {
            tornDownAtAbort = !Reflect.has(t, "job");
          });
          await sleep(1000);
          return HandlerResult.ok();
        },
        entries,
      );
      const holder = await lock(t);
      const original = holder(start());
      const queued = holder(poke());

      disposeFlow(t);

      expect(workSignal?.reason).toBeInstanceOf(TransitionAborted);
      expect(workSignal?.reason).toMatchObject({
        kind: "disposed",
        message: "flow disposed [SF046] Stop the work on abort and release what it acquired.",
      });
      expect(tornDownAtAbort).toBe(true);
      const was = await original.done();
      expect(was.kind).toBe(ResultKind.Error);
      expect(was.error?.message).toBe(
        "flow disposed during the transition of job to job.done [SF044] Expect it when the object may be disposed during a transition.",
      );
      const q = await queued.done();
      expect(q.kind).toBe(ResultKind.Error);
      expect(q.error?.message).toBe(
        "flow disposed before poke was reduced [SF045] Expect it when the object may be disposed while sends are queued.",
      );
      // Neither the work's late OK nor the timeout (500 ms by default) commits or logs anything.
      await vi.advanceTimersByTimeAsync(1000);
      expect(Reflect.has(t, "job")).toBe(false);
      expect(entries.map((e) => e.transition)).toEqual(["temp"]);
      await holder[Symbol.asyncDispose]();
    });

    it("during an abort's wait: the wait ends at once, no step runs, the signal keeps 'aborted by', and both done() resolve to the dispose's Errors", async () => {
      const job = defineJob({ timeoutMs: 5000 });
      let workSignal: AbortSignal | undefined;
      // Ignores its signal and never settles, so only the dispose can end the abort's wait before the deadline.
      const t = makeWithWork(job, (_next, _snapshot, _prev, _key, signal) => {
        workSignal = signal;
        return new Promise<HandlerResult>(() => {});
      });
      const holder = await lock(t);
      const original = holder(start());
      const aborting = holder(stop(), { abort: true });
      expect(aborting.kind).toBe(ResultKind.InTransition);
      let abortEnded = false;
      aborting.done().then(() => {
        abortEnded = true;
      });

      disposeFlow(t);
      await flush();

      expect(abortEnded).toBe(true);
      // The transition's timer, which the wait took over, went with it.
      expect(vi.getTimerCount()).toBe(0);
      expect(workSignal?.reason).toMatchObject({
        kind: "aborted",
        message:
          "aborted by stop [SF040] Stop the work on abort and release what it acquired; expect Rejected where an abort may come.",
      });
      const a = await aborting.done();
      expect(a.kind).toBe(ResultKind.Error);
      expect(a.error?.message).toBe(
        "flow disposed during the abort of job [SF041] Expect it when the object may be disposed during an abort.",
      );
      const o = await original.done();
      expect(o.kind).toBe(ResultKind.Error);
      expect(o.error?.message).toBe(
        "flow disposed during the transition of job to job.done [SF044] Expect it when the object may be disposed during a transition.",
      );
      // No step ran: the teardown removed the state and nothing put stopped in its place.
      expect(Reflect.has(t, "job")).toBe(false);
      await holder[Symbol.asyncDispose]();
    });

    it("a listener of the signal that disposes the target again meets a no-op; one of a timed-out work runs after failed committed and the queue drained", async () => {
      let seen: string | undefined;
      const job = defineJob({ timeoutMs: 100 });
      const t: Target = makeWithWork(job, async (_next, _snapshot, _prev, _key, signal) => {
        signal.addEventListener("abort", () => {
          seen = String(t.job);
        });
        await sleep(1000);
        return HandlerResult.ok();
      });
      const holder = await lock(t);
      expect(holder(start()).kind).toBe(ResultKind.InTransition);
      // Queued behind the transition; failed has a reset reducer, so the drain moves job back to idle.
      const queued = holder(reset());

      await vi.advanceTimersByTimeAsync(100);

      expect(seen).toBe("job.idle(n=0)");
      expect((await queued.done()).kind).toBe(ResultKind.OK);
      await holder[Symbol.asyncDispose]();

      // What the listener's disposeFlow did: "not called" until it runs, then null when it returned, or its throw.
      let secondDispose: unknown = "not called";
      const job2 = defineJob();
      const t2: Target = makeWithWork(job2, async (_next, _snapshot, _prev, _key, signal) => {
        signal.addEventListener("abort", () => {
          try {
            disposeFlow(t2);
            secondDispose = null;
          } catch (e) {
            secondDispose = e;
          }
        });
        await sleep(1000);
        return HandlerResult.ok();
      });
      expect(dispatch(t2, start()).kind).toBe(ResultKind.InTransition);

      expect(() => disposeFlow(t2)).not.toThrow();
      expect(secondDispose).toBeNull();
      expect(Reflect.has(t2, "job")).toBe(false);
    });

    it("after the teardown a second disposeFlow is a no-op, every send answers Rejected naming the flow as disposed and logs nothing, a send of a lock taken before and an abort included, lock resolves at once to such a sender, and a dispatch, sync, observe and subscribeFlow throw a StateFlowError naming it so", async () => {
      const job = defineJob();
      const entries: StateFlowLogEntry[] = [];
      const t = make(job, () => {}, entries);
      const send = await lock(t);
      disposeFlow(t);

      const disposed = "Object is disposed";
      expect(() => disposeFlow(t)).not.toThrow();
      throwsStateFlowError(() => dispatch(t, poke()), disposed);
      await expect(sync(t)).rejects.toThrow(StateFlowError);
      await expect(sync(t)).rejects.toThrow(disposed);
      throwsStateFlowError(() => observe(t, [job.idle], () => {}), disposed);
      throwsStateFlowError(() => subscribeFlow(t, () => {}), disposed);

      // The lock taken before the dispose: its sends answer Rejected, an abort's too.
      const held = send(poke());
      expect(held.kind).toBe(ResultKind.Rejected);
      expect(held.message).toBe(disposed);
      expect(await held.done()).toBe(held);
      throwsStateFlowError(() => send(poke()).expect(ResultKind.OK), disposed);
      const abort = send(poke(), { abort: true });
      expect(abort.kind).toBe(ResultKind.Rejected);
      expect(abort.message).toBe(disposed);

      // lock() does not wait for the holder above: the sender holds no lock, so its release does nothing.
      const late = await lock(t);
      const answered = late(poke());
      expect(answered.kind).toBe(ResultKind.Rejected);
      expect(answered.message).toBe(disposed);
      throwsStateFlowError(() => late(poke()).expect(ResultKind.OK), disposed);
      await late[Symbol.asyncDispose]();
      expect(late(poke()).kind).toBe(ResultKind.Rejected);
      expect(entries).toEqual([]);

      // The holder can still release the lock it took.
      await send[Symbol.asyncDispose]();
    });

    it("a target that was never applied is no flow: disposeFlow and dispatch throw, and lock rejects with, a StateFlowError that says so", async () => {
      const notAFlow = "Object doesn't contain state flows";
      throwsStateFlowError(() => disposeFlow({}), notAFlow);
      throwsStateFlowError(() => dispatch({}, poke()), notAFlow);
      await expect(lock({})).rejects.toThrow(StateFlowError);
      await expect(lock({})).rejects.toThrow(notAFlow);
    });

    it("an observer disposed after the teardown is a no-op", () => {
      const job = defineJob();
      const t = make(job, () => {});
      const observer = observe(t, [job.idle], () => {});
      disposeFlow(t);

      expect(() => observer[Symbol.dispose]()).not.toThrow();
    });
  });
});
