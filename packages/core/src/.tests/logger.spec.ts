import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFlow, defineFlow, defineSignal, defineState, dispatch } from "..";
import { createMockLogger } from "../logger-mock";
import { HandlerResult, ResultKind } from "../result";

describe("MockStateFlowLogger", () => {
  const signals = {
    next: defineSignal<{ value: number }>("next"),
    reset: defineSignal("reset"),
  };

  const testState = defineState<{ count: number }>()
    .name("test")
    .signals(signals)
    .variant("initial", { initial: true })
    .variant("active")
    .build();

  defineFlow(testState.initial, {
    next: (state, signal) => testState.active({ count: signal.value }),
    reset: () => ({ count: 0 }),
  });

  defineFlow(testState.active, {
    next: (state, signal) => ({ count: state.count + signal.value }),
    reset: () => testState.initial({ count: 0 }),
  });

  let context: { test: { count: number } };
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    context = { test: { count: 0 } };
    logger = createMockLogger();

    function enderActiveHandler(state: { count: number }): HandlerResult {
      if (state.count > 10) {
        return HandlerResult.rejected("count too high");
      }
      return HandlerResult.ok();
    }

    function updateActiveHandler(state: { count: number }): HandlerResult {
      return HandlerResult.ignored("noting to do");
    }

    applyFlow(
      context,
      [testState],
      (sm) => {
        sm.addEnterHandler(testState.active, enderActiveHandler);
        sm.addUpdateHandler(testState.active, updateActiveHandler);
      },
      { logHandlers: [logger.createHandler()] },
    );
  });

  afterEach(() => {
    logger.clear();
  });

  it("a committed dispatch logs OK, its signal, the change of variant and the enter handler's result", async () => {
    await dispatch(context, signals.next({ value: 5 })).done();

    logger.should
      .haveResult(ResultKind.OK)
      .haveSignal(signals.next)
      .haveStateChange(testState.initial, testState.active)
      .haveHandler(testState, "enter", "enderActiveHandler", "OK");
  });

  it("a dispatch a reducer rejects logs its Rejected result and the reducer's message", async () => {
    await dispatch(context, signals.next({ value: 15 })).done();

    logger.should
      .haveResult(ResultKind.Rejected)
      .haveSignal(signals.next, "count too high")
      .haveMessage("count too high");
  });

  it("the log keeps every dispatch: the first one's change of variant and the second one's update handler are both found", async () => {
    await dispatch(context, signals.next({ value: 5 })).done();
    await dispatch(context, signals.next({ value: 3 })).done();

    logger.should
      .haveStateChange(testState.initial, testState.active)
      .haveHandler(testState, "update", "updateActiveHandler");
  });

  it("should clear history between tests", async () => {
    await dispatch(context, signals.next({ value: 5 })).done();
    logger.clear();

    // After clearing, no logs should exist
    expect(() => logger.should.haveResult(ResultKind.OK)).toThrow();
  });

  it("haveHandler on an empty log fails with its own message", () => {
    expect(() => logger.should.haveHandler(testState, "enter", "enderActiveHandler")).toThrow(
      'Expected to find enter handler "enderActiveHandler" for "test"',
    );
  });
});
