import { describe, expect, it } from "vitest";

import { FrozenMap, FrozenSet } from "../frozen-collections";
import { FROZEN } from "../symbols";

describe("FrozenSet", () => {
  it("constructs from an iterable and is frozen + branded", () => {
    const fs = new FrozenSet([1, 2, 3]);
    expect(fs.has(2)).toBe(true);
    expect(fs.size).toBe(3);
    expect([...fs]).toEqual([1, 2, 3]);
    expect(Object.isFrozen(fs)).toBe(true);
    expect(Reflect.has(fs, FROZEN)).toBe(true);
  });

  it("throws on every mutator", () => {
    const fs = new FrozenSet([1]);
    expect(() => fs.add(2)).toThrow("immutable");
    expect(() => fs.delete(1)).toThrow("immutable");
    expect(() => fs.clear()).toThrow("immutable");
  });

  it("exposes read-only set algebra returning plain Sets", () => {
    const fs = new FrozenSet([1, 2, 3]);
    const inter = fs.intersection(new Set([2, 3, 4]));
    const sym = fs.symmetricDifference(new Set([2, 3, 4]));
    expect(inter instanceof FrozenSet).toBe(false);
    expect([...inter].sort()).toEqual([2, 3]);
    expect([...sym].sort()).toEqual([1, 4]);
  });
});

describe("FrozenMap", () => {
  it("constructs, reads, and throws on mutators", () => {
    const fm = new FrozenMap<string, number>([["a", 1]]);
    expect(fm.get("a")).toBe(1);
    expect(fm.size).toBe(1);
    expect(Reflect.has(fm, FROZEN)).toBe(true);
    expect(() => fm.set("b", 2)).toThrow("immutable");
    expect(() => fm.delete("a")).toThrow("immutable");
    expect(() => fm.clear()).toThrow("immutable");
  });
});
