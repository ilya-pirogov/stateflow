import { describe, expect, it } from "vitest";

import { defineSignal, defineState, StateFlowError } from "..";
import { Box } from "../box";
import { FrozenMap, FrozenSet } from "../collections";

const noop = defineSignal("noop");

function build<T>(props: T) {
  const st = defineState<T>().name("t").signals({ noop }).variant("idle", { initial: true }).build();
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

  describe("nested states inside data", () => {
    const part = defineState<{ n: number }>().name("part").variant("on", { initial: true }).build();
    const inst = part.on({ n: 1 });
    const items = part.items().with("a", inst);

    it("accepts an instance or an Items held directly in a prop: a nested state", () => {
      expect(() => build({ one: inst, many: items })).not.toThrow();
    });

    it("refuses an instance or an Items inside an array, a plain object, a FrozenMap or a FrozenSet, frozen or not", () => {
      const holders: Array<[string, (x: object) => unknown]> = [
        ["an array", (x) => [x]],
        ["a frozen array", (x) => Object.freeze([x])],
        ["a plain object", (x) => ({ deep: { x } })],
        ["a frozen plain object", (x) => Object.freeze({ deep: Object.freeze({ x }) })],
        ["a FrozenMap value", (x) => new FrozenMap([["k", x]])],
        ["a FrozenMap key", (x) => new FrozenMap([[x, 1]])],
        ["a FrozenSet element", (x) => new FrozenSet([x])],
      ];
      for (const [label, hold] of holders) {
        for (const nested of [inst, items]) {
          expect(() => build({ data: hold(nested) }), `${label}, ${String(nested)}`).toThrow(StateFlowError);
          expect(() => build({ data: hold(nested) }), `${label}, ${String(nested)}`).toThrow(
            `State prop \`data\` holds ${String(nested)} inside its data; a nested state goes directly in a prop`,
          );
        }
      }
    });

    it("refuses one inside a shared frozen default, and a FrozenMap of instances", () => {
      const sharedDefault = Object.freeze({
        list: Object.freeze([Object.freeze({ id: 1 }), Object.freeze({ part: inst })]),
      });
      expect(() => build({ config: sharedDefault })).toThrow(`holds ${String(inst)} inside its data`);
      expect(() => build({ members: new FrozenMap([["a", inst]]) })).toThrow(`holds ${String(inst)} inside its data`);
    });

    it("does not walk a Box's content", () => {
      expect(() => build({ handle: Box.of({ part: inst, items: [items] }) })).not.toThrow();
    });
  });
});
