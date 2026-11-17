import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFlow, dispatch } from "../flow";
import { Result, ResultKind } from "../result";
import { defineSignal } from "../signal";
import { defineFlow, defineState } from "../state";

/**
 * Regression suite for P0.A: `expect().done()` must actually enforce on async
 * (InTransition) results that flow through `dispatch` (i.e. carry `meta`).
 *
 * The proven bug: `await dispatch(...).expect(ResultKind.OK).done()` on a
 * transition resolving Rejected returned (threw=false, finalKind=Rejected,
 * unhandledRejections=1) — the assertion parked on a side-promise was orphaned
 * because `done()` returned `meta.transitioning` without consulting it.
 */
describe("expect() on async dispatch transitions (P0.A)", () => {
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

  function makeContext(transitionResult: () => Promise<Result>): {
    context: Ctx;
    signals: { go: () => any };
  } {
    const signals = {
      go: defineSignal("go"),
    };

    const testState = defineState<{ n: number }>()
      .name("test")
      .signals(signals)
      .variant("idle", true)
      .variant("loading")
      .build();

    const context: Ctx = { test: { n: 0 } };

    defineFlow(testState.idle, {
      go: (() => testState.loading({ n: 1 })) as any,
    });

    applyFlow(context, [testState], (sm) => {
      sm.addEnterHandler(testState.loading, () => Result.transition(transitionResult, 200));
    });

    return { context, signals };
  }

  it("expect(OK).done() on a transition resolving Rejected REJECTS and leaks no unhandledRejection", async () => {
    const { context, signals } = makeContext(async () => Result.reject("nope"));

    let threw = false;
    let finalKind: ResultKind | null = null;
    try {
      const final = await dispatch(context, signals.go()).expect(ResultKind.OK).done();
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

  it("expect(OK).done() on a transition resolving OK resolves OK", async () => {
    const { context, signals } = makeContext(async () => Result.ok());

    const final = await dispatch(context, signals.go()).expect(ResultKind.OK).done();

    expect(final.kind).toBe(ResultKind.OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toHaveLength(0);
  });

  it("expect(OK, Ignored).done() multi-kind accepts a transition resolving Ignored", async () => {
    const { context, signals } = makeContext(async () => Result.ignore("skipped"));

    const final = await dispatch(context, signals.go()).expect(ResultKind.OK, ResultKind.Ignored).done();

    expect(final.in(ResultKind.OK, ResultKind.Ignored)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toHaveLength(0);
  });

  it("expect(OK, Rejected).done() multi-kind accepts a transition resolving Rejected (no throw)", async () => {
    const { context, signals } = makeContext(async () => Result.reject("expected"));

    const final = await dispatch(context, signals.go()).expect(ResultKind.OK, ResultKind.Rejected).done();

    expect(final.kind).toBe(ResultKind.Rejected);
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toHaveLength(0);
  });

  it("sync: expect(OK) on a synchronous Rejected result still throws synchronously", () => {
    const result = Result.reject("sync reject");
    expect(() => result.expect(ResultKind.OK)).toThrow();
  });
});
