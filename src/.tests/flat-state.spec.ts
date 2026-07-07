import { describe, expect, it } from "vitest";

import { defineSignal, defineState, StateFlowError } from "..";
import { Box } from "../box";
import { FrozenSet } from "../frozen-collections";

const noop = defineSignal("noop");

function build<T>(props: T) {
  const st = defineState<T>().name("t").signals({ noop }).variant("idle", true).build();
  return st.idle(props);
}

describe("sealProps", () => {
  it("deep-freezes plain nested objects and arrays", () => {
    const inst = build({ meta: { nested: { x: 1 } }, list: [{ id: 1 }] });
    expect(Object.isFrozen(inst.meta)).toBe(true);
    expect(Object.isFrozen(inst.meta.nested)).toBe(true);
    expect(Object.isFrozen(inst.list)).toBe(true);
    expect(Object.isFrozen(inst.list[0])).toBe(true);
  });

  it("accepts + freezes immutable-value-like props", () => {
    const err = new Error("boom");
    const inst = build({ error: err, re: /x/ });
    expect(Object.isFrozen(inst.error)).toBe(true);
    expect(inst.error).toBe(err);
  });

  it("skips Boxes — contents stay live", () => {
    const live = { mutable: 1 };
    const inst = build({ handle: Box.of(live) });
    expect(Object.isFrozen(inst.handle)).toBe(true); // wrapper frozen
    inst.handle.deref().mutable = 2; // interior NOT frozen
    expect(live.mutable).toBe(2);
  });

  it("accepts a FrozenSet without throwing", () => {
    expect(() => build({ caps: new FrozenSet(["a", "b"]) })).not.toThrow();
  });

  it("throws on a raw Set", () => {
    expect(() => build({ raw: new Set([1]) })).toThrow(StateFlowError);
    expect(() => build({ raw: new Set([1]) })).toThrow(/Box\(/);
  });

  it("throws on an unfrozen live class instance", () => {
    class Live {}
    expect(() => build({ inst: new Live() })).toThrow(StateFlowError);
    expect(() => build({ inst: new Live() })).toThrow(/Box\(/);
  });
});
