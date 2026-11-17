import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  type FlowChange,
  HandlerResult,
  type StateFlowLogEntry,
  StateResult,
  subscribeFlow,
} from "..";

/**
 * `FlowChange.dispatchOrder` is the `dispatchOrder` of the log entry of the step that committed the change, so a
 * subscriber can match every change to its entry.
 */
describe("FlowChange.dispatchOrder", () => {
  const go = defineSignal("go");
  const start = defineSignal("start");

  const left = defineState<{ n: number }>().name("left").signals({ go }).variant("idle", { initial: true }).build();
  const right = defineState<{ n: number }>().name("right").signals({ go }).variant("idle", { initial: true }).build();
  defineFlow(left.idle, { go: (s) => ({ n: s.n + 1 }) });
  defineFlow(right.idle, { go: (s) => ({ n: s.n + 1 }) });

  const job = defineState<{ n: number }>()
    .name("job")
    .signals({ start })
    .variant("idle", { initial: true })
    .variant("running")
    .variant("done", { async: true })
    .variant("failed")
    .build();
  defineFlow(job.idle, { start: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s)) });

  // subscribeFlow delivers on a 0 ms timer and log entries on a microtask, so one timer turn brings both.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("every change one dispatch commits, one per changed state, carries the dispatchOrder of the dispatch's entry", async () => {
    const entries: StateFlowLogEntry[] = [];
    const target = { left: { n: 0 }, right: { n: 0 } };
    applyFlow(target, [left, right], () => {}, { logHandlers: [(entry) => entries.push(entry)] });
    const changes: FlowChange[] = [];
    using _sub = subscribeFlow(target, (change) => changes.push(change));

    dispatch(target, go());
    await tick();

    expect(entries).toHaveLength(1);
    const order = entries[0].dispatchOrder;
    expect(changes).toMatchObject([
      { stateName: "left", dispatchOrder: order },
      { stateName: "right", dispatchOrder: order },
    ]);
  });

  it("is one counter for every flow on the page: it grows across dispatches to two targets", async () => {
    const a = { left: { n: 0 } };
    const b = { left: { n: 0 } };
    applyFlow(a, [left], () => {});
    applyFlow(b, [left], () => {});
    const orders: number[] = [];
    using _subA = subscribeFlow(a, (change) => orders.push(change.dispatchOrder));
    using _subB = subscribeFlow(b, (change) => orders.push(change.dispatchOrder));

    dispatch(a, go());
    dispatch(b, go());
    dispatch(a, go());
    await tick();

    expect(orders).toHaveLength(3);
    expect(orders[0]).toBeLessThan(orders[1]);
    expect(orders[1]).toBeLessThan(orders[2]);
  });

  it("a declared transition's temp step and end carry the numbers of their own entries, the end's a later one", async () => {
    const entries: StateFlowLogEntry[] = [];
    const target = { job: { n: 0 } };
    applyFlow(target, [job], (sm) => sm.addTransitionHandler(job.done, async () => HandlerResult.ok()), {
      logHandlers: [(entry) => entries.push(entry)],
    });
    const changes: FlowChange[] = [];
    using _sub = subscribeFlow(target, (change) => changes.push(change));

    await dispatch(target, start()).done();
    await tick();

    expect(entries).toMatchObject([{ transition: "temp" }, { transition: "final" }]);
    expect(changes).toMatchObject([
      { nextVariant: "running", dispatchOrder: entries[0].dispatchOrder },
      { nextVariant: "done", dispatchOrder: entries[1].dispatchOrder },
    ]);
    expect(changes[1].dispatchOrder).toBeGreaterThan(changes[0].dispatchOrder);
  });
});
