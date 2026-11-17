import { describe, expect, it, vi } from "vitest";

import { applyFlow, defineFlow, defineSignal, defineState, dispatch, ResultKind, subscribeFlow } from "../index";

// Minimal two-variant flow for the test. Real `@state-flow/core` API:
// applyFlow(target, [definition], initializer) and signals built via defineSignal.
const toggle = defineSignal("toggle");

const light = defineState<{ n: number }>()
  .name("light")
  .signals({ toggle })
  .variant("off", { initial: true })
  .variant("on")
  .parser((s) => ({ n: 0, ...s }))
  .build();

defineFlow(light.off, {
  toggle: (s: { n: number }) => light.on({ n: s.n + 1 }),
});
defineFlow(light.on, {
  toggle: (s: { n: number }) => light.off({ n: s.n + 1 }),
});

type FlowTarget = { light: unknown };

function make(name = "light"): FlowTarget {
  const target = { [Symbol.toStringTag]: name, light: { n: 0 } };
  applyFlow(target as never, [light], () => {});
  return target as FlowTarget;
}

// The shape delivered to a subscriber; kept local so the test reads independently
// of the exported type.
type Change = {
  flowName: string;
  stateName: string;
  prevVariant: string;
  nextVariant: string;
  signal: string;
  prev: { n: number };
  next: { n: number };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("subscribeFlow", () => {
  it("delivers a FlowChange with real prev/next on commit (post-commit macrotask)", async () => {
    const target = make();
    const seen: Change[] = [];
    using _sub = subscribeFlow(target, (c) => seen.push(c as unknown as Change));

    dispatch(target, toggle());
    expect(seen).toHaveLength(0); // not synchronous

    await tick();
    expect(seen).toHaveLength(1);
    const c = seen[0];
    expect(c.flowName).toBe("light");
    expect(c.stateName).toBe("light");
    expect(c.prevVariant).toBe("off");
    expect(c.nextVariant).toBe("on");
    // real, readable instances — props on prev/next reflect before/after state
    expect(c.prev.n).toBe(0);
    expect(c.next.n).toBe(1);
  });

  it("flowName is the flow container name, distinct from the state name", async () => {
    const target = make("myFlow");
    const seen: Change[] = [];
    using _sub = subscribeFlow(target, (c) => seen.push(c as unknown as Change));

    dispatch(target, toggle());
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0].flowName).toBe("myFlow");
    expect(seen[0].stateName).toBe("light");
  });

  it("stops delivering after dispose", async () => {
    const target = make();
    const cb = vi.fn();
    const sub = subscribeFlow(target, cb);
    sub[Symbol.dispose]();
    dispatch(target, toggle());
    await tick();
    expect(cb).not.toHaveBeenCalled();
  });

  it("a throwing subscriber breaks neither the commit nor the other subscribers, and console.error reports it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const target = make();
      const good = vi.fn();
      const thrown = new Error("boom");
      using _a = subscribeFlow(target, function failing() {
        throw thrown;
      });
      using _b = subscribeFlow(target, good);

      const result = dispatch(target, toggle());

      expect(result.kind).toBe(ResultKind.OK);
      expect(String(target.light)).toContain("light.on");
      await tick();
      expect(good).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[SF/light] subscriber failing threw:", thrown);
    } finally {
      error.mockRestore();
    }
  });

  it("is zero-cost with no subscribers (dispatch unaffected)", () => {
    const target = make();
    const result = dispatch(target, toggle());
    expect(result.kind).toBe(ResultKind.OK);
    expect(String((target as { light: unknown }).light)).toContain("light.on");
  });
});
