import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  disposeFlow,
  type FlowConfig,
  HandlerResult,
  lock,
  observe,
  ResultKind,
  type StateInstance,
  StateResult,
  stateVar,
  subscribeFlow,
  type TransitionAborted,
  type TransitionHandler,
} from "..";

/**
 * FlowConfig.timers: every timer of a flow goes through the timers its config names, so a simulation controls time
 * without faking globals. A declared transition times out when that clock reaches its timeout, an accepted abort
 * waits for the work no longer than what is left of the timeout on that clock, and observers and subscribers are
 * delivered on its turns. Absent, the flow uses the global setTimeout and clearTimeout, looked up at each call.
 */
describe("FlowConfig.timers", () => {
  /**
   * Timers on a clock that moves only when the test calls advance(). Its methods read `this`, so every test also
   * checks that the engine calls them as methods of the object the config names.
   */
  class ManualClock {
    #now = 0;
    #timers = new Set<{ at: number; callback: () => void }>();

    setTimeout(callback: () => void, ms: number): unknown {
      const timer = { at: this.#now + ms, callback };
      this.#timers.add(timer);
      return timer;
    }

    clearTimeout(timer: unknown): void {
      this.#timers.delete(timer as { at: number; callback: () => void });
    }

    /** Moves the clock `ms` forward, running each timer that falls due on the way, earliest first. */
    advance(ms: number): void {
      const until = this.#now + ms;
      for (let due = this.#next(until); due !== undefined; due = this.#next(until)) {
        this.#timers.delete(due);
        this.#now = due.at;
        due.callback();
      }
      this.#now = until;
    }

    /** The timers set and neither run nor cleared. */
    get size(): number {
      return this.#timers.size;
    }

    #next(until: number) {
      // A stable sort keeps timers due at the same time in the order they were set.
      return [...this.#timers].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
    }
  }

  const start = defineSignal("start");
  const stop = defineSignal("stop");
  const tick = defineSignal("tick");

  const job = defineState<{ n: number }>()
    .name("job")
    .signals({ start, stop, tick })
    .variant("idle", { initial: true })
    .variant("running", { transitional: true })
    .variant("done", { async: true })
    .variant("failed")
    .variant("stopped")
    .build();
  defineFlow(job.idle, {
    start: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s), { timeoutMs: 100 }),
    tick: (s) => ({ n: s.n + 1 }),
  });
  defineFlow(job.running, { stop: (s) => job.stopped(s) });

  type Target = { job: StateInstance<{ n: number }> };

  /** A target on `timers` whose transition into done has `work` as its work. */
  function make(timers: FlowConfig["timers"], work: TransitionHandler<typeof job.done>): Target {
    const target = { job: { n: 0 } };
    applyFlow(target, [job], (sm) => sm.addTransitionHandler(job.done, work), { timers });
    return target as unknown as Target;
  }

  /** A work that ignores its signal and never settles. */
  const never: TransitionHandler<typeof job.done> = () => new Promise<HandlerResult>(() => {});

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a declared transition times out when the flow's timers reach its timeout, whatever the global clock does", async () => {
    vi.useFakeTimers();
    const clock = new ManualClock();
    let signal: AbortSignal | undefined;
    const target = make(clock, (_next, _snapshot, _prev, _key, s) => {
      signal = s;
      return new Promise<HandlerResult>(() => {});
    });
    await using send = await lock(target);
    const started = send(start());

    // The global clock, Date included, passes the timeout, and the flow's clock comes 1 ms short of it.
    await vi.advanceTimersByTimeAsync(1000);
    clock.advance(99);
    expect(stateVar(target.job)).toBe(job.running);

    clock.advance(1);
    const outcome = await started.done();
    expect(outcome.kind).toBe(ResultKind.Error);
    expect((outcome.error as TransitionAborted).kind).toBe("timeout");
    expect(stateVar(target.job)).toBe(job.failed);
    expect((signal?.reason as TransitionAborted).kind).toBe("timeout");
  });

  it("every other end clears the timer through the flow's timers: the work's result or refusal, an abort the work wins, and disposeFlow", async () => {
    const clock = new ManualClock();
    let finish: (result: HandlerResult) => void = () => {};
    const settling = make(clock, () => new Promise<HandlerResult>((resolve) => (finish = resolve)));
    {
      await using send = await lock(settling);
      const started = send(start());
      expect(clock.size).toBe(1);
      finish(HandlerResult.ok());
      expect((await started.done()).kind).toBe(ResultKind.OK);
      expect(stateVar(settling.job)).toBe(job.done);
      expect(clock.size).toBe(0);
    }

    const refused = make(clock, async () => HandlerResult.rejected("no route"));
    {
      await using send = await lock(refused);
      const started = send(start());
      expect(clock.size).toBe(1);
      expect((await started.done()).kind).toBe(ResultKind.Rejected);
      expect(clock.size).toBe(0);
    }

    // The work rejects as soon as the abort aborts its signal, long before the deadline.
    const honouring = make(
      clock,
      (_next, _snapshot, _prev, _key, s) =>
        new Promise<HandlerResult>((_resolve, reject) => s.addEventListener("abort", () => reject(s.reason))),
    );
    {
      await using send = await lock(honouring);
      send(start());
      expect(clock.size).toBe(1);
      expect((await send(stop(), { abort: true }).done()).kind).toBe(ResultKind.OK);
      expect(clock.size).toBe(0);
    }

    const disposed = make(clock, never);
    const send = await lock(disposed);
    const started = send(start());
    expect(clock.size).toBe(1);
    disposeFlow(disposed);
    expect(clock.size).toBe(0);
    expect((await started.done()).kind).toBe(ResultKind.Error);
  });

  it("an accepted abort waits for the work no longer than what is left of the timeout on the flow's timers", async () => {
    vi.useFakeTimers();
    const clock = new ManualClock();
    const target = make(clock, never);
    await using send = await lock(target);
    const started = send(start());
    clock.advance(60);

    const stopping = send(stop(), { abort: true });
    expect(stopping.kind).toBe(ResultKind.InTransition);
    // The global clock, Date included, passes the deadline, and the flow's clock comes 1 ms short of it.
    await vi.advanceTimersByTimeAsync(1000);
    clock.advance(39);
    expect(stateVar(target.job)).toBe(job.running);

    clock.advance(1);
    expect((await stopping.done()).kind).toBe(ResultKind.OK);
    expect(stateVar(target.job)).toBe(job.stopped);
    expect((await started.done()).message).toBe("aborted by stop");
    expect(clock.size).toBe(0);
  });

  it("a timer that falls due inside a work's abort listener ends the abort's wait, not the transition", async () => {
    // The global clock stands still, so only the flow's clock can end the wait.
    vi.useFakeTimers();
    const clock = new ManualClock();
    const target = make(clock, (_next, _snapshot, _prev, _key, s) => {
      s.addEventListener("abort", () => clock.advance(100)); // the world's cancel takes the rest of the timeout
      return new Promise<HandlerResult>(() => {});
    });
    await using send = await lock(target);
    const started = send(start());

    expect((await send(stop(), { abort: true }).done()).kind).toBe(ResultKind.OK);
    expect(stateVar(target.job)).toBe(job.stopped);
    expect((await started.done()).message).toBe("aborted by stop");
  });

  it("observers and subscribers are delivered on turns of the flow's timers", async () => {
    const clock = new ManualClock();
    const target = make(clock, never);
    const observed: number[] = [];
    const subscribed: string[] = [];
    using _observer = observe(target, [job.idle], (s) => observed.push(s.n));
    using _subscriber = subscribeFlow(target, (change) => subscribed.push(change.nextVariant));
    await using send = await lock(target);
    send(tick()).expect(ResultKind.OK);

    // A turn of the global timers passes: nothing is delivered before the flow's clock runs its own.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toEqual([]);
    expect(subscribed).toEqual([]);

    clock.advance(0);
    expect(observed).toEqual([1]);
    expect(subscribed).toEqual(["idle"]);
  });

  it("without timers, the global setTimeout is looked up at each call: fake timers installed after applyFlow apply", async () => {
    const target = make(undefined, never);
    vi.useFakeTimers();
    await using send = await lock(target);
    const started = send(start());

    await vi.advanceTimersByTimeAsync(100);
    expect(stateVar(target.job)).toBe(job.failed);
    expect(((await started.done()).error as TransitionAborted).kind).toBe("timeout");
  });
});
