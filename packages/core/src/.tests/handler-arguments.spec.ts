import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  HandlerResult,
  type InstanceOf,
  type Items,
  type StateInstance,
  StateResult,
} from "..";

/**
 * What a handler receives: the instance it is about (for an exit handler, the instance it leaves), the
 * step's snapshot, which is frozen, the previous instance as the third argument, and a nested state's key in its
 * parent's Items as the fourth (undefined at the top level and for a single nested state). An enter or update handler
 * gets its step's AbortSignal as a fifth, a transition handler its transition's.
 */
describe("handler arguments", () => {
  const toggle = defineSignal("toggle");
  const bump = defineSignal("bump");

  const light = defineState<{ n: number }>()
    .name("light")
    .signals({ toggle, bump })
    .variant("off", { initial: true })
    .variant("on")
    .build();
  defineFlow(light.off, { toggle: (s) => light.on({ n: s.n + 1 }) });
  defineFlow(light.on, { bump: (s) => ({ n: s.n + 1 }) });

  // No reducer changes `other`, so a write into the snapshot is the only way it could change.
  const other = defineState<{ v: number }>()
    .name("other")
    .signals({ toggle, bump })
    .variant("idle", { initial: true })
    .variant("forged")
    .build();

  type Target = { light: StateInstance<{ n: number }>; other: StateInstance<{ v: number }> };

  function make(init: Parameters<typeof applyFlow>[2]): Target {
    const target = { light: { n: 0 }, other: { v: 0 } };
    applyFlow(target, [light, other], init);
    return target as unknown as Target;
  }

  it("an exit handler receives the instance it leaves", () => {
    const seen: unknown[] = [];
    const target = make((sm) => {
      sm.addExitHandler(light.off, (state) => {
        seen.push(state);
        return HandlerResult.ok();
      });
    });
    const left = target.light;

    dispatch(target, toggle());

    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toBe("light.off(n=0)");
    expect(seen[0]).toBe(left);
  });

  it("enter, exit and update handlers receive the previous instance as the third argument", () => {
    const calls: Array<[string, unknown, unknown]> = [];
    const target = make((sm) => {
      sm.addEnterHandler(light.on, (state, _snapshot, prev) => {
        calls.push(["enter", state, prev]);
        return HandlerResult.ok();
      });
      sm.addExitHandler(light.off, (state, _snapshot, prev) => {
        calls.push(["exit", state, prev]);
        return HandlerResult.ok();
      });
      sm.addUpdateHandler(light.on, (state, _snapshot, prev) => {
        calls.push(["update", state, prev]);
        return HandlerResult.ok();
      });
    });

    const off = target.light;
    dispatch(target, toggle());
    const on = target.light;
    dispatch(target, bump());
    const bumped = target.light;

    // [kind, first argument, third argument]
    const expected: Array<[string, unknown, unknown]> = [
      ["exit", off, off],
      ["enter", on, off],
      ["update", bumped, on],
    ];
    expect(calls.map(([kind]) => kind)).toEqual(expected.map(([kind]) => kind));
    calls.forEach(([kind, state, prev], i) => {
      expect(prev, `${kind}: third argument`).toBe(expected[i][2]);
      expect(state, `${kind}: first argument`).toBe(expected[i][1]);
    });
  });

  it("an exit handler gets four arguments; an enter or update handler five, the fifth its step's AbortSignal; a transition handler five, the fifth its transition's AbortSignal", async () => {
    const counts: Array<[string, number]> = [];
    const stepSignals: unknown[] = [];
    const target = make((sm) => {
      sm.addExitHandler(light.off, (...args: unknown[]) => {
        counts.push(["exit", args.length]);
        return HandlerResult.ok();
      });
      sm.addEnterHandler(light.on, (...args: unknown[]) => {
        counts.push(["enter", args.length]);
        stepSignals.push(args[4]);
        return HandlerResult.ok();
      });
      sm.addUpdateHandler(light.on, (...args: unknown[]) => {
        counts.push(["update", args.length]);
        stepSignals.push(args[4]);
        return HandlerResult.ok();
      });
    });
    dispatch(target, toggle());
    dispatch(target, bump());

    const go = defineSignal("go");
    const job = defineState<{ n: number }>()
      .name("job")
      .signals({ go })
      .variant("idle", { initial: true })
      .variant("done", { async: true })
      .variant("failed")
      .build();
    defineFlow(job.idle, { go: (s, _signal, ctx) => StateResult.transition(job.done(s), job(ctx), job.failed(s)) });
    let signal: unknown;
    const t = { job: { n: 0 } };
    applyFlow(t, [job], (sm) =>
      sm.addTransitionHandler(job.done, async (...args: unknown[]) => {
        counts.push(["transition", args.length]);
        signal = args[4];
        return HandlerResult.ok();
      }),
    );
    await dispatch(t, go()).done();

    expect(counts).toEqual([
      ["exit", 4],
      ["enter", 5],
      ["update", 5],
      ["transition", 5],
    ]);
    // One signal per step, and neither aborted: both steps committed.
    expect(stepSignals.map((s) => s instanceof AbortSignal && !s.aborted)).toEqual([true, true]);
    expect(stepSignals[0]).not.toBe(stepSignals[1]);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("a definition called on the snapshot a handler receives reads that snapshot's instance", () => {
    const seen: unknown[] = [];
    const target = make((sm) => {
      sm.addEnterHandler(light.on, (_state, snapshot) => {
        seen.push(light(snapshot), other(snapshot));
        return HandlerResult.ok();
      });
    });
    const idle = target.other;

    dispatch(target, toggle());

    expect(String(seen[0])).toBe("light.on(n=1)");
    expect(seen[0]).toBe(target.light);
    expect(seen[1]).toBe(idle);
  });

  it("the snapshot a handler receives is frozen, and writing to it commits nothing", () => {
    let snapshot: object | undefined;
    let written: boolean | undefined;
    const target = make((sm) => {
      sm.addEnterHandler(light.on, (_state, snap) => {
        snapshot = snap;
        // Reflect.set reports a refused write with false instead of throwing.
        written = Reflect.set(snap, "other", other.forged({ v: 1 }));
        return HandlerResult.ok();
      });
    });

    dispatch(target, toggle());

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(written).toBe(false);
    expect(String(target.other)).toBe("other.idle(v=0)");
    expect(String(target.light)).toBe("light.on(n=1)");
  });

  it("a nested state's handlers get its key in the parent's Items as the fourth argument, undefined for a single nested state, and its enter and update handlers the step's AbortSignal as the fifth", () => {
    const set = defineSignal<{ n: number }>("set");
    const part = defineState<{ n: number }>().name("part").variant("a", { initial: true }).variant("b").build();
    const machine = defineState<{ main: InstanceOf<typeof part>; spares: Items<typeof part> }>()
      .name("machine")
      .signals({ set })
      .variant("x", { initial: true })
      .build();
    // Every part moves to b with n, so each one exits a and enters b.
    defineFlow(machine.x, {
      set: (m, { n }) => ({
        main: part.b({ n }),
        spares: [...m.spares.keys()].reduce((spares, key) => spares.with(key, part.b({ n })), m.spares),
      }),
    });
    const calls: unknown[][] = [];
    const target = { machine: { main: part.a({ n: 0 }), spares: part.items().with("s1", part.a({ n: 0 })) } };
    applyFlow(target, [machine], (sm) => {
      sm.addExitHandler(part.a, (...args: unknown[]) => {
        calls.push(["exit", args[3], args.length]);
        return HandlerResult.ok();
      });
      sm.addEnterHandler(part.b, (_state, _snapshot, _prev, key, signal) => {
        calls.push(["enter", key, signal instanceof AbortSignal]);
        return HandlerResult.ok();
      });
      sm.addUpdateHandler(part.b, (_state, _snapshot, _prev, key, signal) => {
        calls.push(["update", key, signal instanceof AbortSignal]);
        return HandlerResult.ok();
      });
    });

    dispatch(target, set({ n: 1 }));
    dispatch(target, set({ n: 2 }));

    expect(calls).toEqual([
      ["exit", "s1", 4],
      ["exit", undefined, 4],
      ["enter", undefined, true],
      ["enter", "s1", true],
      ["update", undefined, true],
      ["update", "s1", true],
    ]);
  });

  it("handlers are registered per variant object: two definitions that share a name keep their own, and one definition's run wherever its instances are, in every target", () => {
    const set = defineSignal<{ n: number }>("set");
    const left = defineState<{ n: number }>().name("member").variant("x", { initial: true }).build();
    const right = defineState<{ n: number }>().name("member").variant("x", { initial: true }).build();
    const pair = defineState<{ a: InstanceOf<typeof left>; b: InstanceOf<typeof right>; c: InstanceOf<typeof left> }>()
      .name("pair")
      .signals({ set })
      .variant("x", { initial: true })
      .build();
    defineFlow(pair.x, { set: (_p, { n }) => ({ a: left.x({ n }), b: right.x({ n }), c: left.x({ n }) }) });
    const calls: string[] = [];
    const make = (label: string) => {
      const target = { pair: { a: left.x({ n: 0 }), b: right.x({ n: 0 }), c: left.x({ n: 0 }) } };
      applyFlow(target, [pair], (sm) => {
        sm.addUpdateHandler(left.x, (state) => {
          calls.push(`${label}: left ${state.n}`);
          return HandlerResult.ok();
        });
      });
      return target;
    };
    const first = make("first");
    const second = make("second");

    dispatch(first, set({ n: 1 }));
    dispatch(second, set({ n: 2 }));

    expect(calls).toEqual(["first: left 1", "first: left 1", "second: left 2", "second: left 2"]);
  });
});
