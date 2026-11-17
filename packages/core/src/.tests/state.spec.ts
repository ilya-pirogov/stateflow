import { beforeEach, describe, expect, it, vi } from "vitest";

import { defineFlow, defineSignal, defineState, isState, Result } from "..";
import { getInitialState, getName } from "../state";
import { HANDLERS, VARIANT } from "../symbols";

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
        .variant("initial", true)
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
        defineState<{ count: number }>().signals(signals).variant("initial", true).build();
      }).toThrow("Name was not provided");
    });

    it("should throw error when building without signals", () => {
      expect(() => {
        defineState<{ count: number }>().name("counter").variant("initial", true).build();
      }).toThrow("Signals were not provided");
    });

    it("should throw error when building without variants", () => {
      expect(() => {
        defineState<{ count: number }>().name("counter").signals(signals).build();
      }).toThrow("No state variants are defined");
    });

    it("should throw error when defining multiple initial variants", () => {
      expect(() => {
        defineState<{ count: number }>()
          .name("counter")
          .signals(signals)
          .variant("initial", true)
          .variant("active", true)
          .build();
      }).toThrow("Only one initial state variant is allowed");
    });
  });

  describe("defineFlow", () => {
    const signals = {
      increment: () => ({ type: "increment" }),
      reset: () => ({ type: "reset" }),
    };

    let counterState: any;
    let initialHandler: any;

    beforeEach(() => {
      counterState = defineState<{ count: number }>()
        .name("counter")
        .signals(signals)
        .variant("initial", true)
        .variant("active")
        .build();

      initialHandler = {
        increment: vi.fn().mockReturnValue({ count: 1 }),
        reset: vi.fn().mockReturnValue(Result.ignore("nothing to reset")),
      };
    });

    it("should define handlers for state variant", () => {
      defineFlow(counterState.initial, initialHandler);

      const state = counterState.initial({ count: 0 });
      const signal = signals.increment();
      const result = state[VARIANT][HANDLERS].increment(state, signal, {});

      expect(result).toEqual({ count: 1 });
      expect(initialHandler.increment).toHaveBeenCalledTimes(1);
    });

    it("should freeze handlers after definition", () => {
      defineFlow(counterState.initial, initialHandler);

      expect(() => {
        counterState.initial[Symbol.for("HANDLERS")].newHandler = () => {};
      }).toThrow();
    });

    it("should throw error when redefining flow", () => {
      defineFlow(counterState.initial, initialHandler);

      expect(() => {
        defineFlow(counterState.initial, initialHandler);
      }).toThrow("Flow is already defined");
    });
  });

  describe("State Instance", () => {
    const signals = {
      update: () => ({ type: "update" }),
    };

    let testState: any;

    beforeEach(() => {
      testState = defineState<{ value: string }>()
        .name("test")
        .signals(signals)
        .variant("initial", true)
        .variant("updated")
        .build();
    });

    it("should be immutable", () => {
      const state = testState.initial({ value: "test" });

      expect(() => {
        state.value = "modified";
      }).toThrow();
    });

    it("should have correct string representation", () => {
      const state = testState.initial({ value: "test" });
      expect(String(state)).toBe("test.initial(value=test)");
    });

    it("should preserve variant information", () => {
      const state = testState.initial({ value: "test" });
      expect(state[VARIANT]).toBe(testState.initial);
    });
  });

  describe("Helper Functions", () => {
    const signals = {
      test: () => ({ type: "test" }),
    };

    let testState: any;

    beforeEach(() => {
      testState = defineState<{ flag: boolean }>()
        .name("test")
        .signals(signals)
        .variant("initial", true)
        .variant("final")
        .build();
    });

    it("isState should correctly identify state instances", () => {
      const state = testState.initial({ flag: true });
      const notState = { flag: true };

      expect(isState(state)).toBe(true);
      expect(isState(notState)).toBe(false);
    });

    it("getInitialState should return correct initial variant", () => {
      const initialVariant = getInitialState(testState);
      expect(initialVariant).toBe(testState.initial);
    });

    it("getName should return state definition name", () => {
      expect(getName(testState)).toBe("test");
    });
  });
});
