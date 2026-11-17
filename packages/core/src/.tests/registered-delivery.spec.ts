import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  observe,
  settled,
  subscribeFlow,
  watch,
} from "..";

/**
 * An observer's, a watch's and a subscriber's delivery runs on a timer turn after its commit, and only while the
 * observer, the watch or the subscriber is still registered: one its disposer took off after the commit is told
 * nothing of it. disposeFlow takes the observers and the watches off, so their deliveries set before it are dropped,
 * while an event of the flow and a subscriber's change set before it still arrive.
 */
describe("a delivery reaches only what is still registered", () => {
  const signals = { bump: defineSignal("bump") };
  const cnt = defineState<{ n: number }>().name("cnt").signals(signals).variant("only", { initial: true }).build();
  defineFlow(cnt.only, { bump: (s) => ({ n: s.n + 1 }) });

  /** A target that records what its events emit. */
  class Target {
    cnt = { n: 0 };
    readonly emitted: unknown[][] = [];
    emit(...args: unknown[]): void {
      this.emitted.push(args);
    }
  }

  it("an observer, a watch and a subscriber disposed after a commit, before its delivery, are told nothing of it", async () => {
    const target = new Target();
    applyFlow(target, [cnt], () => {});
    const told: string[] = [];
    const observer = observe(target, [cnt.only], () => told.push("observer"));
    using _keptObserver = observe(target, [cnt.only], () => told.push("kept observer"));
    const w = watch(
      target,
      () => true,
      () => told.push("watch"),
    );
    using _keptWatch = watch(
      target,
      () => true,
      () => told.push("kept watch"),
    );
    const subscriber = subscribeFlow(target, () => told.push("subscriber"));

    dispatch(target, signals.bump());
    observer[Symbol.dispose]();
    w[Symbol.dispose]();
    subscriber[Symbol.dispose]();
    await settled(target);

    expect(told).toEqual(["kept observer", "kept watch"]);
  });

  it("disposeFlow drops the deliveries set before it of the observers and watches it removes; an event and a subscriber's change still arrive", async () => {
    const target = new Target();
    applyFlow(target, [cnt], (sm) => {
      sm.defineEvent("grew", (cur, prev) => cur.cnt.n > prev.cnt.n);
    });
    const told: string[] = [];
    observe(target, [cnt.only], () => told.push("observer"));
    watch(
      target,
      () => true,
      () => told.push("watch"),
    );
    subscribeFlow(target, () => told.push("subscriber"));

    dispatch(target, signals.bump());
    disposeFlow(target);
    await settled(target);

    expect(told).toEqual(["subscriber"]);
    expect(target.emitted).toEqual([["grew"]]);
  });
});
