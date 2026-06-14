import { afterEach, beforeEach, describe, expect, it, type MockedFunction, vi } from "vitest";

import { applyFlow, dispatch, lock, observe } from "../flow";
import { Result, ResultKind } from "../result";
import { defineSignal } from "../signal";
import { defineFlow, defineState, isState } from "../state";

describe("State Flow System", () => {
  describe("Signal Definition", () => {
    it("should create parameterless signals", () => {
      const signal = defineSignal("test")();
      expect(String(signal)).toBe("test{}");
      expect(signal[Symbol.toStringTag]).toBe("test");
    });

    it("should create parameterized signals", () => {
      const signal = defineSignal<{ value: number }>("test", (args) => JSON.stringify(args))({ value: 42 });
      expect(String(signal)).toBe('test{{"value":42}}');
      expect(signal[Symbol.toStringTag]).toBe("test");
      expect(signal.value).toBe(42);
    });
  });

  describe("State Definition", () => {
    const signals = {
      next: defineSignal<{ value: number }>("next"),
      reset: defineSignal("reset"),
    };

    it("should create valid state definition", () => {
      const state = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("initial", true)
        .variant("running")
        .stringRepr((s) => `count=${s.counter}`)
        .build();

      expect(state[Symbol.toStringTag]).toBe("test");
      expect(typeof state.initial).toBe("function");
      expect(typeof state.running).toBe("function");
    });

    it("should validate state definition requirements", () => {
      expect(() => defineState<{ counter: number }>().signals(signals).build()).toThrow("Name was not provided");

      const partial = defineState<{ counter: number }>().name("test");
      expect(() => partial.build()).toThrow("Signals were not provided");

      const withSignals = partial.signals(signals);
      expect(() => withSignals.build()).toThrow("No state variants are defined");
    });

    it("should not allow multiple initial variants", () => {
      expect(() =>
        defineState<{ counter: number }>().name("test").signals(signals).variant("first", true).variant("second", true),
      ).toThrow("Only one initial state variant is allowed");
    });
  });

  describe("Flow Definition", () => {
    let testState: any;
    let signals: any;

    beforeEach(() => {
      signals = {
        next: defineSignal<{ value: number }>("next"),
        reset: defineSignal("reset"),
      };

      testState = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("initial", true)
        .variant("running")
        .build();
    });

    it("should define valid flow handlers", () => {
      defineFlow(testState.initial, {
        next: (state: any, signal: any) => testState.running({ counter: signal.value }),
        reset: () => testState.initial({ counter: 0 }),
      });

      // Verify handlers are frozen after definition
      expect(() =>
        defineFlow(testState.initial, {
          next: () => testState.running({ counter: 0 }),
        }),
      ).toThrow("Flow is already defined");
    });
  });

  describe("State Flow Integration", () => {
    let context: any;
    let testState: any;
    let signals: any;
    let enterSpy: MockedFunction<any>;
    let exitSpy: MockedFunction<any>;
    let updateSpy: MockedFunction<any>;

    beforeEach(() => {
      signals = {
        next: defineSignal<{ value: number }>("next"),
        reset: defineSignal("reset"),
      };

      testState = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("initial", true)
        .variant("running")
        .build();

      context = {
        test: { counter: 0 },
      };

      enterSpy = vi.fn(() => Result.ok());
      exitSpy = vi.fn(() => Result.ok());
      updateSpy = vi.fn(() => Result.ok());

      defineFlow(testState.initial, {
        next: (state: any, signal: any) => testState.running({ counter: signal.value }),
        reset: () => testState.initial({ counter: 0 }),
      });

      defineFlow(testState.running, {
        next: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        reset: () => testState.initial({ counter: 0 }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.running, enterSpy);
        sm.addExitHandler(testState.initial, exitSpy);
        sm.addUpdateHandler(testState.running, updateSpy);
      });
    });

    it("should handle synchronous state transitions", () => {
      const result = dispatch(context, signals.next({ value: 5 }));

      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(5);
      expect(enterSpy).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledOnce();
    });

    it("should handle state updates", () => {
      dispatch(context, signals.next({ value: 5 }));
      const result = dispatch(context, signals.next({ value: 3 }));

      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(8);
      expect(updateSpy).toHaveBeenCalledOnce();
    });

    it("should handle reset", () => {
      dispatch(context, signals.next({ value: 5 }));
      const result = dispatch(context, signals.reset());

      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(0);
    });
  });

  describe("Asynchronous State Transitions", () => {
    let context: any;
    let testState: any;
    let signals: any;

    beforeEach(() => {
      vi.useFakeTimers();

      signals = {
        async: defineSignal<{ delay: number }>("async"),
      };

      testState = defineState<{ delay: number }>()
        .name("test")
        .signals(signals)
        .variant("idle", true)
        .variant("loading")
        .variant("done")
        .build();

      context = {
        test: { delay: 0 },
      };

      defineFlow(testState.idle, {
        async: (state: any, signal: any) => testState.loading({ delay: signal.delay }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.loading, (state: any) => {
          return Result.transition(async () => {
            await new Promise((resolve) => setTimeout(resolve, state.delay));
            return Result.ok();
          });
        });
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should handle async transitions", async () => {
      const result = dispatch(context, signals.async({ delay: 100 }));
      expect(result.kind).toBe(ResultKind.InTransition);

      vi.advanceTimersByTime(100);
      const final = await result.done();

      expect(final.kind).toBe(ResultKind.OK);
      expect(String(context.test)).toBe("test.loading(delay=100)");
    });

    it("should prevent concurrent transitions", () => {
      dispatch(context, signals.async({ delay: 100 }));
      expect(() => dispatch(context, signals.async({ delay: 100 }))).toThrow("States are in transitioning");
    });

    it("should handle transition timeouts", async () => {
      const result = dispatch(context, signals.async({ delay: 1000 }));
      vi.advanceTimersByTime(501); // Default timeout is 500ms

      const final = await result.done();
      expect(final.kind).toBe(ResultKind.Error);
      expect(final.error?.message).toBe("timeout");
    });
  });

  describe("State Observation", () => {
    let context: any;
    let testState: any;
    let signals: any;
    let observerSpy: MockedFunction<any>;

    beforeEach(() => {
      signals = {
        update: defineSignal<{ value: number }>("update"),
      };

      testState = defineState<{ value: number }>().name("test").signals(signals).variant("active", true).build();

      context = {
        test: { value: 0 },
      };

      defineFlow(testState.active, {
        update: (state: any, signal: any) => ({ value: signal.value }),
      });

      applyFlow(context, [testState], () => {});
      observerSpy = vi.fn();
    });

    it("should notify observers of state changes", async () => {
      using _ = observe(context, [testState.active], observerSpy);

      dispatch(context, signals.update({ value: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(observerSpy).toHaveBeenCalledOnce();
      expect((observerSpy.mock.calls[0][0] as any).value).toBe(1);
    });

    it("should stop notifying after disposal", () => {
      const subscription = observe(
        context,
        [testState.active],
        observerSpy,
        (prev: any, curr: any) => prev.value !== curr.value,
      );

      subscription[Symbol.dispose]();
      dispatch(context, signals.update({ value: 1 }));
      expect(observerSpy).not.toHaveBeenCalled();
    });

    it("should only notify when compare function returns true", async () => {
      using _ = observe(context, [testState.active], observerSpy, (prev: any, curr: any) => prev.value > curr.value);

      dispatch(context, signals.update({ value: 1 })); // 0 -> 1
      dispatch(context, signals.update({ value: 0 })); // 1 -> 0
      await new Promise((resolve) => setTimeout(resolve, 1));

      expect(observerSpy).toHaveBeenCalledOnce();
      expect((observerSpy.mock.calls[0][0] as any).value).toBe(0);
    });
  });

  describe("Result Handling", () => {
    it("should handle OK results", () => {
      const result = Result.ok("test");
      expect(result.kind).toBe(ResultKind.OK);
      expect(result.data).toBe("test");
    });

    it("should handle Error results", () => {
      const error = new Error("test error");
      const result = Result.error(error);
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error).toBe(error);
    });

    it("should handle Ignored results", () => {
      const result = Result.ignore("not applicable");
      expect(result.kind).toBe(ResultKind.Ignored);
      expect(result.message).toBe("not applicable");
    });

    it("should handle Rejected results", () => {
      const result = Result.reject("invalid state");
      expect(result.kind).toBe(ResultKind.Rejected);
      expect(result.message).toBe("invalid state");
    });

    it("should merge results correctly", () => {
      const r1 = Result.ok("first");
      const r2 = Result.ok("second");
      const merged = r1.merge(r2);
      expect(merged.kind).toBe(ResultKind.OK);

      const r3 = Result.error(new Error("test"));
      const r4 = Result.ok("test");
      const errorMerged = r3.merge(r4);
      expect(errorMerged.kind).toBe(ResultKind.Error);
    });
  });

  describe("Utility Functions", () => {
    it("should detect state instances", () => {
      const state = defineState<{ value: number }>().name("test").signals({}).variant("test", true).build();

      const instance = state.test({ value: 0 });
      expect(isState(instance)).toBe(true);
      expect(isState({})).toBe(false);
    });

    it("should truncate long values correctly", () => {
      const signals = {
        test: defineSignal<{ value: string }>("test"),
      };

      const state = defineState<{ value: string }>().name("test").signals(signals).variant("test", true).build();

      const longString = "a".repeat(20);
      const instance = state.test({ value: longString });
      expect(String(instance)).toBe("test.test(value=aaaaaaaaaaaaaaaaaaaa)");
    });
  });

  describe("Lock System", () => {
    let context: any;
    let testState: any;
    let signals: any;

    beforeEach(() => {
      signals = {
        next: defineSignal<{ value: number }>("next"),
        reset: defineSignal("reset"),
      };

      testState = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("initial", true)
        .variant("running")
        .build();

      context = { test: { counter: 0 } };

      defineFlow(testState.initial, {
        next: (state: any, signal: any) => testState.running({ counter: signal.value }),
        reset: () => testState.initial({ counter: 0 }),
      });

      defineFlow(testState.running, {
        next: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        reset: () => testState.initial({ counter: 0 }),
      });

      applyFlow(context, [testState], () => {});
    });

    it("should dispatch signals via lock", async () => {
      await using send = await lock(context);
      const result = send(signals.next({ value: 5 }));

      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(5);
    });

    it("should allow multiple dispatches within a lock", async () => {
      await using send = await lock(context);
      send(signals.next({ value: 5 }));
      send(signals.next({ value: 3 }));

      expect(context.test.counter).toBe(8);
    });

    it("should auto-release lock via Symbol.asyncDispose", async () => {
      {
        await using send = await lock(context);
        send(signals.next({ value: 5 }));
      }

      // lock released, dispatch should work
      const result = dispatch(context, signals.next({ value: 3 }));
      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(8);
    });

    it("should throw on dispatch when lock is held", async () => {
      await using send = await lock(context);
      send(signals.next({ value: 5 }));

      expect(() => dispatch(context, signals.next({ value: 3 }))).toThrow("Lock is held");
    });

    it("should queue second lock until first is released", async () => {
      const order: number[] = [];

      const p1 = (async () => {
        await using send = await lock(context);
        send(signals.next({ value: 5 }));
        order.push(1);
      })();

      const p2 = (async () => {
        await using send = await lock(context);
        order.push(2);
        send(signals.next({ value: 3 }));
      })();

      await Promise.all([p1, p2]);

      expect(order).toEqual([1, 2]);
      expect(context.test.counter).toBe(8);
    });

    it("should throw when using disposed lock", async () => {
      const send = await lock(context);
      await send[Symbol.asyncDispose]();

      expect(() => send(signals.next({ value: 5 }))).toThrow("Lock has been released");
    });

    it("handles many concurrent lock() acquisitions without invalidating handles (race regression)", async () => {
      // Mirrors the driver support-check: N independent async callbacks each acquire
      // the same target's lock as their work resolves. The previous FIFO hand-off
      // nulled lockHolder before the woken waiter resumed, leaving a window where a
      // racing lock() could claim it and invalidate the woken waiter's handle
      // ("Lock has been released"). Each task yields a varying number of microtasks
      // before locking to maximize interleaving across the hand-off window.
      const N = 25;
      const errors: unknown[] = [];
      const tasks = Array.from({ length: N }, (_, i) =>
        (async () => {
          for (let y = 0; y < i % 4; y++) {
            await Promise.resolve();
          }
          try {
            await using send = await lock(context);
            send(signals.next({ value: 1 }));
          } catch (e) {
            errors.push(e);
          }
        })(),
      );

      await Promise.all(tasks);

      // No handle was invalidated, and every dispatch landed exactly once.
      expect(errors).toEqual([]);
      expect(context.test.counter).toBe(N);
    });
  });

  describe("Lock with Async Transitions", () => {
    let context: any;
    let testState: any;
    let signals: any;

    beforeEach(() => {
      vi.useFakeTimers();

      signals = {
        start: defineSignal<{ delay: number }>("start"),
      };

      testState = defineState<{ delay: number }>()
        .name("test")
        .signals(signals)
        .variant("idle", true)
        .variant("loading")
        .build();

      context = { test: { delay: 0 } };

      defineFlow(testState.idle, {
        start: (state: any, signal: any) => testState.loading({ delay: signal.delay }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.loading, (state: any) => {
          return Result.transition(async () => {
            await new Promise((resolve) => setTimeout(resolve, state.delay));
            return Result.ok();
          });
        });
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should wait for async transition on lock dispose", async () => {
      const send = await lock(context);
      const result = send(signals.start({ delay: 100 }));
      expect(result.kind).toBe(ResultKind.InTransition);

      vi.advanceTimersByTime(100);

      // dispose waits for transition to complete
      await send[Symbol.asyncDispose]();

      // lock released, can dispatch again
      expect(() => dispatch(context, signals.start({ delay: 50 }))).not.toThrow();
    });
  });

  describe("Result.enqueue", () => {
    let context: any;
    let testState: any;
    let signals: any;

    beforeEach(() => {
      signals = {
        activate: defineSignal("activate"),
        update: defineSignal<{ value: number }>("update"),
        fail: defineSignal("fail"),
      };

      testState = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("idle", true)
        .variant("active")
        .build();

      context = { test: { counter: 0 } };
    });

    it("should chain enqueued signal after dispatch", () => {
      defineFlow(testState.idle, {
        activate: () => testState.active({ counter: 1 }),
        update: (state: any, signal: any) => testState.active({ counter: signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      defineFlow(testState.active, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.active, () => {
          return Result.enqueue(signals.update({ value: 10 }));
        });
      });

      const result = dispatch(context, signals.activate());
      expect(result.kind).toBe(ResultKind.OK);
      // activate -> active(counter=1), then enqueued update(10) -> active(counter=11)
      expect(context.test.counter).toBe(11);
    });

    it("should chain multiple enqueued signals in order", () => {
      defineFlow(testState.idle, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      defineFlow(testState.active, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.active, () => {
          return Result.enqueue(signals.update({ value: 5 }));
        });
        sm.addUpdateHandler(testState.active, () => {
          return Result.ok();
        });
      });

      const result = dispatch(context, signals.activate());
      expect(result.kind).toBe(ResultKind.OK);
      // activate -> active(0), enqueue update(5) -> active(5)
      expect(context.test.counter).toBe(5);
    });

    it("should handle nested enqueue (enqueued handler also enqueues)", () => {
      let updateCount = 0;

      defineFlow(testState.idle, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      defineFlow(testState.active, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.active, () => {
          return Result.enqueue(signals.update({ value: 5 }));
        });
        sm.addUpdateHandler(testState.active, () => {
          updateCount++;
          // only enqueue once to avoid infinite loop
          if (updateCount === 1) {
            return Result.enqueue(signals.update({ value: 3 }));
          }
          return Result.ok();
        });
      });

      const result = dispatch(context, signals.activate());
      expect(result.kind).toBe(ResultKind.OK);
      // activate -> active(0), enqueue update(5) -> active(5), enqueue update(3) -> active(8)
      expect(context.test.counter).toBe(8);
    });

    it("should display enqueued signals in Result string representation", () => {
      const signal = signals.update({ value: 10 });
      const result = Result.enqueue(signal);

      expect(result.kind).toBe(ResultKind.OK);
      expect(result.enqueuedSignals).toHaveLength(1);
      expect(String(result)).toContain("Enqueue(");
    });
  });

  describe("Multi-Handler Enqueue Warning (warn-only guard)", () => {
    let context: any;
    let testState: any;
    let signals: any;
    let warnSpy: MockedFunction<typeof console.warn>;

    beforeEach(() => {
      signals = {
        activate: defineSignal("activate"),
        update: defineSignal<{ value: number }>("update"),
        fail: defineSignal("fail"),
      };

      testState = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("idle", true)
        .variant("active")
        .build();

      context = { test: { counter: 0 } };
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}) as MockedFunction<typeof console.warn>;
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("warns when two DIFFERENT handlers each enqueue a signal in one dispatch cycle", () => {
      defineFlow(testState.idle, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      defineFlow(testState.active, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      applyFlow(context, [testState], (sm) => {
        // exit-from-idle AND enter-to-active BOTH fire in the idle->active cycle,
        // and BOTH enqueue — the genuinely-forbidden two-different-handler co-enqueue.
        sm.addExitHandler(testState.idle, () => Result.enqueue(signals.update({ value: 1 })));
        sm.addEnterHandler(testState.active, () => Result.enqueue(signals.update({ value: 2 })));
      });

      const result = dispatch(context, signals.activate());

      expect(result.kind).toBe(ResultKind.OK);
      // The warning must have been emitted at least once.
      expect(warnSpy).toHaveBeenCalled();
      const warnedAtLeastOnceAboutEnqueue = warnSpy.mock.calls.some((args) =>
        args.some((arg) => typeof arg === "string" && /enqueue/i.test(arg)),
      );
      expect(warnedAtLeastOnceAboutEnqueue).toBe(true);
    });

    it("does NOT warn for a self-terminating nested record chain (single enqueue per cycle) and still works", () => {
      // Mirror of flow.spec.ts "should handle nested enqueue" — one enqueue per cycle.
      let updateCount = 0;

      defineFlow(testState.idle, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      defineFlow(testState.active, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: state.counter + signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.active, () => {
          return Result.enqueue(signals.update({ value: 5 }));
        });
        sm.addUpdateHandler(testState.active, () => {
          updateCount++;
          if (updateCount === 1) {
            return Result.enqueue(signals.update({ value: 3 }));
          }
          return Result.ok();
        });
      });

      const result = dispatch(context, signals.activate());

      expect(result.kind).toBe(ResultKind.OK);
      // activate -> active(0), enqueue update(5) -> active(5), enqueue update(3) -> active(8)
      expect(context.test.counter).toBe(8);
      // The blessed self-terminating chain enqueues at most ONE signal per cycle: no warning.
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("Full Rollback on Enqueue Failure", () => {
    let context: any;
    let testState: any;
    let signals: any;

    beforeEach(() => {
      signals = {
        activate: defineSignal("activate"),
        update: defineSignal<{ value: number }>("update"),
        fail: defineSignal("fail"),
      };

      testState = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("idle", true)
        .variant("active")
        .build();

      context = { test: { counter: 0 } };
    });

    it("should rollback to pre-chain state when enqueued signal fails", () => {
      defineFlow(testState.idle, {
        activate: () => testState.active({ counter: 1 }),
        update: (state: any, signal: any) => ({ counter: signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      defineFlow(testState.active, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.active, () => {
          // enqueue a signal that will cause the fail handler to reject
          return Result.enqueue(signals.fail());
        });
        sm.addExitHandler(testState.active, () => {
          return Result.reject("intentional failure in exit handler");
        });
      });

      const result = dispatch(context, signals.activate());
      // activate -> active(1), then enqueue fail() -> should try to exit active
      // exit handler rejects -> full rollback to idle(counter=0)
      expect(result.kind).toBe(ResultKind.Rejected);
      expect(context.test.counter).toBe(0);
      expect(String(context.test)).toContain("idle");
    });

    it("should rollback to pre-chain state with lock", async () => {
      defineFlow(testState.idle, {
        activate: () => testState.active({ counter: 1 }),
        update: (state: any, signal: any) => ({ counter: signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      defineFlow(testState.active, {
        activate: () => testState.active({ counter: 0 }),
        update: (state: any, signal: any) => ({ counter: signal.value }),
        fail: () => testState.idle({ counter: 0 }),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.active, () => {
          return Result.enqueue(signals.fail());
        });
        sm.addExitHandler(testState.active, () => {
          return Result.reject("intentional failure");
        });
      });

      await using send = await lock(context);
      const result = send(signals.activate());

      expect(result.kind).toBe(ResultKind.Rejected);
      expect(context.test.counter).toBe(0);
      expect(String(context.test)).toContain("idle");
    });
  });

  describe("Result.enqueue inside Result.transition", () => {
    let context: any;
    let testState: any;
    let signals: any;

    beforeEach(() => {
      signals = {
        start: defineSignal("start"),
        asyncStep: defineSignal("asyncStep"),
        followUp: defineSignal<{ value: number }>("followUp"),
      };

      testState = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("idle", true)
        .variant("loading")
        .variant("ready")
        .build();

      context = { test: { counter: 0 } };
    });

    it("should process enqueued signal after async transition resolves", async () => {
      defineFlow(testState.idle, {
        start: () => testState.loading({ counter: 0 }),
        followUp: (s: any, a: any) => testState.ready({ counter: a.value }),
      });

      defineFlow(testState.loading, {
        followUp: (s: any, a: any) => testState.ready({ counter: a.value }),
      });

      defineFlow(testState.ready, {});

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.loading, () => {
          return Result.transition(async () => {
            // Simulate async work
            await new Promise((r) => setTimeout(r, 10));
            // Enqueue a follow-up signal after async completes
            return Result.enqueue(signals.followUp({ value: 42 }));
          });
        });
      });

      await using send = await lock(context);
      const result = await send(signals.start()).done();

      // start → loading(0), async transition resolves,
      // enqueued followUp(42) → ready(42)
      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(42);
      expect(String(context.test)).toContain("ready");
    });

    it("should process enqueued signal from sync transition returning enqueue", async () => {
      defineFlow(testState.idle, {
        start: () => testState.loading({ counter: 0 }),
        followUp: (s: any, a: any) => testState.ready({ counter: a.value }),
      });

      defineFlow(testState.loading, {
        followUp: (s: any, a: any) => testState.ready({ counter: a.value }),
      });

      defineFlow(testState.ready, {});

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.loading, () => {
          return Result.transition(async () => {
            return Result.enqueue(signals.followUp({ value: 99 }));
          });
        });
      });

      await using send = await lock(context);
      const result = await send(signals.start()).done();

      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(99);
      expect(String(context.test)).toContain("ready");
    });

    it("should rollback enqueued-from-transition signal on failure", async () => {
      defineFlow(testState.idle, {
        start: () => testState.loading({ counter: 0 }),
        followUp: () => Result.reject("intentional reject"),
      });

      defineFlow(testState.loading, {
        followUp: () => Result.reject("intentional reject"),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addEnterHandler(testState.loading, () => {
          return Result.transition(async () => {
            return Result.enqueue(signals.followUp({ value: 1 }));
          });
        });
      });

      await using send = await lock(context);
      const result = await send(signals.start()).done();

      // start → loading, transition resolves, enqueued followUp rejected → rollback
      expect(result.kind).toBe(ResultKind.Rejected);
      expect(context.test.counter).toBe(0);
      expect(String(context.test)).toContain("idle");
    });
  });
});
