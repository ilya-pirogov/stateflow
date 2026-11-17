import { afterEach, beforeEach, describe, expect, it, type MockedFunction, vi } from "vitest";

import { applyFlow, dispatch, lock, observe } from "../flow";
import { HandlerResult, ResultKind, StateResult } from "../result";
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

    it("build() gives a definition named by .name() with a factory per variant", () => {
      const state = defineState<{ counter: number }>()
        .name("test")
        .signals(signals)
        .variant("initial", { initial: true })
        .variant("running")
        .stringRepr((s) => `count=${s.counter}`)
        .build();

      expect(state[Symbol.toStringTag]).toBe("test");
      expect(typeof state.initial).toBe("function");
      expect(typeof state.running).toBe("function");
    });

    it("build() throws without a name or without a variant", () => {
      expect(() => defineState<{ counter: number }>().signals(signals).build()).toThrow("Name was not provided");

      const partial = defineState<{ counter: number }>().name("test");
      expect(() => partial.build()).toThrow("No state variants are defined");

      const withSignals = partial.signals(signals);
      expect(() => withSignals.build()).toThrow("No state variants are defined");
    });

    it("should not allow multiple initial variants", () => {
      expect(() =>
        defineState<{ counter: number }>()
          .name("test")
          .signals(signals)
          .variant("first", { initial: true })
          .variant("second", { initial: true }),
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
        .variant("initial", { initial: true })
        .variant("running")
        .build();
    });

    it("a variant's reducers are defined once: a second defineFlow for it throws", () => {
      defineFlow(testState.initial, {
        next: (state: any, signal: any) => testState.running({ counter: signal.value }),
        reset: () => testState.initial({ counter: 0 }),
      });

      // Verify reducers are frozen after definition
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
        .variant("initial", { initial: true })
        .variant("running")
        .build();

      context = {
        test: { counter: 0 },
      };

      enterSpy = vi.fn(() => HandlerResult.ok());
      exitSpy = vi.fn(() => HandlerResult.ok());
      updateSpy = vi.fn(() => HandlerResult.ok());

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

    it("a reducer that returns another variant's instance commits it at once, with the old variant's exit and the new one's enter", () => {
      const result = dispatch(context, signals.next({ value: 5 }));

      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(5);
      expect(enterSpy).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledOnce();
    });

    it("a reducer that returns props keeps the variant, commits them and runs its update handler", () => {
      dispatch(context, signals.next({ value: 5 }));
      const result = dispatch(context, signals.next({ value: 3 }));

      expect(result.kind).toBe(ResultKind.OK);
      expect(context.test.counter).toBe(8);
      expect(updateSpy).toHaveBeenCalledOnce();
    });

    it("a reducer that returns the initial variant's instance commits it with its props", () => {
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
        .variant("idle", { initial: true })
        .variant("loading")
        .variant("done", { async: true })
        .variant("failed")
        .build();

      context = {
        test: { delay: 0 },
      };

      // The reducer declares the transition: loading commits at once, done or failed when the work ends.
      defineFlow(testState.idle, {
        async: (state: any, signal: any) =>
          StateResult.transition(
            testState.done({ delay: signal.delay }),
            testState.loading({ delay: signal.delay }),
            testState.failed({ delay: signal.delay }),
          ),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addTransitionHandler(testState.done, async (state: any) => {
          await new Promise((resolve) => setTimeout(resolve, state.delay));
          return HandlerResult.ok();
        });
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a declared transition commits temp at once and next when the work resolves OK", async () => {
      const result = dispatch(context, signals.async({ delay: 100 }));
      expect(result.kind).toBe(ResultKind.InTransition);
      expect(String(context.test)).toBe("test.loading(delay=100)");

      vi.advanceTimersByTime(100);
      const final = await result.done();

      expect(final.kind).toBe(ResultKind.OK);
      expect(String(context.test)).toBe("test.done(delay=100)");
    });

    it("a bare dispatch while a transition is pending throws", () => {
      dispatch(context, signals.async({ delay: 100 }));
      expect(() => dispatch(context, signals.async({ delay: 100 }))).toThrow("A transition is pending");
    });

    it("the default 500 ms timeout commits failed with a TransitionAborted of kind timeout naming the path and the variant", async () => {
      const result = dispatch(context, signals.async({ delay: 1000 }));
      vi.advanceTimersByTime(501); // Default timeout is 500ms

      const final = await result.done();
      expect(final.kind).toBe(ResultKind.Error);
      expect(final.error).toMatchObject({
        kind: "timeout",
        message:
          "test did not reach test.done within 500 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.",
      });
      expect(String(context.test)).toBe("test.failed(delay=1000)");
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

      testState = defineState<{ value: number }>()
        .name("test")
        .signals(signals)
        .variant("active", { initial: true })
        .build();

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

    it("disposing an observer stops only that observer: another observe() with the same callback on the same variant is still told", async () => {
      const first = observe(context, [testState.active], observerSpy);
      using _second = observe(context, [testState.active], observerSpy);

      first[Symbol.dispose]();
      dispatch(context, signals.update({ value: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 1));

      expect(observerSpy).toHaveBeenCalledOnce();
    });

    it("one observe() takes the variants of several top-level states and is told of each change", async () => {
      const ping = defineSignal("ping");
      const left = defineState<{ n: number }>().name("left").signals({ ping }).variant("a", { initial: true }).build();
      const right = defineState<{ m: number }>()
        .name("right")
        .signals({ ping })
        .variant("a", { initial: true })
        .build();
      defineFlow(left.a, { ping: (s) => ({ n: s.n + 1 }) });
      defineFlow(right.a, { ping: (s) => ({ m: s.m + 1 }) });
      const target = { left: { n: 0 }, right: { m: 0 } };
      applyFlow(target, [left, right], () => {});
      const seen: string[] = [];
      using _ = observe(target, [left.a, right.a], (state) => {
        seen.push(String(state));
      });

      dispatch(target, ping());
      await new Promise((resolve) => setTimeout(resolve, 1));

      expect(seen).toEqual(["left.a(n=1)", "right.a(m=1)"]);
    });

    it("should only notify when compare function returns true", async () => {
      using _ = observe(context, [testState.active], observerSpy, (prev: any, curr: any) => prev.value > curr.value);

      dispatch(context, signals.update({ value: 1 })); // 0 -> 1
      dispatch(context, signals.update({ value: 0 })); // 1 -> 0
      await new Promise((resolve) => setTimeout(resolve, 1));

      expect(observerSpy).toHaveBeenCalledOnce();
      expect((observerSpy.mock.calls[0][0] as any).value).toBe(0);
    });

    it("observers are told after every state of the commit is set: a compare on one state reads the other state's new instance on the target", () => {
      const ping = defineSignal("ping");
      const left = defineState<{ n: number }>().name("left").signals({ ping }).variant("a", { initial: true }).build();
      const right = defineState<{ n: number }>()
        .name("right")
        .signals({ ping })
        .variant("a", { initial: true })
        .build();
      defineFlow(left.a, { ping: (s) => ({ n: s.n + 1 }) });
      defineFlow(right.a, { ping: (s) => ({ n: s.n + 1 }) });
      const target = { left: { n: 0 }, right: { n: 0 } };
      applyFlow(target, [left, right], () => {});
      const seen: string[] = [];
      using _ = observe(
        target,
        [left.a],
        () => {},
        () => {
          seen.push(String(target.right));
          return true;
        },
      );

      dispatch(target, ping());

      expect(seen).toEqual(["right.a(n=1)"]);
    });

    it("an observer whose callback throws breaks nothing: the other observers are still told, and console.error reports it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const thrown = new Error("callback boom");
        using _failing = observe(context, [testState.active], function failing() {
          throw thrown;
        });
        using _ = observe(context, [testState.active], observerSpy);

        expect(dispatch(context, signals.update({ value: 1 })).kind).toBe(ResultKind.OK);
        await new Promise((resolve) => setTimeout(resolve, 1));

        expect(observerSpy).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledWith("[SF/Object] observer failing on test.active threw:", thrown);
      } finally {
        error.mockRestore();
      }
    });

    it("takes a nested state's variant, which fires with the node's path, and a variant of a state outside the flow, which never fires", async () => {
      const part = defineState<{ n: number }>().name("part").variant("on", { initial: true }).build();
      const outside = defineState<{ n: number }>().name("outside").variant("on", { initial: true }).build();
      const holder = defineState<{ part: ReturnType<typeof part.on> }>()
        .name("holder")
        .signals(signals)
        .variant("x", { initial: true })
        .build();
      defineFlow(holder.x, { update: (_h: unknown, signal: any) => ({ part: part.on({ n: signal.value }) }) });
      const target = { holder: { part: part.on({ n: 0 }) } };
      applyFlow(target, [holder], () => {});

      using _nested = observe(target, [part.on], observerSpy);
      // Cast, as a loosely typed target would pass it: the variant's type refuses it. At run time a nested state that
      // no node holds yet cannot be told from it, so observe() takes it.
      using _outside = observe(target, [outside.on] as never, observerSpy);

      dispatch(target, signals.update({ value: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(observerSpy.mock.calls).toEqual([[target.holder.part, "holder.part"]]);
    });
  });

  describe("Utility Functions", () => {
    it("should detect state instances", () => {
      const state = defineState<{ value: number }>()
        .name("test")
        .signals({})
        .variant("test", { initial: true })
        .build();

      const instance = state.test({ value: 0 });
      expect(isState(instance)).toBe(true);
      expect(isState({})).toBe(false);
    });

    it("a string within the 25-character limit prints whole in an instance's string form", () => {
      const signals = {
        test: defineSignal<{ value: string }>("test"),
      };

      const state = defineState<{ value: string }>()
        .name("test")
        .signals(signals)
        .variant("test", { initial: true })
        .build();

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
        .variant("initial", { initial: true })
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

    it("a released lock passes straight to the next waiter: many concurrent lock() calls never invalidate a woken waiter's handle", async () => {
      // N independent async callbacks each acquire the same target's lock as their work resolves. A hand-off that
      // nulled lockHolder before the woken waiter resumed would leave a window where a racing lock() claims it and
      // invalidates the woken waiter's handle ("Lock has been released"). Each task yields a varying number of
      // microtasks before locking to maximize interleaving across the hand-off window.
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
        .variant("idle", { initial: true })
        .variant("loading")
        .variant("loaded", { async: true })
        .variant("failed")
        .build();

      context = { test: { delay: 0 } };

      defineFlow(testState.idle, {
        start: (state: any, signal: any) =>
          StateResult.transition(
            testState.loaded({ delay: signal.delay }),
            testState.loading({ delay: signal.delay }),
            testState.failed({ delay: signal.delay }),
          ),
      });

      applyFlow(context, [testState], (sm) => {
        sm.addTransitionHandler(testState.loaded, async (state: any) => {
          await new Promise((resolve) => setTimeout(resolve, state.delay));
          return HandlerResult.ok();
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

      let disposed = false;
      // dispose waits for transition to complete
      const disposing = send[Symbol.asyncDispose]().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(disposed).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await disposing;

      // lock released and the transition ended, so a bare dispatch reaches the reducers again
      expect(String(context.test)).toBe("test.loaded(delay=100)");
      expect(() => dispatch(context, signals.start({ delay: 50 }))).not.toThrow();
    });
  });
});
