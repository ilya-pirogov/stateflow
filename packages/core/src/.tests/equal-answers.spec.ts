import { describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  Box,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  type FlowChange,
  type FlowConfig,
  FrozenMap,
  FrozenSet,
  HandlerResult,
  type InstanceOf,
  type Items,
  observe,
  type ReducerReturn,
  ResultKind,
  type StateFlowLogEntry,
  StateResult,
  subscribeFlow,
} from "..";

/** FlowConfig.equalAnswers; its JSDoc in src/flow.ts states the comparison rules. */
describe("FlowConfig.equalAnswers", () => {
  const go = defineSignal("go");

  // Props of any shape: each case gives its own.
  type Props = Record<string, unknown>;

  /** A state s with variants x (initial) and y. defineFlow binds once per variant, so each run makes its own. */
  const makeState = () =>
    defineState<Props>().name("s").signals({ go }).variant("x", { initial: true }).variant("y").build();
  type S = ReturnType<typeof makeState>;

  /** What one dispatch of go did (see {@link goOnce}). */
  type Outcome = {
    kind: ResultKind;
    /** Whether the target still holds the instance it held before the dispatch. */
    kept: boolean;
    /** s's handler calls in order, as "update x". */
    calls: string[];
    /** The calls of the observer of x and y, the changes of s the subscriber got, and the changes of s in the first
     * entry. */
    observed: number;
    changes: number;
    logged: number;
  };

  const unchanged: Outcome = { kind: ResultKind.OK, kept: true, calls: [], observed: 0, changes: 0, logged: 0 };
  const updated: Outcome = {
    kind: ResultKind.OK,
    kept: false,
    calls: ["update x"],
    observed: 1,
    changes: 1,
    logged: 1,
  };

  // Log entries are delivered after the dispatch returns; observers and subscribers on a 0 ms timer.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Applies a flow of s from `initial` under `config`, whose x answers go with `answer`, and dispatches go once. */
  async function goOnce(
    initial: Props,
    answer: (st: Props, s: S) => ReducerReturn<Props>,
    config: FlowConfig = {},
  ): Promise<Outcome> {
    const s = makeState();
    defineFlow(s.x, { go: (st) => answer(st, s) });
    const calls: string[] = [];
    const record = (call: string) => () => {
      calls.push(call);
      return HandlerResult.ok();
    };
    const entries: StateFlowLogEntry[] = [];
    const target = { s: initial };
    applyFlow(
      target,
      [s],
      (sm) => {
        sm.addExitHandler(s.x, record("exit x"));
        sm.addUpdateHandler(s.x, record("update x"));
        sm.addEnterHandler(s.y, record("enter y"));
      },
      { ...config, logHandlers: [(entry) => entries.push(entry)] },
    );
    const observed = vi.fn();
    using _observer = observe(target, [s.x, s.y], observed);
    const changes: FlowChange[] = [];
    using _subscriber = subscribeFlow(target, (change) => changes.push(change));
    const before = target.s;

    const result = dispatch(target, go());
    await tick();

    return {
      kind: result.kind,
      kept: target.s === before,
      calls,
      observed: observed.mock.calls.length,
      // A nested state's own change is a FlowChange with a path, and a line of the entry too.
      changes: changes.filter((change) => change.path === undefined).length,
      logged: entries[0].stateChanges.filter((change) => change.stateName === "s").length,
    };
  }

  const child = defineState<{ n: number }>().name("child").variant("on", { initial: true }).build();
  const kid = child.on({ n: 1 });
  const resource = {};
  const key = Symbol("key");
  // Length 2 with an element at 0 only: setting the length leaves a hole at 1.
  const holed = Object.assign([1], { length: 2 });

  /** A prop kind: `initial` props, and what x's reducer answers for them, of x's variant; `equal` by value or not. */
  type Case = { kind: string; initial: Props; rebuild: (st: Props) => Props; equal: boolean };

  const cases: Case[] = [
    {
      kind: "primitives, the same values",
      initial: { n: 1, label: "a", on: true, none: null, gone: undefined },
      rebuild: (st) => ({ ...st }),
      equal: true,
    },
    {
      kind: "primitives, another value",
      initial: { n: 1, label: "a" },
      rebuild: (st) => ({ ...st, n: 2 }),
      equal: false,
    },
    {
      kind: "primitives, NaN, which === never equals",
      initial: { n: Number.NaN },
      rebuild: (st) => ({ ...st }),
      equal: false,
    },
    { kind: "keys, one fewer", initial: { n: 1, m: 2 }, rebuild: () => ({ n: 1 }), equal: false },
    { kind: "keys, as many, another one", initial: { a: undefined }, rebuild: () => ({ b: undefined }), equal: false },
    {
      kind: "keys, another value under a symbol key",
      initial: { [key]: 1 },
      rebuild: () => ({ [key]: 2 }),
      equal: false,
    },
    {
      kind: "Box, a new Box of the same value",
      initial: { box: Box.of(resource) },
      rebuild: () => ({ box: Box.of(resource) }),
      equal: true,
    },
    {
      kind: "Box, of another value",
      initial: { box: Box.of(resource) },
      rebuild: () => ({ box: Box.of({}) }),
      equal: false,
    },
    {
      kind: "FrozenSet, the same elements in another order",
      initial: { tags: new FrozenSet(["a", "b"]) },
      rebuild: () => ({ tags: new FrozenSet(["b", "a"]) }),
      equal: true,
    },
    {
      kind: "FrozenSet, another element",
      initial: { tags: new FrozenSet(["a", "b"]) },
      rebuild: () => ({ tags: new FrozenSet(["a", "c"]) }),
      equal: false,
    },
    {
      kind: "FrozenSet, fewer elements",
      initial: { tags: new FrozenSet(["a", "b"]) },
      rebuild: () => ({ tags: new FrozenSet(["a"]) }),
      equal: false,
    },
    {
      kind: "FrozenSet, in place of an array of its elements",
      initial: { tags: ["a"] },
      rebuild: () => ({ tags: new FrozenSet(["a"]) }),
      equal: false,
    },
    {
      kind: "FrozenSet, an equal object element, which the set's own lookup compares by identity",
      initial: { tags: new FrozenSet([{ id: 1 }]) },
      rebuild: () => ({ tags: new FrozenSet([{ id: 1 }]) }),
      equal: false,
    },
    {
      kind: "FrozenMap, equal values under the same keys, in another order",
      initial: {
        m: new FrozenMap<string, unknown>([
          ["a", [1]],
          ["b", { c: 2 }],
        ]),
      },
      rebuild: () => ({
        m: new FrozenMap<string, unknown>([
          ["b", { c: 2 }],
          ["a", [1]],
        ]),
      }),
      equal: true,
    },
    {
      kind: "FrozenMap, another value",
      initial: { m: new FrozenMap([["a", [1]]]) },
      rebuild: () => ({ m: new FrozenMap([["a", [2]]]) }),
      equal: false,
    },
    {
      kind: "FrozenMap, another key",
      initial: { m: new FrozenMap([["a", undefined]]) },
      rebuild: () => ({ m: new FrozenMap([["b", undefined]]) }),
      equal: false,
    },
    {
      kind: "FrozenMap, fewer entries",
      initial: {
        m: new FrozenMap([
          ["a", 1],
          ["b", 2],
        ]),
      },
      rebuild: () => ({ m: new FrozenMap([["a", 1]]) }),
      equal: false,
    },
    {
      kind: "FrozenMap, in place of a FrozenSet of its keys",
      initial: { m: new FrozenSet(["a"]) },
      rebuild: () => ({ m: new FrozenMap([["a", 1]]) }),
      equal: false,
    },
    {
      kind: "array, equal elements at any depth",
      initial: { list: [1, [2, { c: 3 }]] },
      rebuild: () => ({ list: [1, [2, { c: 3 }]] }),
      equal: true,
    },
    {
      kind: "array, another element",
      initial: { list: [1, [2, 3]] },
      rebuild: () => ({ list: [1, [2, 4]] }),
      equal: false,
    },
    {
      kind: "array, the same elements in another order",
      initial: { list: [1, 2] },
      rebuild: () => ({ list: [2, 1] }),
      equal: false,
    },
    {
      kind: "array, a hole where the given array has an element",
      initial: { list: [1, 2] },
      rebuild: () => ({ list: holed }),
      equal: false,
    },
    {
      kind: "array, one length more, through a hole at the end",
      initial: { list: [1] },
      rebuild: () => ({ list: holed }),
      equal: false,
    },
    {
      kind: "array, in place of a string of its elements",
      initial: { list: "ab" },
      rebuild: () => ({ list: ["a", "b"] }),
      equal: false,
    },
    {
      kind: "plain record, equal values under the same keys, in another order, at any depth",
      initial: { rec: { a: 1, b: { c: [1] } } },
      rebuild: () => ({ rec: { b: { c: [1] }, a: 1 } }),
      equal: true,
    },
    {
      kind: "plain record, another value",
      initial: { rec: { a: 1, b: { c: [1] } } },
      rebuild: () => ({ rec: { a: 1, b: { c: [2] } } }),
      equal: false,
    },
    {
      kind: "plain record, a key that the given record holds only as not enumerable",
      initial: { rec: Object.defineProperty({ b: 2 }, "a", { value: 1 }) },
      rebuild: () => ({ rec: { a: 1 } }),
      equal: false,
    },
    {
      kind: "plain record, in place of an array of the same keys and elements",
      initial: { rec: ["x"] },
      rebuild: () => ({ rec: { 0: "x" } }),
      equal: false,
    },
    { kind: "nested state, the same instance", initial: { child: kid }, rebuild: (st) => ({ ...st }), equal: true },
    {
      kind: "nested state, an instance with equal props, compared by identity",
      initial: { child: kid },
      rebuild: () => ({ child: child.on({ n: 1 }) }),
      equal: false,
    },
    {
      kind: "nested state, replaced by a plain record of its props",
      initial: { child: kid },
      rebuild: () => ({ child: { n: 1 } }),
      equal: false,
    },
    {
      kind: "nested state, in place of a plain record of its props",
      initial: { child: { n: 1 } },
      rebuild: () => ({ child: kid }),
      equal: false,
    },
    {
      kind: "Items, the same Items",
      initial: { kids: child.items().with("k", kid) },
      rebuild: (st) => ({ ...st }),
      equal: true,
    },
    {
      kind: "Items, a new Items of the same entries, compared by identity",
      initial: { kids: child.items().with("k", kid) },
      rebuild: (st) => ({ kids: (st.kids as Items<typeof child>).with("k", kid) }),
      equal: false,
    },
    {
      kind: "any other object, an Error here, compared by identity",
      initial: { err: new Error("x") },
      rebuild: () => ({ err: new Error("x") }),
      equal: false,
    },
    {
      kind: "any other object, an Error, which has no enumerable keys, in place of an empty plain record",
      initial: { err: {} },
      rebuild: () => ({ err: new Error("x") }),
      equal: false,
    },
  ];

  it.each(cases)('"value": $kind', async ({ initial, rebuild, equal }) => {
    expect(await goOnce(initial, rebuild, { equalAnswers: "value" })).toEqual(equal ? unchanged : updated);
  });

  it('"identity", the default, commits an equal instance', async () => {
    expect(await goOnce({ n: 1 }, (st) => ({ ...st }))).toEqual(updated);
    expect(await goOnce({ n: 1 }, (st) => ({ ...st }), { equalAnswers: "identity" })).toEqual(updated);
  });

  it('"value": a next with equal props counts as the node\'s instance however the reducer returns it, props, an instance or ok', async () => {
    const answers: Array<(st: Props, s: S) => ReducerReturn<Props>> = [
      (st) => ({ ...st }),
      (st, s) => s.x({ ...st }),
      (st, s) => StateResult.ok(s.x({ ...st })),
    ];
    for (const answer of answers) {
      expect(await goOnce({ n: 1 }, answer, { equalAnswers: "value" })).toEqual(unchanged);
    }
  });

  it('"value": a next of another variant with equal props is a change: the node exits its variant and enters the other', async () => {
    expect(await goOnce({ n: 1 }, (st, s) => s.y({ ...st }), { equalAnswers: "value" })).toEqual({
      ...updated,
      calls: ["exit x", "enter y"],
    });
  });

  it("\"value\": a parent's equal answer takes its child's answer with no update of its own, and a child's equal answer leaves the parent the same object", async () => {
    const tock = defineSignal("tock");
    const cell = defineState<{ n: number }>()
      .name("cell")
      .signals({ go, tock })
      .variant("x", { initial: true })
      .build();
    const grid = defineState<{ n: number; cell: InstanceOf<typeof cell> }>()
      .name("grid")
      .signals({ go, tock })
      .variant("x", { initial: true })
      .build();
    // go: the grid answers equal props and the cell a change; tock: the cell answers equal props.
    defineFlow(grid.x, { go: (g) => ({ ...g }), tock: () => StateResult.ignored() });
    defineFlow(cell.x, { go: (c) => ({ n: c.n + 1 }), tock: (c) => ({ ...c }) });
    const calls: string[] = [];
    const t = { grid: { n: 0, cell: cell.x({ n: 0 }) } };
    applyFlow(
      t,
      [grid],
      (sm) => {
        sm.addUpdateHandler(grid.x, () => {
          calls.push("grid update");
          return HandlerResult.ok();
        });
        sm.addUpdateHandler(cell.x, () => {
          calls.push("cell update");
          return HandlerResult.ok();
        });
      },
      { equalAnswers: "value" },
    );

    dispatch(t, go());

    expect(calls).toEqual(["cell update"]);
    expect(String(t.grid)).toBe("grid.x(n=0 cell=cell.x(n=1))");

    const before = t.grid;
    calls.length = 0;

    expect(dispatch(t, tock()).kind).toBe(ResultKind.OK);
    expect(t.grid).toBe(before);
    expect(calls).toEqual([]);
  });

  it('"value": a temp and a failed compare by identity: a temp with equal props updates the node, and so does a failed, which takes FAILURE', () => {
    const lamp = defineState<{ reason: string | null }>()
      .name("lamp")
      .signals({ go })
      .variant("off", { initial: true })
      .variant("on")
      .build();
    let refuse = true;
    defineFlow(
      lamp.off,
      {
        // The first go refuses on's entry and fails to off with equal props; the second passes through a temp of
        // off with equal props.
        go: (s) =>
          refuse
            ? StateResult.ok(lamp.on(s), lamp.off({ ...s }))
            : StateResult.transition(lamp.on(s), lamp.off({ ...s }), lamp.off(s)),
      },
      { [FAILURE]: (s, { reason }) => ({ ...s, reason: reason ?? null }) },
    );
    const calls: string[] = [];
    const t = { lamp: { reason: null } };
    applyFlow(
      t,
      [lamp],
      (sm) => {
        sm.addUpdateHandler(lamp.off, () => {
          calls.push("update off");
          return HandlerResult.ok();
        });
        sm.addEnterHandler(lamp.on, () => {
          calls.push("enter on");
          return refuse ? HandlerResult.rejected("unpowered") : HandlerResult.ok();
        });
      },
      { equalAnswers: "value" },
    );

    expect(dispatch(t, go()).kind).toBe(ResultKind.Rejected);
    expect(calls).toEqual(["enter on", "update off"]);
    expect(String(t.lamp)).toBe("lamp.off(reason=unpowered)");

    refuse = false;
    calls.length = 0;
    dispatch(t, go());

    expect(calls).toEqual(["update off", "enter on"]);
    expect(String(t.lamp)).toBe("lamp.on(reason=unpowered)");
  });
});
