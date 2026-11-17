import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  lock,
  ResultKind,
  setConsoleLogSilenced,
  stateVar,
} from "..";
import type { StateFlowLogEntry } from "../logger";
import { Result } from "../result";

/**
 * A `Result.transition` whose asyncFn resolves to ANOTHER `InTransition` (a nested transition, or a
 * `send()` returned without `.done()`) must keep resolving to its CONCRETE final.
 *
 * Before the `waitAll()` recursion fix it stayed `InTransition` forever, which caused three symptoms
 * seen in the player's `driverRun`:
 *   1. it logged as `async [Xms] InTransition` (never the resolved message);
 *   2. `.done()` returned `InTransition`, so callers checking `kind === OK` (the coordinator's
 *      `!activated.in(OK, Ignored)`, the player's `tryRunWith`) saw a spurious failure — the
 *      "all drivers have failed to run" symptom;
 *   3. `dispatchCore` resolved `res = InTransition`, which is neither `OK` nor `Rejected/Error`, so it
 *      neither committed nor rolled back.
 */
describe("InTransition recursion — a nested transition resolves to its concrete final", () => {
  const signals = {
    nestReject: defineSignal("nestReject"),
    nestOk: defineSignal("nestOk"),
    deepReject: defineSignal("deepReject"),
  };
  const s = defineState<{ n: number }>()
    .name("nest")
    .signals(signals)
    .variant("idle", true)
    .variant("rejecting")
    .variant("okding")
    .variant("deep")
    .build();
  defineFlow(s.idle, {
    nestReject: (st) => s.rejecting(st),
    nestOk: (st) => s.okding(st),
    deepReject: (st) => s.deep(st),
  });
  defineFlow(s.rejecting, {});
  defineFlow(s.okding, {});
  defineFlow(s.deep, {});

  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  let app: { nest: { n: number } };
  let entries: StateFlowLogEntry[];

  beforeEach(() => {
    setConsoleLogSilenced(true);
    app = { nest: { n: 0 } };
    entries = [];
    applyFlow(
      app,
      [s],
      (sm) => {
        // transition → transition → reject
        sm.addEnterHandler(s.rejecting, () =>
          Result.transition(async () => {
            await Promise.resolve();
            return Result.transition(async () => {
              await Promise.resolve();
              return Result.reject("DEEP REJECT");
            }, 1000);
          }, 1000),
        );
        // transition → transition → ok
        sm.addEnterHandler(s.okding, () =>
          Result.transition(async () => {
            await Promise.resolve();
            return Result.transition(async () => {
              await Promise.resolve();
              return Result.ok();
            }, 1000);
          }, 1000),
        );
        // 3 levels deep → reject (proves FULL recursion, not just one extra level)
        sm.addEnterHandler(s.deep, () =>
          Result.transition(
            async () =>
              Result.transition(async () => Result.transition(async () => Result.reject("THREE DEEP"), 1000), 1000),
            1000,
          ),
        );
      },
      { logHandlers: [(e) => entries.push(e)] },
    );
  });
  afterEach(() => setConsoleLogSilenced(null));

  it("nested → reject: .done() resolves to Rejected (not InTransition), logs the real message", async () => {
    let kind = -1;
    let message: string | null = null;
    {
      await using send = await lock(app, "nest");
      const r = await send(signals.nestReject()).done();
      kind = r.kind;
      message = r.message;
    }
    for (let i = 0; i < 8; i++) await tick();

    expect(kind).toBe(ResultKind.Rejected); // NOT ResultKind.InTransition
    expect(message).toBe("DEEP REJECT");
    const e = entries.find((x) => x.signal.startsWith("nestReject"));
    expect(e?.finalResult).toBe("Rejected: DEEP REJECT"); // NOT "InTransition"
    expect(e?.isAsync).toBe(true);
  });

  it("nested → ok: .done() resolves to OK (not InTransition) and the state COMMITS", async () => {
    let kind = -1;
    {
      await using send = await lock(app, "nest");
      const r = await send(signals.nestOk()).done();
      kind = r.kind;
    }
    for (let i = 0; i < 8; i++) await tick();

    expect(kind).toBe(ResultKind.OK); // NOT InTransition
    const e = entries.find((x) => x.signal.startsWith("nestOk"));
    expect(e?.finalResult).not.toContain("InTransition");
    // Before the fix res stayed InTransition → dispatchCore never applied the snapshot → still idle.
    expect(stateVar(app.nest)).toBe(s.okding);
  });

  it("3 levels deep → reject: still resolves to the concrete final (full recursion)", async () => {
    let kind = -1;
    let message: string | null = null;
    {
      await using send = await lock(app, "nest");
      const r = await send(signals.deepReject()).done();
      kind = r.kind;
      message = r.message;
    }
    for (let i = 0; i < 8; i++) await tick();

    expect(kind).toBe(ResultKind.Rejected);
    expect(message).toBe("THREE DEEP");
    const e = entries.find((x) => x.signal.startsWith("deepReject"));
    expect(e?.finalResult).toBe("Rejected: THREE DEEP");
  });
});
