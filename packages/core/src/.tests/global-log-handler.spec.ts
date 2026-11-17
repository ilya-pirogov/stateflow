import { afterEach, describe, expect, it } from "vitest";

import { addGlobalLogHandler, applyFlow, defineFlow, defineSignal, defineState, dispatch, lock } from "..";
import type { StateFlowLogEntry } from "../logger";

/**
 * `addGlobalLogHandler` — debug-tooling hook that taps EVERY flow's log entries without touching
 * any `applyFlow` call site. Purely additive: per-flow handlers are unaffected, and with no global
 * handler registered the delivery path is exactly the per-flow list.
 */
describe("addGlobalLogHandler — global log-handler hook", () => {
  const signals = {
    go: defineSignal("go"),
  };

  const s = defineState<{ n: number }>().name("glb").signals(signals).variant("idle", true).variant("active").build();

  defineFlow(s.idle, {
    go: (state) => s.active({ n: state.n + 1 }),
  });
  defineFlow(s.active, {
    go: (state) => ({ n: state.n + 1 }),
  });

  // StateFlow emits entries asynchronously (collector.finish().then(emit)).
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  let unsubscribe: (() => void) | null = null;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  function makeApp(perFlowHandler?: (entry: StateFlowLogEntry) => void): { glb: { n: number } } {
    const app = { glb: { n: 0 } };
    applyFlow(app, [s], () => {}, perFlowHandler ? { logHandlers: [perFlowHandler] } : {});
    return app;
  }

  it("receives entries from flows that never configured it (default handlers)", async () => {
    const seen: StateFlowLogEntry[] = [];
    unsubscribe = addGlobalLogHandler((entry) => seen.push(entry));

    const app = makeApp();
    dispatch(app, signals.go());
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0].signal.startsWith("go")).toBe(true);
  });

  it("delivers the same entry alongside per-flow handlers without affecting them", async () => {
    const perFlow: StateFlowLogEntry[] = [];
    const viaGlobal: StateFlowLogEntry[] = [];
    unsubscribe = addGlobalLogHandler((entry) => viaGlobal.push(entry));

    const app = makeApp((entry) => perFlow.push(entry));
    dispatch(app, signals.go());
    await tick();

    expect(perFlow).toHaveLength(1);
    expect(viaGlobal).toHaveLength(1);
    expect(viaGlobal[0]).toBe(perFlow[0]);
  });

  it("stops delivering after unsubscribe", async () => {
    const seen: StateFlowLogEntry[] = [];
    const off = addGlobalLogHandler((entry) => seen.push(entry));

    const app = makeApp();
    dispatch(app, signals.go());
    await tick();
    expect(seen).toHaveLength(1);

    off();
    dispatch(app, signals.go());
    await tick();
    expect(seen).toHaveLength(1);
  });

  it("receives labeled-lock grouped entries with their groupLabel", async () => {
    const seen: StateFlowLogEntry[] = [];
    unsubscribe = addGlobalLogHandler((entry) => seen.push(entry));

    const app = makeApp();
    {
      await using send = await lock(app, "grouped section");
      await send(signals.go()).done();
      // Still inside the lock: entries are buffered until release.
      expect(seen).toHaveLength(0);
    }
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0].groupLabel).toBe("grouped section");
  });
});
