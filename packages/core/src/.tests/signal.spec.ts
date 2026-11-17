import { describe, expect, it } from "vitest";

import { defineSignal } from "../signal";
import { SIGNAL } from "../symbols";

describe("Signal Module", () => {
  describe("defineSignal", () => {
    it("should create a signal definition without arguments", () => {
      const play = defineSignal("play");
      const signal = play();

      expect(signal[SIGNAL]).toBe(true);
      expect(String(signal)).toBe("play{}");
      expect(Object.keys(signal)).toHaveLength(0); // SIGNAL is not enumerated
    });

    it("should create a signal definition with arguments", () => {
      const seek = defineSignal<{ time: number }>("seek", (a) => String(a.time));
      const signal = seek({ time: 100 });

      expect(signal[SIGNAL]).toBe(true);
      expect(String(signal)).toBe("seek{100}");
      expect(signal).toHaveProperty("time", 100);
    });

    it("should maintain argument types correctly", () => {
      type VolumeArgs = {
        level: number;
        muted?: boolean;
      };

      const volume = defineSignal<VolumeArgs>("volume");
      const signal = volume({ level: 0.5, muted: true });

      expect(signal.level).toBe(0.5);
      expect(signal.muted).toBe(true);
    });

    it("should stringify signal without arguments correctly", () => {
      const stop = defineSignal("stop");
      const signal = stop();

      expect(String(signal)).toBe("stop{}");
    });

    it("should stringify signal with arguments correctly", () => {
      const volume = defineSignal<{ level: number }>("volume");
      const signal = volume({ level: 0.7 });

      expect(String(signal)).toBe("volume{level=0.7}");
    });

    it("should freeze the signal object for immutability", () => {
      const signal = defineSignal("test")();

      expect(Object.isFrozen(signal)).toBe(true);

      // Attempt to modify should fail in strict mode
      expect(() => {
        (signal as any).newProp = "value";
      }).toThrow();
    });

    it("should preserve the original argument object structure", () => {
      type ComplexArgs = {
        nested: {
          value: number;
          flag: boolean;
        };
        list: string[];
      };

      const complex = defineSignal<ComplexArgs>("complex");
      const args = {
        nested: { value: 42, flag: true },
        list: ["a", "b"],
      };

      const signal = complex(args);

      expect(signal.nested).toEqual(args.nested);
      expect(signal.list).toEqual(args.list);
    });

    it("should create unique signal instances", () => {
      const signal = defineSignal<{ value: number }>("test");

      const instance1 = signal({ value: 1 });
      const instance2 = signal({ value: 1 });

      expect(instance1).not.toBe(instance2);
      expect(instance1.value).toBe(1);
      expect(instance2.value).toBe(1);
    });
  });
});
