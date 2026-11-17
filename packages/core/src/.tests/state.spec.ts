import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  isState,
  isVariant,
  ResultKind,
  StateResult,
  stateVar,
} from "..";
import { getInitialState, getName } from "../state";
import { IS_ASYNC, SIGNAL_REDUCERS, SIGNALS, VARIANT } from "../symbols";

describe("State Management Module", () => {
  describe("defineState", () => {
    const signals = {
      increment: defineSignal("increment"),
      reset: defineSignal("reset"),
    };

    let counterState: any;

    beforeEach(() => {
      counterState = defineState<{ count: number }>()
        .name("counter")
        .signals(signals)
        .variant("initial", { initial: true })
        .variant("active")
        .variant("paused")
        .stringRepr((s) => `count=${s.count}`)
        .build();
    });

    it("should create state definition with specified variants", () => {
      expect(counterState).toHaveProperty("initial");
      expect(counterState).toHaveProperty("active");
      expect(counterState).toHaveProperty("paused");
    });

    it("should create state instances with correct properties", () => {
      const state = counterState.initial({ count: 0 });
      expect(state).toHaveProperty("count", 0);
      expect(String(state)).toBe("counter.initial(count=0)");
    });

    it("should throw error when building without name", () => {
      expect(() => {
        defineState<{ count: number }>().signals(signals).variant("initial", { initial: true }).build();
      }).toThrow("Name was not provided");
    });

    it("a state without .signals() builds with a frozen empty signals object, and dispatches with the others", () => {
      const toggle = defineSignal("toggle");
      const lamp = defineState<{ on: boolean }>().name("lamp").variant("off", { initial: true }).variant("on").build();
      const button = defineState<{ n: number }>()
        .name("button")
        .signals({ toggle })
        .variant("up", { initial: true })
        .variant("down")
        .build();
      defineFlow(button.up, { toggle: (s) => button.down(s) });

      expect(Object.keys(lamp[SIGNALS] as object)).toEqual([]);
      expect(Object.isFrozen(lamp[SIGNALS])).toBe(true);

      const alone = { lamp: { on: false } };
      applyFlow(alone, [lamp], () => {});
      const ignored = dispatch(alone, toggle());
      expect(ignored.kind).toBe(ResultKind.Ignored);
      expect(ignored.message).toBe("no reducer for toggle in lamp.off");

      const both = { lamp: { on: false }, button: { n: 0 } };
      applyFlow(both, [lamp, button], () => {});
      expect(dispatch(both, toggle()).kind).toBe(ResultKind.OK);
      expect([String(both.lamp), String(both.button)]).toEqual(["lamp.off(on=F)", "button.down(n=0)"]);
    });

    it("variant(name, { initial: true }) marks the variant applyFlow starts in; other variants are not initial", () => {
      const s = defineState<{ n: number }>()
        .name("s")
        .variant("a")
        .variant("b", { initial: true })
        .variant("c", {})
        .build();

      const target = { s: { n: 1 } };
      applyFlow(target, [s], () => {});
      expect(stateVar(target.s)).toBe(s.b);
    });

    it("variant(name, { results }) declares the named results of that variant only: build() puts a factory per result on its results", () => {
      const s = defineState<{ n: number }>()
        .name("s")
        .variant("a", { initial: true, results: { done: (data) => Number(data), noted: (data) => String(data) } })
        .variant("b")
        .build();

      expect(Object.keys(s.a.results)).toEqual(["done", "noted"]);
      expect(Object.keys(s.b.results)).toEqual([]);
      expect(String(s.a.results.done(1))).toBe("OK(done)");
    });

    it("build() refuses a variant named items, which is the definition's items() method", () => {
      expect(() => defineState<{ n: number }>().name("bag").variant("items", { initial: true }).build()).toThrow(
        "bag: a variant cannot be named items, which is the definition's items() method",
      );
    });

    it("should throw error when building without variants", () => {
      expect(() => {
        defineState<{ count: number }>().name("counter").signals(signals).build();
      }).toThrow("No state variants are defined");
    });

    it("variant(name, { initial, transitional }) throws: applyFlow would commit a transitional variant with no transition", () => {
      expect(() =>
        defineState<{ count: number }>().name("counter").variant("loading", { initial: true, transitional: true }),
      ).toThrow("loading: an initial variant cannot be transitional");
    });

    it("variant(name, { async }) marks the variant asynchronous, readable on it; the other variants are not", () => {
      const driver = defineState<{ url: string }>()
        .name("driver")
        .variant("idle", { initial: true })
        .variant("activating", { transitional: true })
        .variant("active", { async: true })
        .variant("failed", { async: false })
        .build();

      expect(
        [driver.idle, driver.activating, driver.active, driver.failed].map((variant) => variant[IS_ASYNC]),
      ).toEqual([false, false, true, false]);
    });

    it("async with initial throws, since applyFlow commits the initial variant with no transition; async with transitional throws, since a temp's entry is synchronous", () => {
      expect(() =>
        defineState<{ url: string }>().name("driver").variant("active", { initial: true, async: true }),
      ).toThrow("active: an initial variant cannot be asynchronous");
      expect(() =>
        defineState<{ url: string }>().name("driver").variant("loading", { transitional: true, async: true }),
      ).toThrow("loading: a transitional variant cannot be asynchronous");
    });

    it("build() refuses a signal listed under a key that is not its name: reducers are keyed by the signal's name", () => {
      const start = defineSignal("start");

      expect(() =>
        defineState<{ n: number }>()
          .name("dashboard")
          .signals({ engineStarted: start })
          .variant("dark", { initial: true })
          .build(),
      ).toThrow(
        "dashboard: the signal start is listed under the key engineStarted; a reducer keyed engineStarted would never run",
      );
    });

    it("the factory refuses a parser output that is not a plain object: an engine rebuild copies props without a constructor", () => {
      class Props {
        readonly #secret = 1;
        constructor(readonly count: number) {}
        get secret(): number {
          return this.#secret;
        }
      }
      const outputs: Array<[string, (p: object) => { count: number }]> = [
        ["a class instance", (p) => new Props((p as { count: number }).count)],
        ["an array", () => [] as never],
        ["a primitive", () => 1 as never],
      ];
      for (const [label, parse] of outputs) {
        const counter = defineState<{ count: number }>()
          .name("counter")
          .variant("x", { initial: true })
          .parser(parse)
          .build();

        expect(() => counter.x({ count: 1 }), label).toThrow(
          "counter.x: the parser returned something other than a plain object (prototype Object.prototype or null)",
        );
      }
      // Object.prototype or null is a plain object.
      const bare = defineState<{ count: number }>()
        .name("counter")
        .variant("x", { initial: true })
        .parser((p) => Object.assign(Object.create(null), p))
        .build();
      expect(bare.x({ count: 1 }).count).toBe(1);
    });

    it("should throw error when defining multiple initial variants", () => {
      expect(() => {
        defineState<{ count: number }>()
          .name("counter")
          .signals(signals)
          .variant("initial", { initial: true })
          .variant("active", { initial: true })
          .build();
      }).toThrow("Only one initial state variant is allowed");
    });
  });

  describe("defineFlow", () => {
    const signals = {
      increment: defineSignal("increment"),
      reset: defineSignal("reset"),
    };

    let counterState: any;
    let initialReducers: any;

    beforeEach(() => {
      counterState = defineState<{ count: number }>()
        .name("counter")
        .signals(signals)
        .variant("initial", { initial: true })
        .variant("active")
        .build();

      initialReducers = {
        increment: vi.fn().mockReturnValue({ count: 1 }),
        reset: vi.fn().mockReturnValue(StateResult.ignored("nothing to reset")),
      };
    });

    it("defineFlow puts the reducers on the variant, keyed by their signal's name", () => {
      defineFlow(counterState.initial, initialReducers);

      const state = counterState.initial({ count: 0 });
      const signal = signals.increment();
      const result = state[VARIANT][SIGNAL_REDUCERS].increment(state, signal, {});

      expect(result).toEqual({ count: 1 });
      expect(initialReducers.increment).toHaveBeenCalledTimes(1);
    });

    it("should freeze reducers after definition", () => {
      defineFlow(counterState.initial, initialReducers);

      expect(() => {
        counterState.initial[SIGNAL_REDUCERS].newReducer = () => {};
      }).toThrow();
    });

    it("should throw error when redefining flow", () => {
      defineFlow(counterState.initial, initialReducers);

      expect(() => {
        defineFlow(counterState.initial, initialReducers);
      }).toThrow("Flow is already defined");
    });
  });

  describe("State Instance", () => {
    const signals = {
      update: defineSignal("update"),
    };

    let testState: any;

    beforeEach(() => {
      testState = defineState<{ value: string }>()
        .name("test")
        .signals(signals)
        .variant("initial", { initial: true })
        .variant("updated")
        .build();
    });

    it("an instance is frozen: assigning a prop throws", () => {
      const state = testState.initial({ value: "test" });

      expect(() => {
        state.value = "modified";
      }).toThrow();
    });

    it("an instance prints as <state>.<variant>(<props>)", () => {
      const state = testState.initial({ value: "test" });
      expect(String(state)).toBe("test.initial(value=test)");
    });

    it("an instance carries its variant under VARIANT", () => {
      const state = testState.initial({ value: "test" });
      expect(state[VARIANT]).toBe(testState.initial);
    });
  });

  describe("Helper Functions", () => {
    const signals = {
      test: defineSignal("test"),
    };

    let testState: any;

    beforeEach(() => {
      testState = defineState<{ flag: boolean }>()
        .name("test")
        .signals(signals)
        .variant("initial", { initial: true })
        .variant("final")
        .build();
    });

    it("isState should correctly identify state instances", () => {
      const state = testState.initial({ flag: true });
      const notState = { flag: true };

      expect(isState(state)).toBe(true);
      expect(isState(notState)).toBe(false);
    });

    it("isVariant tells a variant from a definition, an instance and any other function", () => {
      expect(isVariant(testState.initial)).toBe(true);
      expect(isVariant(testState)).toBe(false);
      expect(isVariant(testState.initial({ flag: true }))).toBe(false);
      expect(isVariant(() => {})).toBe(false);
    });

    it("the initial variant is the one declared with { initial: true }", () => {
      const initialVariant = getInitialState(testState);
      expect(initialVariant).toBe(testState.initial);
    });

    it("a definition's name is the one given to .name()", () => {
      expect(getName(testState)).toBe("test");
    });

    it("a definition called on a snapshot returns its own instance there, and throws for another definition's instance under its name", () => {
      const power = defineState<{ on: boolean }>().name("power").variant("off", { initial: true }).build();
      const twin = defineState<{ on: boolean }>().name("power").variant("off", { initial: true }).build();
      const longer = defineState<{ on: boolean }>().name("powerful").variant("off", { initial: true }).build();
      const own = power.off({ on: false });
      expect(power({ power: own })).toBe(own);
      expect(() => power({ power: twin.off({ on: false }) })).toThrow("State not found: power");
      expect(() => power({ power: longer.off({ on: false }) })).toThrow("State not found: power");
    });
  });
});
