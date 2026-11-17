import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFlow, dispatch } from "../flow";
import { HandlerResult, ResultKind, StateResult } from "../result";
import { defineSignal } from "../signal";
import { defineFlow, defineState } from "../state";

/**
 * `expect()` on the pending result a dispatch returns while its declared transition runs is enforced by `done()`:
 * an end of another kind makes done() throw, and no unhandled rejection is left behind (an assertion parked on a
 * side promise that done() never reads would leave one and let the end pass).
 */
describe("expect() on async dispatch transitions", () => {
  // Capture unhandled rejections during the test body, restore afterwards.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(async () => {
    // Let any orphaned microtask rejection surface before we assert/restore.
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", onUnhandled);
  });

  type Ctx = { test: { n: number } };

  /** A target whose `go` declares loaded through loading, with failed, and `work` as loaded's transition handler. */
  function makeContext(work: () => Promise<HandlerResult>): {
    context: Ctx;
    signals: { go: () => any };
  } {
    const signals = {
      go: defineSignal("go"),
    };

    const testState = defineState<{ n: number }>()
      .name("test")
      .signals(signals)
      .variant("idle", { initial: true })
      .variant("loading")
      .variant("loaded", { async: true })
      .variant("failed")
      .build();

    const context: Ctx = { test: { n: 0 } };

    defineFlow(testState.idle, {
      go: () =>
        StateResult.transition(testState.loaded({ n: 1 }), testState.loading({ n: 1 }), testState.failed({ n: 1 }), {
          timeoutMs: 200,
        }),
    });

    applyFlow(context, [testState], (sm) => {
      sm.addTransitionHandler(testState.loaded, work);
    });

    return { context, signals };
  }

  it("expect(OK).done() on a declared transition whose work rejects REJECTS once and leaks no unhandledRejection", async () => {
    const { context, signals } = makeContext(async () => HandlerResult.rejected("nope"));

    // Pending first: otherwise a synchronous Error would also make expect(OK) throw inside the try below.
    const r = dispatch(context, signals.go());
    expect(r.kind).toBe(ResultKind.InTransition);

    let threw = false;
    let finalKind: ResultKind | null = null;
    try {
      const final = await r.expect(ResultKind.OK).done();
      finalKind = final.kind;
    } catch {
      threw = true;
    }

    // settle any leaked microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(threw).toBe(true);
    expect(finalKind).toBeNull();
    expect(unhandled).toHaveLength(0);
  });

  it("expect(OK).done() on a declared transition whose work resolves OK resolves OK", async () => {
    const { context, signals } = makeContext(async () => HandlerResult.ok());

    const final = await dispatch(context, signals.go()).expect(ResultKind.OK).done();

    expect(final.kind).toBe(ResultKind.OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toHaveLength(0);
  });

  it("expect(OK, Ignored).done() multi-kind accepts a work resolving Ignored, which reaches next", async () => {
    const { context, signals } = makeContext(async () => HandlerResult.ignored("skipped"));

    const final = await dispatch(context, signals.go()).expect(ResultKind.OK, ResultKind.Ignored).done();

    expect(final.in(ResultKind.OK, ResultKind.Ignored)).toBe(true);
    expect(String(context.test)).toBe("test.loaded(n=1)");
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toHaveLength(0);
  });

  it("expect(OK, Rejected).done() multi-kind accepts a work resolving Rejected (no throw)", async () => {
    const { context, signals } = makeContext(async () => HandlerResult.rejected("expected"));

    const final = await dispatch(context, signals.go()).expect(ResultKind.OK, ResultKind.Rejected).done();

    expect(final.kind).toBe(ResultKind.Rejected);
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toHaveLength(0);
  });

  it("sync: expect(OK) on a synchronous Rejected result still throws synchronously", () => {
    const result = StateResult.rejected("sync reject");
    expect(() => result.expect(ResultKind.OK)).toThrow();
  });
});
