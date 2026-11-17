import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addFlowTap,
  addGlobalLogHandler,
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  type FlowTapStep,
  HandlerResult,
  lock,
  observe,
  type StateFlowLogEntry,
  type StateInstance,
  type StateManager,
  StateResult,
} from "..";
import { writeTapLines } from "./fixtures/tap-lines";

/**
 * A tap's `ended` is told once for every log entry a dispatch would write, a muted one's too, once the step and its
 * commit handlers ran: so every `dispatched` is followed by one `ended` of the same signal, and a declared
 * transition's end adds one more. Each test pins the order of the three tellings in one
 * case, as the lines of fixtures/tap-lines.ts write them.
 */
describe("FlowTap.ended", () => {
  const go = defineSignal("go");
  const deny = defineSignal("deny");
  const risky = defineSignal("risky");
  const start = defineSignal("start");
  const slow = defineSignal("slow");
  const back = defineSignal("back");

  const job = defineState<{ n: number }>()
    .name("job")
    .signals({ go, deny, risky, start, slow, back })
    .variant("off", { initial: true })
    .variant("on")
    .variant("busy")
    .variant("ready", { async: true })
    .variant("failed")
    .build();
  defineFlow(job.off, {
    go: (s) => job.on({ n: s.n + 1 }),
    deny: () => StateResult.rejected("denied"),
    risky: (s) => StateResult.ok(job.on({ n: s.n + 1 }), job.failed(s)),
    start: (s) => StateResult.transition(job.ready({ n: s.n + 1 }), job.busy(s), job.failed(s)),
    slow: (s) => StateResult.transition(job.ready({ n: s.n + 1 }), job.busy(s), job.failed(s), { timeoutMs: 5 }),
  });
  // An abort of the transition with back, sent while busy, goes back to off; go has no reducer there, so an abort
  // with it is refused.
  defineFlow(job.busy, { back: (s) => job.off(s) });

  type Target = { job: StateInstance<{ n: number }> };

  function make(init: (sm: StateManager) => void = () => {}): Target {
    const target = { job: { n: 0 } };
    applyFlow(target, [job], init);
    return target as unknown as Target;
  }

  /** A work that settles with what `settle` is given. */
  function deferredWork(): { work: () => Promise<HandlerResult>; settle: (result: HandlerResult) => void } {
    let settle: (result: HandlerResult) => void = () => {};
    const promise = new Promise<HandlerResult>((resolve) => {
      settle = resolve;
    });
    return { work: () => promise, settle: (result) => settle(result) };
  }

  /** A work that never answers until its signal aborts, then rejects with the signal's reason, as fetch does. */
  const answersAbort = (_next: unknown, _to: unknown, _prev: unknown, _key: unknown, signal: AbortSignal) =>
    new Promise<HandlerResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const removers: (() => void)[] = [];
  afterEach(() => {
    for (const remove of removers.splice(0)) {
      remove();
    }
    vi.restoreAllMocks();
  });

  /** The lines of every telling from now on. */
  function tapLines(): string[] {
    const lines: string[] = [];
    removers.push(writeTapLines(lines));
    return lines;
  }

  /** Every step `ended` is told of `target`, as the tap gets it. */
  function endedSteps(target: object): FlowTapStep[] {
    const steps: FlowTapStep[] = [];
    removers.push(
      addFlowTap({
        dispatched: () => {},
        handled: () => {},
        ended: (t, step) => {
          if (t === target) {
            steps.push(step);
          }
        },
      }),
    );
    return steps;
  }

  it("a plain step: dispatched, its handlers, then ended with what it committed, before the dispatch returns", () => {
    const target = make((sm) => sm.addEnterHandler(job.on, () => HandlerResult.ok()));
    const lines = tapLines();
    const steps = endedSteps(target);

    const result = dispatch(target, go());

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 go{}",
        "#1 handled enter c1 job job.on: OK",
        "#1 ended s1 go{}: OK | changes job job.off->job.on",
      ]
    `);
    expect(steps[0].result).toBe(result);
    expect(steps[0].changes[0].next).toBe(target.job);
  });

  it("is told after the step's commit handlers, under the step guard", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    const target = make((sm) => sm.addCommitHandler(job.on, () => void order.push("commit handler")));
    removers.push(
      addFlowTap({
        dispatched: () => {},
        handled: () => {},
        ended: () => {
          order.push("ended");
          dispatch(target, go());
        },
      }),
    );

    dispatch(target, go());

    expect(order).toEqual(["commit handler", "ended"]);
    expect(String(error.mock.calls[0][1])).toContain("from inside its own dispatch");
  });

  it("a step its reducers refuse, and one they ignore: dispatched, then ended with nothing committed", () => {
    const target = make();
    const lines = tapLines();

    dispatch(target, deny());
    dispatch(target, back());

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 deny{}",
        "#1 ended s1 deny{}: Rejected: denied",
        "#1 dispatched s2 back{}",
        "#1 ended s2 back{}: Ignored: no reducer for back in job.off",
      ]
    `);
  });

  it("a step a handler refuses whose failed step commits: the refused step's handlers, the failed step's, then ended with the failed step's changes", () => {
    const target = make((sm) => {
      sm.addEnterHandler(job.on, () => HandlerResult.rejected("no"));
      sm.addEnterHandler(job.failed, () => HandlerResult.ok());
    });
    const lines = tapLines();

    dispatch(target, risky());

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 risky{}",
        "#1 handled enter c1 job job.on: Rejected: no",
        "#1 handled enter c2 job job.failed: OK",
        "#1 ended s1 risky{}: Rejected: no | changes job job.off->job.failed",
      ]
    `);
  });

  it("a declared transition with work: ended temp, the work, then one more ended, final, with no dispatched", async () => {
    const { work, settle } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(job.ready, work));
    const lines = tapLines();
    const steps = endedSteps(target);
    const signal = start();

    const result = dispatch(target, signal);
    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 start{}",
        "#1 ended s1 start{} temp: InTransition | changes job job.off->job.busy",
      ]
    `);
    settle(HandlerResult.ok());
    const end = await result.done();

    expect(lines.slice(2)).toMatchInlineSnapshot(`
      [
        "#1 handled transition c1 job job.ready: OK",
        "#1 ended s1 start{} final: OK | changes job job.busy->job.ready",
      ]
    `);
    expect(steps.map((step) => step.signal)).toEqual([signal, signal]);
    expect(steps[1].result).toBe(end);
  });

  it("a declared transition with no work: its end is told inside the send, after its temp", () => {
    const target = make();
    const lines = tapLines();

    const result = dispatch(target, start());

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 start{}",
        "#1 ended s1 start{} temp: InTransition | changes job job.off->job.busy",
        "#1 ended s1 start{} final: OK | changes job job.busy->job.ready",
      ]
    `);
    expect(String(result)).toBe("OK");
  });

  it("a timeout lists the unsettled work, and its late answer is told to handled after that ended, with the same call", async () => {
    const { work, settle } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(job.ready, work));
    const lines = tapLines();
    const steps = endedSteps(target);
    let late: unknown = null;
    removers.push(
      addFlowTap({
        dispatched: () => {},
        handled: (_t, _kind, call) => {
          late = call;
        },
        ended: () => {},
      }),
    );

    dispatch(target, slow());
    await wait(20);
    settle(HandlerResult.ok());
    await wait(0);

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 slow{}",
        "#1 ended s1 slow{} temp: InTransition | changes job job.off->job.busy",
        "#1 ended s1 slow{} failed: TransitionAborted: job did not reach job.ready within 5 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort. | changes job job.busy->job.failed | unsettled c1 job",
        "#1 handled transition c1 job job.ready: OK",
      ]
    `);
    expect(steps[1].result.code).toBe("SF035");
    expect(steps[1].unsettled[0]).toBe(late);
  });

  it("a work's refusal while another work is unsettled: the refusal, ended failed listing the other, then its late answer", async () => {
    const other = deferredWork();
    const target = make((sm) => {
      sm.addTransitionHandler(job.ready, async () => HandlerResult.rejected("no"));
      sm.addTransitionHandler(job.ready, other.work);
    });
    const lines = tapLines();

    dispatch(target, start());
    await wait(0);
    other.settle(HandlerResult.ok());
    await wait(0);

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 start{}",
        "#1 ended s1 start{} temp: InTransition | changes job job.off->job.busy",
        "#1 handled transition c1 job job.ready: Rejected: no",
        "#1 ended s1 start{} failed: Rejected: no | changes job job.busy->job.failed | unsettled c1 job",
        "#1 handled transition c1 job job.ready: OK",
      ]
    `);
  });

  it("an accepted abort whose work settles on the abort: the work's answer, then the abort's ended; the transition gets no end", async () => {
    const target = make((sm) => sm.addTransitionHandler(job.ready, answersAbort));
    const lines = tapLines();
    const steps = endedSteps(target);

    dispatch(target, start());
    await dispatch(target, back(), { abort: true }).done();

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 start{}",
        "#1 ended s1 start{} temp: InTransition | changes job job.off->job.busy",
        "#1 dispatched s2 back{}",
        "#1 handled transition c1 job job.ready: TransitionAborted: aborted by back [SF040] Stop the work on abort and release what it acquired; expect Rejected where an abort may come.",
        "#1 ended s2 back{} abort: OK | changes job job.busy->job.off",
      ]
    `);
    expect(steps.map((step) => step.abort)).toEqual([false, true]);
  });

  it("an accepted abort whose work never settles: the abort's ended lists it as unsettled, once the wait ends", async () => {
    const { work } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(job.ready, work));
    const lines = tapLines();

    dispatch(target, slow());
    await dispatch(target, back(), { abort: true }).done();

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 slow{}",
        "#1 ended s1 slow{} temp: InTransition | changes job job.off->job.busy",
        "#1 dispatched s2 back{}",
        "#1 ended s2 back{} abort: OK | changes job job.busy->job.off | unsettled c1 job",
      ]
    `);
  });

  it("a refused abort: dispatched, then its ended, marked abort; the transition goes on to its own end", async () => {
    const { work, settle } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(job.ready, work));
    const lines = tapLines();

    const result = dispatch(target, start());
    dispatch(target, go(), { abort: true });
    settle(HandlerResult.ok());
    await result.done();

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 start{}",
        "#1 ended s1 start{} temp: InTransition | changes job job.off->job.busy",
        "#1 dispatched s2 go{}",
        "#1 ended s2 go{} abort: Rejected: go changes nothing; the transition continues",
        "#1 handled transition c1 job job.ready: OK",
        "#1 ended s1 start{} final: OK | changes job job.busy->job.ready",
      ]
    `);
  });

  it("a queued send: dispatched and ended at its turn, after the end of the transition it waited for", async () => {
    const { work, settle } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(job.ready, work));
    const lines = tapLines();
    await using send = await lock(target);

    send(start());
    const queued = send(go());
    settle(HandlerResult.ok());
    await queued.done();

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 start{}",
        "#1 ended s1 start{} temp: InTransition | changes job job.off->job.busy",
        "#1 handled transition c1 job job.ready: OK",
        "#1 ended s1 start{} final: OK | changes job job.busy->job.ready",
        "#1 dispatched s2 go{}",
        "#1 ended s2 go{}: Ignored: no reducer for go in job.ready",
      ]
    `);
  });

  it("a muted dispatch is told as any other, though it writes no entry", async () => {
    const entries: StateFlowLogEntry[] = [];
    removers.push(addGlobalLogHandler((entry) => entries.push(entry)));
    const target = make();
    const lines = tapLines();

    dispatch(target, start(), { mute: true });
    await wait(0);

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 start{}",
        "#1 ended s1 start{} temp: InTransition | changes job job.off->job.busy",
        "#1 ended s1 start{} final: OK | changes job job.busy->job.ready",
      ]
    `);
    expect(entries).toEqual([]);
  });

  it("a dispatch a handler makes to another target is told whole inside the handler's call, before the handler's result", () => {
    const inner = make();
    const outer = make((sm) =>
      sm.addEnterHandler(job.on, () => {
        dispatch(inner, go());
        return HandlerResult.ok();
      }),
    );
    const lines = tapLines();

    dispatch(outer, go());

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 go{}",
        "#2 dispatched s2 go{}",
        "#2 ended s2 go{}: OK | changes job job.off->job.on",
        "#1 handled enter c1 job job.on: OK",
        "#1 ended s1 go{}: OK | changes job job.off->job.on",
      ]
    `);
  });

  it("reports a throw from ended on console.error, and the dispatch and the other taps go on", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    removers.push(
      addFlowTap({
        dispatched: () => {},
        handled: () => {},
        ended: () => {
          throw boom;
        },
      }),
    );
    const lines = tapLines();
    const target = make();

    const result = dispatch(target, go());

    expect(String(result)).toBe("OK");
    expect(String(target.job)).toBe("job.on(n=1)");
    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 go{}",
        "#1 ended s1 go{}: OK | changes job job.off->job.on",
      ]
    `);
    expect(error).toHaveBeenCalledWith("[SF/Object] a tap threw:", boom);
  });

  it("a transition pending when its flow is disposed gets no end", async () => {
    const target = make((sm) => sm.addTransitionHandler(job.ready, deferredWork().work));
    const lines = tapLines();

    dispatch(target, start());
    disposeFlow(target);
    await wait(0);

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 start{}",
        "#1 ended s1 start{} temp: InTransition | changes job job.off->job.busy",
      ]
    `);
  });

  it("a throw from a string form while a step's changes are logged: ended is told with the Error before the throw goes on, in a plain step and a temp step, and an end that commits nothing lists no changes", () => {
    const lines = tapLines();
    const bad = defineSignal("bad");
    const badStart = defineSignal("badStart");
    const badEnd = defineSignal("badEnd");
    const broken = defineState<{ n: number }>()
      .name("broken")
      .signals({ bad, badStart, badEnd })
      .variant("a", { initial: true })
      .variant("b")
      .variant("c", { async: true })
      .stringRepr((s) => {
        if (s.n === 13) {
          throw new Error("no string form for 13");
        }
        return `n=${s.n}`;
      })
      .build();
    defineFlow(broken.a, {
      bad: () => broken.b({ n: 13 }),
      badStart: (s) => StateResult.transition(broken.c(s), broken.b({ n: 13 }), broken.a(s)),
      badEnd: (s) => StateResult.transition(broken.c({ n: 13 }), broken.b(s), broken.a({ n: 13 })),
    });
    const holder = { broken: { n: 0 } };
    applyFlow(holder, [broken], () => {});

    expect(() => dispatch(holder, bad())).toThrow("no string form for 13");
    expect(() => dispatch(holder, badStart())).toThrow("no string form for 13");
    // With no work, the end runs inside the send. Its step and its failed step both throw, so nothing commits, and its
    // ended lists none of the temp step's changes.
    dispatch(holder, badEnd());
    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 bad{}",
        "#1 ended s1 bad{}: Error: no string form for 13",
        "#1 dispatched s2 badStart{}",
        "#1 ended s2 badStart{} temp: Error: no string form for 13",
        "#1 dispatched s3 badEnd{}",
        "#1 ended s3 badEnd{} temp: InTransition | changes broken broken.a->broken.b",
        "#1 ended s3 badEnd{} failed: Error: no string form for 13",
      ]
    `);
  });

  it("an abort refused as already in progress runs no reducer and is told and written as before, whatever its plan would do", async () => {
    const entries: StateFlowLogEntry[] = [];
    removers.push(addGlobalLogHandler((entry) => entries.push(entry)));
    const bad = defineSignal("bad");
    let reducerCalls = 0;
    const st = defineState<{ n: number }>()
      .name("st")
      .signals({ slow, back, bad })
      .variant("off", { initial: true })
      .variant("busy")
      .variant("ready", { async: true })
      .variant("failed")
      .variant("t", { transitional: true })
      .stringRepr((s) => {
        if (s.n === 13) {
          throw new Error("no string form for 13");
        }
        return `n=${s.n}`;
      })
      .build();
    defineFlow(st.off, {
      slow: (s) => StateResult.transition(st.ready(s), st.busy(s), st.failed(s), { timeoutMs: 5 }),
    });
    defineFlow(st.busy, {
      back: (s) => st.off(s),
      // Planned, it would throw: its failed's string form is in the message that refuses it.
      bad: (s) => {
        reducerCalls++;
        return StateResult.ok(st.off(s), st.t({ n: 13 }));
      },
    });
    const holder = { st: { n: 0 } };
    applyFlow(holder, [st], (sm) => sm.addTransitionHandler(st.ready, deferredWork().work));
    dispatch(holder, slow());
    const accepted = dispatch(holder, back(), { abort: true });
    const lines = tapLines();

    const refused = dispatch(holder, bad(), { abort: true });
    await accepted.done();

    expect(refused.code).toBe("SF036");
    expect(reducerCalls).toBe(0);
    expect(lines.slice(0, 2)).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 bad{}",
        "#1 ended s1 bad{} abort: Rejected: an abort of st is already in progress",
      ]
    `);
    expect(entries.map((entry) => entry.finalResultData?.code)).toContain("SF036");
  });

  it("an entry's dispatchOrder and startTime are taken after its dispatched telling, so a tap's own dispatch and time come before them", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 0 });
    removers.push(() => vi.useRealTimers());
    const entries: StateFlowLogEntry[] = [];
    removers.push(addGlobalLogHandler((entry) => entries.push(entry)));
    const outer = make();
    const inner = make();
    removers.push(
      addFlowTap({
        dispatched: (t) => {
          if (t === outer) {
            vi.setSystemTime(1000);
            dispatch(inner, back());
          }
        },
        handled: () => {},
        ended: () => {},
      }),
    );

    dispatch(outer, go());

    return wait(0).then(() => {
      // The inner dispatch is the one of back, the outer one's is go.
      const order = Object.fromEntries(entries.map((entry) => [entry.signal, entry.dispatchOrder]));
      expect(order["back{}"]).toBeLessThan(order["go{}"] as number);
      expect(entries.find((entry) => entry.signal === "go{}")?.startTime).toBe(1000);
    });
  });

  it("names the observers that fired, as the entry does, and not one whose compare declined", () => {
    const target = make();
    const observer = observe(target, [job.on], function seen() {});
    const declining = observe(
      target,
      [job.on],
      function unseen() {},
      () => false,
    );
    removers.push(
      () => observer[Symbol.dispose](),
      () => declining[Symbol.dispose](),
    );
    const lines = tapLines();

    dispatch(target, go());

    expect(lines).toMatchInlineSnapshot(`
      [
        "#1 dispatched s1 go{}",
        "#1 ended s1 go{}: OK | changes job job.off->job.on | fired job seen",
      ]
    `);
  });
});
