import { describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  Box,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  FAILURE,
  type FlowChange,
  HandlerResult,
  type Items,
  lock,
  observe,
  type ReducerContext,
  ResultKind,
  type StateFlowLogEntry,
  StateResult,
  stateVar,
  subscribeFlow,
} from "..";
import { Verdict } from "../result";
import { SNAPSHOT } from "../symbols";

/**
 * Signal reducers: every reducer the signal reaches runs, each on the frozen snapshot from before the signal, through
 * a frozen ctx; their verdicts merge in the flow's order. A reducer returns a StateResult, an instance or props;
 * anything else, or another state's instance, is its Error. Every definition below is made inside its test,
 * because defineFlow binds once per variant.
 */
describe("reducers", () => {
  const go = defineSignal("go");
  const poke = defineSignal("poke");

  /** A state `name` with variants x (initial), y and z, whose reducers are left to the test. */
  const xyz = <TName extends string>(name: TName) =>
    defineState<{ n: number }>()
      .name(name)
      .signals({ go, poke })
      .variant("x", { initial: true })
      .variant("y")
      .variant("z")
      .build();

  // Log entries are delivered after the dispatch returns; observers and subscribers on a 0 ms timer.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("a reducer returning props, an instance or ok(instance) commits the same, with the same handler calls", () => {
    const reducers = {
      props: (n: number) => ({ n: n + 1 }),
      instance: (n: number, s: ReturnType<typeof xyz>) => s.x({ n: n + 1 }),
      ok: (n: number, s: ReturnType<typeof xyz>) => StateResult.ok(s.x({ n: n + 1 })),
    };
    for (const [label, reducer] of Object.entries(reducers)) {
      const s = xyz("s");
      defineFlow(s.x, { go: (st) => reducer(st.n, s) });
      const updates: string[] = [];
      const target = { s: { n: 0 } };
      applyFlow(target, [s], (sm) =>
        sm.addUpdateHandler(s.x, (state, _snapshot, prev) => {
          updates.push(`${String(prev)} -> ${String(state)}`);
          return HandlerResult.ok();
        }),
      );

      expect(dispatch(target, go()).kind, label).toBe(ResultKind.OK);

      expect(String(target.s), label).toBe("s.x(n=1)");
      expect(updates, label).toEqual(["s.x(n=0) -> s.x(n=1)"]);
    }
  });

  it("another definition's instance, through ok or bare, is an Error when the reducer returns; nothing commits", () => {
    const foreign = xyz("foreign");
    const returns: Array<[string, () => StateResult | ReturnType<typeof foreign.x>]> = [
      ["ok", () => StateResult.ok(foreign.y({ n: 1 }))],
      ["bare", () => foreign.y({ n: 1 })],
      ["transition", () => StateResult.transition(foreign.y({ n: 1 }), foreign.z({ n: 0 }), foreign.x({ n: 0 }))],
    ];
    for (const [label, ret] of returns) {
      const s = xyz("s");
      // Another state's instance breaks the reducer's type on purpose, hence the cast.
      defineFlow(s.x, { go: ret as never });
      const target = { s: { n: 0 } };
      applyFlow(target, [s], () => {});

      const r = dispatch(target, go());

      expect(r.kind, label).toBe(ResultKind.Error);
      expect(String(r.error), label).toContain(
        "s: the reducer of s.x for go returned foreign.y(n=1), not an instance of s",
      );
      expect(String(target.s), label).toBe("s.x(n=0)");
    }
  });

  it("a HandlerResult, undefined, null, a number or an engine result from a reducer is an Error; nothing commits", () => {
    const returns: Array<[string, unknown]> = [
      ["HandlerResult.ok()", HandlerResult.ok()],
      ["HandlerResult.rejected()", HandlerResult.rejected("no")],
      ["undefined", undefined],
      ["null", null],
      ["a number", 42],
      ["an engine result", HandlerResult.ok().merge(HandlerResult.ok())],
      ["a pending result", Verdict.pending(Promise.resolve(Verdict.ok()))],
    ];
    for (const [label, value] of returns) {
      const s = xyz("s");
      // These returns break the reducer's type on purpose, hence the cast.
      defineFlow(s.x, { go: () => value as never });
      const target = { s: { n: 0 } };
      applyFlow(target, [s], () => {});

      const r = dispatch(target, go());

      expect(r.kind, label).toBe(ResultKind.Error);
      expect(String(r.error), label).toContain(
        "s: the reducer of s.x for go returned no StateResult, instance or props",
      );
      expect(String(target.s), label).toBe("s.x(n=0)");
    }
  });

  it("a signal reducer or a result reducer that returns a promise is an Error, since reducers are synchronous; nothing commits, and a rejection goes unreported", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const s = xyz("s");
      // An async reducer breaks the reducer's type on purpose, hence the cast.
      defineFlow(s.x, {
        go: (async () => {
          throw new Error("rejected later");
        }) as never,
      });
      const target = { s: { n: 0 } };
      applyFlow(target, [s], () => {});

      const r = dispatch(target, go());

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe(
        "s: the reducer of s.x for go returned a promise; reducers are synchronous [SF059] Return the next state synchronously; put the waiting in a transition handler.",
      );
      expect(String(target.s)).toBe("s.x(n=0)");

      const folded = defineState<{ n: number }>()
        .name("folded")
        .signals({ go })
        .variant("x", { initial: true })
        .variant("y", { results: { done: (data) => Number(data) } })
        .build();
      defineFlow(folded.x, { go: (st) => folded.y(st) });
      defineFlow(folded.y, {}, { done: (async (st: { n: number }) => st) as never });
      const other = { folded: { n: 0 } };
      applyFlow(other, [folded], (sm) => sm.addEnterHandler(folded.y, () => folded.y.results.done(1)));

      const f = dispatch(other, go());

      expect(f.kind).toBe(ResultKind.Error);
      expect(f.error?.message).toBe(
        "folded: the result reducer done of folded.y returned a promise; reducers are synchronous [SF059] Return the next state synchronously; put the waiting in a transition handler.",
      );
      expect(String(other.folded)).toBe("folded.x(n=0)");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a parser that throws on a reducer's bare props is the reducer's Error", () => {
    const strict = defineState<{ n: number }>()
      .name("strict")
      .signals({ go })
      .variant("x", { initial: true })
      .parser((p) => {
        const n = (p as { n: number }).n;
        if (n > 0) {
          throw new Error(`n=${n} is too large`);
        }
        return { n };
      })
      .build();
    defineFlow(strict.x, { go: (s) => ({ n: s.n + 1 }) });
    const target = { strict: { n: 0 } };
    applyFlow(target, [strict], () => {});

    const r = dispatch(target, go());

    expect(r.kind).toBe(ResultKind.Error);
    expect(String(r.error)).toBe("Error: n=1 is too large");
    expect(String(target.strict)).toBe("strict.x(n=0)");
  });

  it("every reducer runs on the snapshot from before the signal: no reducer sees another state's change from the same signal", () => {
    const a = xyz("a");
    const b = xyz("b");
    const seen: string[] = [];
    defineFlow(a.x, {
      go: (s, _signal, ctx) => {
        seen.push(`a sees ${String(b(ctx))}`);
        return a.y({ n: s.n + 1 });
      },
    });
    defineFlow(b.x, {
      go: (s, _signal, ctx) => {
        seen.push(`b sees ${String(a(ctx))}`);
        return b.y({ n: a(ctx).n + 10 });
      },
    });
    const target = { a: { n: 0 }, b: { n: 0 } };
    applyFlow(target, [a, b], () => {});

    expect(dispatch(target, go()).kind).toBe(ResultKind.OK);

    expect(seen).toEqual(["a sees b.x(n=0)", "b sees a.x(n=0)"]);
    expect([String(target.a), String(target.b)]).toEqual(["a.y(n=1)", "b.y(n=10)"]);
  });

  it("every reducer runs, and their verdicts merge in the flow's order: of two Rejected the first wins, an Error wins over a Rejected, a refusal over every answer, an answer over Ignored, and Ignored reducers join; a refused dispatch logs no change", async () => {
    type Reducer = (s: { n: number }) => StateResult | { n: number };
    const rejects =
      (message: string): Reducer =>
      () =>
        StateResult.rejected(message);
    const ignores =
      (message: string): Reducer =>
      () =>
        StateResult.ignored(message);
    const throws =
      (message: string): Reducer =>
      () => {
        throw new Error(message);
      };
    const answers: Reducer = (s) => ({ n: s.n + 1 });
    // The reducers of a, b and c, the dispatch's result, the states it leaves, and those its entry logs as changed.
    const cases: Array<[string, Reducer[], string, string[], string[]]> = [
      [
        "Rejected, Rejected, answer",
        [rejects("a refuses"), rejects("b refuses"), answers],
        "Rejected: a refuses",
        ["a.x(n=0)", "b.x(n=0)", "c.x(n=0)"],
        [],
      ],
      [
        "Rejected, Error, answer",
        [rejects("a refuses"), throws("b boom"), answers],
        "Error: b boom",
        ["a.x(n=0)", "b.x(n=0)", "c.x(n=0)"],
        [],
      ],
      [
        "Error, Rejected, answer",
        [throws("a boom"), rejects("b refuses"), answers],
        "Error: a boom",
        ["a.x(n=0)", "b.x(n=0)", "c.x(n=0)"],
        [],
      ],
      [
        "Ignored, Ignored, Ignored",
        [ignores("a skips"), ignores("b skips"), ignores("c skips")],
        "Ignored: a skips; b skips; c skips",
        ["a.x(n=0)", "b.x(n=0)", "c.x(n=0)"],
        [],
      ],
      [
        "Ignored, answer, answer",
        [ignores("a skips"), answers, answers],
        "OK",
        ["a.x(n=0)", "b.x(n=1)", "c.x(n=1)"],
        ["b", "c"],
      ],
    ];
    for (const [label, reducers, text, ends, logged] of cases) {
      const states = [xyz("a"), xyz("b"), xyz("c")] as const;
      const ran: string[] = [];
      states.forEach((state, i) => {
        defineFlow(state.x, {
          go: (s) => {
            ran.push(String(state));
            return reducers[i](s);
          },
        });
      });
      const entries: StateFlowLogEntry[] = [];
      const target = { a: { n: 0 }, b: { n: 0 }, c: { n: 0 } };
      applyFlow(target, [...states], () => {}, { logHandlers: [(entry) => entries.push(entry)] });

      const r = dispatch(target, go());

      expect(String(r), label).toBe(text);
      expect(ran, label).toEqual(["a", "b", "c"]);
      expect([String(target.a), String(target.b), String(target.c)], label).toEqual(ends);
      await tick();
      expect(
        entries[0].stateChanges.map((change) => change.stateName),
        label,
      ).toEqual(logged);
    }
  });

  it("ctx is frozen, with no parent and no key at the top level; a write to it is the reducer's Error and nothing commits", () => {
    const writes: Array<[string, (ctx: ReducerContext) => void]> = [
      [
        "a state's name",
        (ctx) => {
          (ctx as unknown as Record<string, unknown>).b = "forged";
        },
      ],
      [
        "parent",
        (ctx) => {
          (ctx as { parent: unknown }).parent = "forged";
        },
      ],
      [
        // SNAPSHOT is a registered symbol, so any reducer can reach the snapshot ctx carries; it is frozen too.
        "the snapshot it carries",
        (ctx) => {
          (ctx as unknown as Record<symbol, Record<string, unknown>>)[SNAPSHOT].b = "forged";
        },
      ],
    ];
    for (const [label, write] of writes) {
      const a = xyz("a");
      const b = xyz("b");
      let seen: ReducerContext | undefined;
      defineFlow(a.x, {
        go: (s, _signal, ctx) => {
          seen = ctx;
          write(ctx);
          return a.y(s);
        },
      });
      defineFlow(b.x, { go: (s) => b.y(s) });
      const target = { a: { n: 0 }, b: { n: 0 } };
      applyFlow(target, [a, b], () => {});

      const r = dispatch(target, go());

      expect(Object.isFrozen(seen), label).toBe(true);
      expect([seen?.parent, seen?.key], label).toEqual([undefined, undefined]);
      expect(r.kind, label).toBe(ResultKind.Error);
      expect(r.error, label).toBeInstanceOf(TypeError);
      expect([String(target.a), String(target.b)], label).toEqual(["a.x(n=0)", "b.x(n=0)"]);
    }
  });

  it("a definition called on ctx reads the reducer's snapshot; no state name is reserved, so states named parent and key read as states", () => {
    const parent = xyz("parent");
    const key = xyz("key");
    const reader = xyz("reader");
    let seen: string[] = [];
    defineFlow(reader.x, {
      go: (s, _signal, ctx) => {
        seen = [String(parent(ctx)), String(key(ctx)), String(ctx.parent), String(ctx.key)];
        return reader.y(s);
      },
    });
    const target = { parent: { n: 1 }, key: { n: 2 }, reader: { n: 0 } };
    applyFlow(target, [parent, key, reader], () => {});

    expect(dispatch(target, go()).kind).toBe(ResultKind.OK);

    expect(seen).toEqual(["parent.x(n=1)", "key.x(n=2)", "undefined", "undefined"]);
  });

  it("a nested reducer's ctx: its parent from the snapshot before the signal, its key (undefined for a single nested state, also inside an Items element); a definition called on it reads that snapshot; it is frozen", () => {
    const tip = xyz("tip");
    const leaf = defineState<{ n: number; tip?: ReturnType<typeof tip.x> }>()
      .name("leaf")
      .signals({ go })
      .variant("x", { initial: true })
      .build();
    const holder = defineState<{ n: number; one: ReturnType<typeof leaf.x>; many: Items<typeof leaf> }>()
      .name("holder")
      .signals({ go })
      .variant("x", { initial: true })
      .variant("y")
      .build();
    // The parent changes in the same dispatch; its children's reducers still see it as it was.
    defineFlow(holder.x, { go: (h) => holder.y(h) });
    const seen: Array<{ parent: unknown; key: unknown; read: unknown; frozen: boolean }> = [];
    const record = <T>(node: T, ctx: ReducerContext): T => {
      seen.push({ parent: ctx.parent, key: ctx.key, read: holder(ctx), frozen: Object.isFrozen(ctx) });
      return node;
    };
    defineFlow(leaf.x, { go: (l, _signal, ctx) => record(l, ctx) });
    defineFlow(tip.x, { go: (t, _signal, ctx) => record(t, ctx) });
    const target = {
      holder: {
        n: 0,
        one: leaf.x({ n: 1 }),
        many: leaf
          .items()
          .with("a", leaf.x({ n: 2, tip: tip.x({ n: 4 }) }))
          .with("b", leaf.x({ n: 3 })),
      },
    };
    applyFlow(target, [holder], () => {});
    const before = target.holder;

    expect(dispatch(target, go()).kind).toBe(ResultKind.OK);

    expect(stateVar(target.holder)).toBe(holder.y);
    expect(seen).toEqual([
      { parent: before, key: undefined, read: before, frozen: true },
      { parent: before, key: "a", read: before, frozen: true },
      // The tip held by element a: its parent is that element, and as a single nested state it has no key.
      { parent: before.many.get("a"), key: undefined, read: before, frozen: true },
      { parent: before, key: "b", read: before, frozen: true },
    ]);
  });

  /** Calls that throw inside reducer code, each with the message of its throw. */
  const reducerRefusals = (): Array<[string, (target: object) => void]> => {
    const box = Box.of({ live: true });
    return [
      [
        "Cannot deref a Box inside a reducer; read it in a handler (enter, exit, update, transition or commit) or an observer.",
        () => {
          box.deref();
        },
      ],
      [
        "Cannot dispatch from inside a reducer",
        (target) => {
          dispatch(target, poke());
        },
      ],
      [
        "Cannot dispose a flow from inside a reducer",
        (target) => {
          disposeFlow(target);
        },
      ],
    ];
  };

  it("Box.deref, dispatch and disposeFlow throw inside a reducer, and so does a held lock's send; the dispatch is refused with an Error", async () => {
    for (const [message, call] of reducerRefusals()) {
      const s = xyz("s");
      const target = { s: { n: 0 } };
      defineFlow(s.x, {
        go: () => {
          call(target);
          return s.y({ n: 1 });
        },
      });
      applyFlow(target, [s], () => {});

      const r = dispatch(target, go());

      expect(r.kind, message).toBe(ResultKind.Error);
      expect(String(r.error), message).toContain(message);
      expect(String(target.s), message).toBe("s.x(n=0)");
    }

    // The lock's send checks reducer scope itself: while a transition is pending it would queue the signal
    // or take it as an abort without reaching the dispatch.
    const s = xyz("s");
    const target = { s: { n: 0 } };
    defineFlow(s.x, {
      go: () => {
        send(poke());
        return s.y({ n: 1 });
      },
    });
    applyFlow(target, [s], () => {});
    await using send = await lock(target);

    const r = send(go());

    expect(r.kind).toBe(ResultKind.Error);
    expect(String(r.error)).toContain("Cannot dispatch from inside a reducer");
    expect(String(target.s)).toBe("s.x(n=0)");
  });

  it("Box.deref, dispatch and disposeFlow throw inside a result reducer, the FAILURE reducer included, which run in reducer scope", () => {
    for (const [message, call] of reducerRefusals()) {
      const s = defineState<{ n: number }>()
        .name("s")
        .signals({ go })
        .variant("x", { initial: true })
        .variant("y", { results: { done: (data) => Number(data) } })
        .variant("z")
        .build();
      const target = { s: { n: 0 } };
      defineFlow(s.x, { go: (st) => StateResult.ok(s.y(st), s.z(st)) });
      defineFlow(
        s.y,
        {},
        {
          done: (st) => {
            call(target);
            return st;
          },
        },
      );
      defineFlow(
        s.z,
        {},
        {
          [FAILURE]: (st) => {
            call(target);
            return st;
          },
        },
      );
      applyFlow(target, [s], (sm) => {
        sm.addEnterHandler(s.y, () => s.y.results.done(1));
      });

      const r = dispatch(target, go());

      // The result reducer's throw is the entry's failure; FAILURE's reducer in the failed step then throws too, and
      // the two merge. The failed step commits z without what that reducer would have folded.
      expect(r.kind, message).toBe(ResultKind.Error);
      const errors = (r.error as AggregateError).errors.map(String);
      expect(errors, message).toEqual([expect.stringContaining(message), expect.stringContaining(message)]);
      expect(String(target.s), message).toBe("s.z(n=0)");
    }
  });

  it("a reducer that returns its own instance, bare or through ok, runs no handler, notifies no one and logs no change", async () => {
    const s = xyz("s");
    defineFlow(s.x, {
      // The reducer's state is typed as its props, so ok() gets the instance from ctx.
      go: (_st, _signal, ctx) => StateResult.ok(s(ctx)),
      poke: (st) => st,
    });
    const entries: StateFlowLogEntry[] = [];
    const handlers = vi.fn(() => HandlerResult.ok());
    const commits = vi.fn();
    const target = { s: { n: 0 } };
    applyFlow(
      target,
      [s],
      (sm) => {
        sm.addUpdateHandler(s.x, handlers);
        sm.addEnterHandler(s.x, handlers);
        sm.addExitHandler(s.x, handlers);
        sm.addCommitHandler(s.x, commits);
      },
      { logHandlers: [(entry) => entries.push(entry)] },
    );
    const observed = vi.fn();
    using _observer = observe(target, [s.x], observed, () => true);
    const changes: FlowChange[] = [];
    using _subscriber = subscribeFlow(target, (change) => changes.push(change));
    const before = target.s;

    const results = [dispatch(target, go()), dispatch(target, poke())];

    expect(results.map((r) => r.kind)).toEqual([ResultKind.OK, ResultKind.OK]);
    expect(target.s).toBe(before);
    expect(handlers).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    await tick();
    expect(observed).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
    expect(entries.map((entry) => [entry.finalResult, entry.stateChanges])).toEqual([
      ["OK", []],
      ["OK", []],
    ]);
  });

  describe("a reducer runs for a signal by the signal's name", () => {
    it("two states that both key a reducer by the signal's name both run for it, whichever definition built it", () => {
      // Two definitions of one name: the name, not the definition, picks the reducers.
      const goA = defineSignal("go");
      const goB = defineSignal("go");
      const a = defineState<{ n: number }>()
        .name("a")
        .signals({ go: goA })
        .variant("x", { initial: true })
        .variant("y")
        .build();
      const b = defineState<{ n: number }>()
        .name("b")
        .signals({ go: goB })
        .variant("x", { initial: true })
        .variant("y")
        .build();
      defineFlow(a.x, { go: (s) => a.y(s) });
      defineFlow(b.x, { go: (s) => b.y(s) });
      const target = { a: { n: 0 }, b: { n: 0 } };
      applyFlow(target, [a, b], () => {});

      expect(dispatch(target, goA()).kind).toBe(ResultKind.OK);

      expect([String(target.a), String(target.b)]).toEqual(["a.y(n=0)", "b.y(n=0)"]);
    });

    it("a reducer keyed by another name does not run for the signal", () => {
      const start = defineSignal("start");
      const engine = defineState<{ n: number }>()
        .name("engine")
        .signals({ start })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      // A state cannot list start under another key: build() refuses it (state.spec).
      const dashboard = defineState<{ n: number }>()
        .name("dashboard")
        .signals({ engineStarted: defineSignal("engineStarted") })
        .variant("dark", { initial: true })
        .variant("lit")
        .build();
      defineFlow(engine.off, { start: (s) => engine.on(s) });
      defineFlow(dashboard.dark, { engineStarted: (s) => dashboard.lit(s) });
      const target = { engine: { n: 0 }, dashboard: { n: 0 } };
      applyFlow(target, [engine, dashboard], () => {});

      expect(dispatch(target, start()).kind).toBe(ResultKind.OK);

      expect([stateVar(target.engine), stateVar(target.dashboard)]).toEqual([engine.on, dashboard.dark]);
    });

    it("a signal no variant has a reducer for is Ignored, with a message naming the signal and every state's variant", () => {
      const s = xyz("s");
      const t = xyz("t");
      defineFlow(s.x, { poke: (st) => st });
      const target = { s: { n: 0 }, t: { n: 0 } };
      applyFlow(target, [s, t], () => {});

      const r = dispatch(target, go());

      expect(r.kind).toBe(ResultKind.Ignored);
      expect(r.message).toBe("no reducer for go in s.x, t.x");
    });

    it("a signal named like an Object.prototype member finds no reducer in a variant that has none of that name", () => {
      const toStringSignal = defineSignal("toString");
      const s = defineState<{ n: number }>()
        .name("s")
        .signals({ toString: toStringSignal })
        .variant("x", { initial: true })
        .build();
      const target = { s: { n: 0 } };
      applyFlow(target, [s], () => {});

      const r = dispatch(target, toStringSignal());

      expect(r.kind).toBe(ResultKind.Ignored);
      expect(r.message).toBe("no reducer for toString in s.x");
    });

    it("a reducer defineFlow gives a variant after a signal reached its committed instance runs for the next signal", () => {
      const s = xyz("s");
      const target = { s: { n: 0 } };
      applyFlow(target, [s], () => {});
      expect(dispatch(target, go()).kind).toBe(ResultKind.Ignored);

      defineFlow(s.x, { go: (st) => s.y(st) });

      expect(dispatch(target, go()).kind).toBe(ResultKind.OK);
      expect(String(target.s)).toBe("s.y(n=0)");
    });
  });
});
