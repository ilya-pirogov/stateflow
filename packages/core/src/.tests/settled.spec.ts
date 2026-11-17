import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  type FlowChange,
  type HandlerResult,
  lock,
  observe,
  StateFlowError,
  StateResult,
  settled,
  subscribeFlow,
  watch,
} from "..";

/**
 * settled(target): resolves once every delivery the flow set on its timers has run, the deliveries that their commits
 * set in turn included, and once the locks they asked for were served; on a disposed flow it waits for the deliveries
 * set before disposeFlow and takes no lock; it rejects when disposeFlow runs while it waits for the lock.
 */
describe("settled", () => {
  const signals = { bump: defineSignal("bump"), load: defineSignal("load") };
  const cnt = defineState<{ n: number }>().name("cnt").signals(signals).variant("only", { initial: true }).build();
  defineFlow(cnt.only, { bump: (s) => ({ n: s.n + 1 }) });

  /** A job whose load is a declared transition. */
  const job = defineState<Record<string, never>>()
    .name("job")
    .signals(signals)
    .variant("idle", { initial: true })
    .variant("loading")
    .variant("loaded", { async: true })
    .build();
  defineFlow(job.idle, { load: (s) => StateResult.transition(job.loaded(s), job.loading(s), job.idle(s)) });

  /** A target that records what its events emit. */
  class Target {
    cnt = { n: 0 };
    readonly emitted: unknown[][] = [];
    emit(...args: unknown[]): void {
      this.emitted.push(args);
    }
  }

  const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Commits one bump under the lock, as a caller does, and releases it. */
  async function bump(target: Target): Promise<void> {
    await using send = await lock(target);
    send(signals.bump());
  }

  /**
   * Watches the first bump: the callback takes the lock, holds it for a few ms of the clock, which a single timer turn
   * does not cover, and bumps again inside it.
   */
  function bumpAgainOnFirst(target: Target, steps: string[]): void {
    watch(
      target,
      (cur, prev) => cur.cnt.n === 1 && prev.cnt.n === 0,
      async () => {
        await using send = await lock(target);
        await tick(5);
        send(signals.bump());
        steps.push("sent");
      },
    );
  }

  it("a watch callback that takes the lock and sends is complete when settled resolves", async () => {
    const target = new Target();
    applyFlow(target, [cnt], () => {});
    const steps: string[] = [];
    bumpAgainOnFirst(target, steps);

    await bump(target);
    await settled(target);

    expect(steps).toEqual(["sent"]);
    expect(target.cnt.n).toBe(2);
  });

  it("a subscriber's change and an observer's callback set before the call have run when settled resolves", async () => {
    const target = new Target();
    applyFlow(target, [cnt], () => {});
    const seen: FlowChange[] = [];
    const observed: number[] = [];
    using _sub = subscribeFlow(target, (change) => seen.push(change));
    using _observer = observe(target, [cnt.only], (state) => observed.push(state.n));

    await bump(target);
    expect(seen).toEqual([]);
    expect(observed).toEqual([]);

    await settled(target);
    expect(seen.map((change) => change.nextVariant)).toEqual(["only"]);
    expect(observed).toEqual([1]);
  });

  it("a delivery whose lock commits again is waited for, with the deliveries that commit sets", async () => {
    const target = new Target();
    applyFlow(target, [cnt], () => {});
    const steps: string[] = [];
    bumpAgainOnFirst(target, steps);
    const seen: number[] = [];
    using _sub = subscribeFlow(target, (change) => seen.push((change.next as { n: number }).n));

    await bump(target);
    await settled(target);

    // The second change is set by the watch's send, after settled's first wait for the deliveries ended.
    expect(seen).toEqual([1, 2]);
  });

  it("after disposeFlow the deliveries set before it have run, and settled resolves without taking the lock", async () => {
    const target = new Target();
    applyFlow(target, [cnt], (sm) => {
      sm.defineEvent(
        "grew",
        (cur, prev) => cur.cnt.n > prev.cnt.n,
        (cur) => cur.cnt.n,
      );
    });

    // The holder keeps the lock past settled, which a disposed flow cannot hand to anyone.
    const send = await lock(target);
    send(signals.bump());
    disposeFlow(target);

    await settled(target);
    expect(target.emitted).toEqual([["grew", 1]]);

    await send[Symbol.asyncDispose]();
  });

  it("rejects when disposeFlow runs while it waits for the lock: behind its holder, or for a transition the lock waits for", async () => {
    const target = new Target();
    applyFlow(target, [cnt], () => {});
    const holder = await lock(target);

    const behindHolder = settled(target);
    disposeFlow(target);

    await expect(behindHolder).rejects.toThrow(StateFlowError);
    await expect(behindHolder).rejects.toThrow("Target is disposed");
    await holder[Symbol.asyncDispose]();

    // A bare dispatch starts a transition no lock holds; the lock settled takes waits for it to end.
    const loading = { job: {} };
    applyFlow(loading, [job], (sm) => {
      sm.addTransitionHandler(job.loaded, () => new Promise<HandlerResult>(() => {}));
    });
    dispatch(loading, signals.load());

    const forTransition = settled(loading);
    disposeFlow(loading);

    await expect(forTransition).rejects.toThrow("Object is disposed");
  });

  it("settled on a flow with nothing set resolves after at most one timer turn", async () => {
    const target = new Target();
    applyFlow(target, [cnt], () => {});
    let resolved = false;

    void settled(target).then(() => {
      resolved = true;
    });

    await tick();
    expect(resolved).toBe(true);
  });
});
