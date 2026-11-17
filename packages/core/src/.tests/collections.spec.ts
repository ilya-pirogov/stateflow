import { describe, expect, it } from "vitest";
import {
  applyFlow,
  Box,
  defineFlow,
  defineSignal,
  defineState,
  definitionOf,
  dispatch,
  FAILURE,
  HandlerResult,
  Items,
  ResultKind,
  StateFlowError,
  type StateFlowLogEntry,
  StateResult,
} from "..";
import { FrozenMap, FrozenSet } from "../collections";
import { ITEMS } from "../symbols";

/**
 * Items: what `def.items()` builds. An immutable map of one definition's instances, or with `{ key }` a
 * set keyed by each element; `with` and `without` return new ones, and it reads as a ReadonlyMap in insertion
 * order.
 */
describe("Items", () => {
  const member = defineState<{ id: string; n: number }>()
    .name("member")
    .variant("waiting", { initial: true })
    .variant("active")
    .build();
  const other = defineState<{ id: string }>().name("other").variant("x", { initial: true }).build();

  const a = member.waiting({ id: "a", n: 1 });
  const b = member.active({ id: "b", n: 2 });
  const c = member.waiting({ id: "c", n: 3 });

  it("items() is empty, frozen and branded with ITEMS", () => {
    const empty = member.items();

    expect(empty).toBeInstanceOf(Items);
    expect(empty.size).toBe(0);
    expect([...empty]).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
    expect(Reflect.has(empty, ITEMS)).toBe(true);
    expect(String(empty)).toBe("Items(0){}");
  });

  it("definitionOf gives the definition an Items holds instances of: empty, filled, emptied, or a keyed set", () => {
    const keyed = member.items({ key: (item) => item.id });

    expect([
      definitionOf(member.items()),
      definitionOf(member.items().with("a", a)),
      definitionOf(member.items().with("a", a).without("a")),
      definitionOf(keyed.with(a)),
      definitionOf(other.items()),
    ]).toEqual([member, member, member, member, other]);
    expect(String(definitionOf(member.items()))).toBe("member");
  });

  it("with and without return new maps and leave the old untouched", () => {
    const empty = member.items();
    const one = empty.with("a", a);
    const two = one.with("b", b);
    const back = two.without("a");

    expect([empty.size, one.size, two.size, back.size]).toEqual([0, 1, 2, 1]);
    expect([...one]).toEqual([["a", a]]);
    expect([...two]).toEqual([
      ["a", a],
      ["b", b],
    ]);
    expect([...back]).toEqual([["b", b]]);
    for (const items of [empty, one, two, back]) {
      expect(Object.isFrozen(items)).toBe(true);
    }
  });

  it("reads as a ReadonlyMap in insertion order; with on a taken key keeps its place", () => {
    const items = member.items().with("b", b).with("a", a).with("c", c);
    const replaced = items.with("a", member.active(a));

    expect(items.get("a")).toBe(a);
    expect(items.get("z")).toBeUndefined();
    expect([items.has("a"), items.has("z")]).toEqual([true, false]);
    expect([...items.keys()]).toEqual(["b", "a", "c"]);
    expect([...items.values()]).toEqual([b, a, c]);
    expect([...items.entries()]).toEqual([
      ["b", b],
      ["a", a],
      ["c", c],
    ]);
    const visited: Array<[unknown, unknown, unknown]> = [];
    items.forEach(function (this: unknown, value, key, map) {
      visited.push([key, value, map === items && this === "self"]);
    }, "self");
    expect(visited).toEqual([
      ["b", b, true],
      ["a", a, true],
      ["c", c, true],
    ]);
    expect([...replaced.keys()]).toEqual(["b", "a", "c"]);
    expect(String(replaced.get("a"))).toBe("member.active(id=a n=1)");
    expect(String(items)).toBe(
      "Items(3){b=member.active(id=b n=2) a=member.waiting(id=a n=1) c=member.waiting(id=c n=3)}",
    );
  });

  it("with refuses an instance of another definition, and anything that is not an instance", () => {
    const items = member.items();
    const set = member.items({ key: (m) => m.id });

    // Another definition's instance breaks the type on purpose, hence the casts.
    expect(() => items.with("x", other.x({ id: "x" }) as never)).toThrow(StateFlowError);
    expect(() => items.with("x", other.x({ id: "x" }) as never)).toThrow("Items of member take its instances only");
    expect(() => set.with(other.x({ id: "x" }) as never)).toThrow("Items of member take its instances only");
    expect(() => items.with("x", { id: "x", n: 0 } as never)).toThrow("Items of member take its instances only");
  });

  it("with refuses an instance of another definition that has the same name: definitions match by identity", () => {
    const twin = defineState<{ id: string; n: number }>()
      .name("member")
      .variant("waiting", { initial: true })
      .variant("active")
      .build();

    expect(() => member.items().with("x", twin.waiting({ id: "x", n: 0 }))).toThrow(
      "Items of member take its instances only",
    );
  });

  it("a keyed set takes with(item) and keys it; a map takes with(key, item); the other form throws", () => {
    const set = member
      .items({ key: (m) => m.id })
      .with(a)
      .with(b);

    expect([...set.keys()]).toEqual(["a", "b"]);
    expect(set.get("b")).toBe(b);
    expect([...set.without("a").keys()]).toEqual(["b"]);
    expect(() => set.with("c", c)).toThrow("Items of member: a keyed set takes with(item) and keys it itself");
    expect(() => member.items().with(c)).toThrow("Items of member: a map takes with(key, item)");
  });

  it("a keyed-set element whose reducer changes its key is an Error, and nothing commits", () => {
    const rename = defineSignal<{ id: string; to: string }>("rename");
    const bump = defineSignal<{ id: string }>("bump");
    const tag = defineState<{ id: string; n: number }>()
      .name("tag")
      .signals({ rename, bump })
      .variant("on", { initial: true })
      .build();
    defineFlow(tag.on, {
      rename: (t, { id, to }, ctx) => (ctx.key === id ? { ...t, id: to } : t),
      bump: (t, { id }, ctx) => (ctx.key === id ? { ...t, n: t.n + 1 } : t),
    });
    const board = defineState<{ tags: Items<typeof tag> }>().name("board").variant("open", { initial: true }).build();
    const tags = tag.items({ key: (t) => t.id }).with(tag.on({ id: "a", n: 0 }));
    const target = { board: { tags } };
    const updates: unknown[] = [];
    applyFlow(target, [board], (sm) => {
      sm.addUpdateHandler(tag.on, (t, _snapshot, _prev, key) => {
        updates.push([key, String(t)]);
        return HandlerResult.ok();
      });
    });
    const before = target.board;

    const renamed = dispatch(target, rename({ id: "a", to: "z" }));

    expect(renamed.kind).toBe(ResultKind.Error);
    expect(renamed.error?.message).toBe(
      "board.tags[a]: the reducer of tag.on for rename returned tag.on(id=z n=0), whose key z is not its own [SF057] Keep the props the key is made of; add a new element to change the key.",
    );
    expect(target.board).toBe(before);
    expect(updates).toEqual([]);

    // A reducer that keeps the key commits, and the element stays under it.
    expect(dispatch(target, bump({ id: "a" })).kind).toBe(ResultKind.OK);
    expect(updates).toEqual([["a", "tag.on(id=a n=1)"]]);
    expect([...target.board.tags.keys()]).toEqual(["a"]);
  });

  describe("a keyed-set element whose key changes", () => {
    const rename = defineSignal<{ id: string }>("rename");

    /** A board of tags keyed by id; tag.on's rename reducer is left to the test, and entering lit is refused. */
    function defineBoard() {
      const tag = defineState<{ id: string; n: number }>()
        .name("tag")
        .signals({ rename })
        .variant("on", { initial: true })
        .variant("lit", { results: { relabel: (data) => String(data) } })
        .variant("off")
        .build();
      const board = defineState<{ tags: Items<typeof tag> }>().name("board").variant("open", { initial: true }).build();
      return { tag, board };
    }

    function makeBoard({ tag, board }: ReturnType<typeof defineBoard>, enterLit: () => HandlerResult<"tag.lit">) {
      const target = { board: { tags: tag.items({ key: (t) => t.id }).with(tag.on({ id: "a", n: 0 })) } };
      applyFlow(target, [board], (sm) => {
        sm.addEnterHandler(tag.lit, enterLit);
      });
      return target;
    }

    it("through a result reducer: an entry failure, and nothing commits", () => {
      const made = defineBoard();
      const { tag } = made;
      defineFlow(tag.on, { rename: (t, { id }, ctx) => (ctx.key === id ? tag.lit(t) : t) });
      defineFlow(tag.lit, {}, { relabel: (t, id) => ({ ...t, id }) });
      const target = makeBoard(made, () => tag.lit.results.relabel("z"));
      const before = target.board;

      const r = dispatch(target, rename({ id: "a" }));

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe(
        "board.tags[a]: the result reducer relabel of tag.lit returned tag.lit(id=z n=0), whose key z is not its own [SF057] Keep the props the key is made of; add a new element to change the key.",
      );
      expect(target.board).toBe(before);
    });

    it("through a failed instance: an Error when the reducer returns, before any handler runs, and nothing commits", () => {
      const made = defineBoard();
      const { tag } = made;
      defineFlow(tag.on, {
        rename: (t, { id }, ctx) => (ctx.key === id ? StateResult.ok(tag.lit(t), tag.off({ ...t, id: "z" })) : t),
      });
      let entered = false;
      const target = makeBoard(made, () => {
        entered = true;
        return HandlerResult.ok();
      });
      const before = target.board;

      const r = dispatch(target, rename({ id: "a" }));

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe(
        "board.tags[a]: the reducer of tag.on for rename returned tag.off(id=z n=0), whose key z is not its own [SF057] Keep the props the key is made of; add a new element to change the key.",
      );
      expect(entered).toBe(false);
      expect(target.board).toBe(before);
    });

    it("through a FAILURE reducer: the failed step skips it, so failed commits as its reducer declared it, and the Error joins the result", () => {
      const made = defineBoard();
      const { tag } = made;
      defineFlow(tag.on, {
        rename: (t, { id }, ctx) => (ctx.key === id ? StateResult.ok(tag.lit(t), tag.off(t)) : t),
      });
      defineFlow(tag.off, {}, { [FAILURE]: (t) => ({ ...t, id: "z" }) });
      const target = makeBoard(made, () => HandlerResult.rejected("not now"));

      const r = dispatch(target, rename({ id: "a" }));

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe(
        "board.tags[a]: the result reducer FAILURE of tag.off returned tag.off(id=z n=0), whose key z is not its own [SF057] Keep the props the key is made of; add a new element to change the key.",
      );
      expect(String(target.board.tags.get("a"))).toBe("tag.off(id=a n=0)");
    });
  });

  describe("the key function of a keyed set", () => {
    const bump = defineSignal("bump");
    const tag = defineState<{ id: string; n: number }>()
      .name("tag")
      .signals({ bump })
      .variant("on", { initial: true })
      .build();
    defineFlow(tag.on, { bump: (t) => ({ ...t, n: t.n + 1 }) });
    const board = defineState<{ tags: Items<typeof tag> }>().name("board").variant("open", { initial: true }).build();

    it("runs where user code builds an element and on a reducer's new element, never in the engine's rebuild", () => {
      let calls = 0;
      const key = (t: { id: string }): string => {
        calls += 1;
        return t.id;
      };
      const target = { board: { tags: tag.items({ key }).with(tag.on({ id: "a", n: 0 })) } };
      applyFlow(target, [board], () => {});
      expect(calls).toBe(1);

      expect(dispatch(target, bump()).kind).toBe(ResultKind.OK);

      // One call checks the reducer's new element; rebuilding the set and the board around it makes none.
      expect(calls).toBe(2);
      expect(String(target.board)).toBe("board.open(tags=Items(1){a=tag.on(id=a n=1)})");
    });

    it("runs in reducer scope when it checks a reducer's new element: a Box.deref there is the reducer's Error", () => {
      const box = Box.of({ live: true });
      const key = (t: { id: string }): string => {
        box.deref();
        return t.id;
      };
      // Outside a reducer the same key function runs: with() keys the element.
      const target = { board: { tags: tag.items({ key }).with(tag.on({ id: "a", n: 0 })) } };
      applyFlow(target, [board], () => {});
      const before = target.board;

      const r = dispatch(target, bump());

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toContain("Cannot deref a Box inside a reducer");
      expect(target.board).toBe(before);
    });
  });

  it("a key with no string form prints as (no string form): a dispatch that adds its element, or changes another element, commits and logs", async () => {
    const add = defineSignal("add");
    const poke = defineSignal<{ key: string }>("poke");
    const el = defineState<{ n: number }>()
      .name("el")
      .signals({ poke })
      .variant("a", { initial: true })
      .variant("b")
      .build();
    defineFlow(el.a, { poke: (e, { key }, ctx) => (ctx.key === key ? el.b(e) : StateResult.ignored()) });
    const host = defineState<{ els: Items<typeof el, unknown> }>()
      .name("host")
      .signals({ add })
      .variant("x", { initial: true })
      .build();
    // String() throws on an object with no prototype.
    const bare: unknown = Object.create(null);
    defineFlow(host.x, { add: (h) => ({ els: h.els.with(bare, el.a({ n: 2 })) }) });
    const entries: StateFlowLogEntry[] = [];
    const target = { host: { els: el.items<unknown>().with("cam", el.a({ n: 1 })) } };
    applyFlow(target, [host], () => {}, { logHandlers: [(entry) => entries.push(entry)] });

    expect(dispatch(target, add()).kind).toBe(ResultKind.OK);
    expect(dispatch(target, poke({ key: "cam" })).kind).toBe(ResultKind.OK);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(String(target.host.els)).toBe("Items(2){cam=el.b(n=1) (no string form)=el.a(n=2)}");
    expect(entries.map((entry) => entry.stateChanges.map((change) => change.stateName))).toEqual([
      ["host", "host.els[(no string form)]"],
      ["host", "host.els[cam]"],
    ]);
  });
});

describe("FrozenSet", () => {
  it("constructs from an iterable and is frozen", () => {
    const fs = new FrozenSet([1, 2, 3]);
    expect(fs.has(2)).toBe(true);
    expect(fs.size).toBe(3);
    expect([...fs]).toEqual([1, 2, 3]);
    expect(Object.isFrozen(fs)).toBe(true);
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
  it("constructs, reads, is frozen, and throws on mutators", () => {
    const fm = new FrozenMap<string, number>([["a", 1]]);
    expect(fm.get("a")).toBe(1);
    expect(fm.size).toBe(1);
    expect(Object.isFrozen(fm)).toBe(true);
    expect(() => fm.set("b", 2)).toThrow("immutable");
    expect(() => fm.delete("a")).toThrow("immutable");
    expect(() => fm.clear()).toThrow("immutable");
  });
});
