import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  type FlowSnapshot,
  HandlerResult,
  type InstanceOf,
  type Items,
  mockHandlers,
  ResultKind,
  type StateFlowLogEntry,
  type StateInstance,
  type StateManager,
  StateResult,
  type StateVariant,
  stateVar,
  subscribeFlow,
} from "..";
import { instanceAt, originOf, replaceAt } from "../tree";

/**
 * Nested states: a prop holding an instance, an Items map or a keyed set holds nested states, at any depth
 * and with no declaration. After the reducers, the engine diffs each tree position by position and runs the nested
 * states' handlers, which get their key in the parent's Items. Every reducer of every node the signal reaches runs on
 * the snapshot from before the signal, and the answers compose: a nested answer lands at its position in what its
 * ancestors answered. Every definition with reducers is made inside its test, because defineFlow binds once per
 * variant.
 */
describe("nested states", () => {
  // Log entries are delivered after the dispatch returns.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  type Call = { label: string; state: unknown; prev: unknown; key: unknown };

  /** Adds an enter, exit and update handler to each variant, each recording its call as "<variant> <kind>". */
  function recordAll(sm: StateManager, variants: Array<StateVariant<any, any, any, any>>, calls: Call[]) {
    for (const variant of variants) {
      for (const kind of ["enter", "exit", "update"] as const) {
        const record = (state: unknown, _snapshot: FlowSnapshot, prev: unknown, key: unknown): HandlerResult => {
          calls.push({ label: `${String(variant)} ${kind}`, state, prev, key });
          return HandlerResult.ok();
        };
        if (kind === "enter") {
          sm.addEnterHandler(variant, record);
        } else if (kind === "exit") {
          sm.addExitHandler(variant, record);
        } else {
          sm.addUpdateHandler(variant, record);
        }
      }
    }
  }

  /** The calls as "<label> <key>", the key left out when undefined. */
  const labels = (calls: Call[]) => calls.map((c) => (c.key === undefined ? c.label : `${c.label} ${String(c.key)}`));

  // A room holds members by key and one host. A member may hold a badge, so a gone member has a subtree.
  const badge = defineState<{ n: number }>().name("badge").variant("on", { initial: true }).variant("off").build();
  const member = defineState<{ id: number; badge?: InstanceOf<typeof badge> }>()
    .name("member")
    .variant("waiting", { initial: true })
    .variant("active")
    .build();
  const guest = defineState<{ id: number }>().name("guest").variant("in", { initial: true }).build();
  type Members = Items<typeof member>;
  type Host = InstanceOf<typeof member> | InstanceOf<typeof guest>;
  type RoomProps = { members?: Members; host?: Host };

  const set = defineSignal<{ to: "open" | "closed"; members?: Members; host?: Host }>("set");

  /** A fresh room whose one reducer moves it to the variant, members and host the signal names. */
  function defineRoom() {
    const room = defineState<RoomProps>()
      .name("room")
      .signals({ set })
      .variant("open", { initial: true })
      .variant("closed")
      .build();
    defineFlow(room.open, { set: (_s, { to, members, host }) => room[to]({ members, host }) });
    defineFlow(room.closed, { set: (_s, { to, members, host }) => room[to]({ members, host }) });
    return room;
  }

  /** A room target with `props`, every handler of the room and what it holds recording its call. */
  function makeRoom(props: RoomProps, entries: StateFlowLogEntry[] = []) {
    const room = defineRoom();
    const calls: Call[] = [];
    const t = { room: props };
    applyFlow(
      t,
      [room],
      (sm) =>
        recordAll(sm, [room.open, room.closed, member.waiting, member.active, badge.on, badge.off, guest.in], calls),
      { logHandlers: [(entry) => entries.push(entry)] },
    );
    return { room, t: t as unknown as { room: StateInstance<RoomProps> }, calls };
  }

  const members = (...entries: Array<[string, InstanceOf<typeof member>]>): Members =>
    entries.reduce((items, [key, m]) => items.with(key, m), member.items());

  describe("values", () => {
    it("a prop holding an instance, an Items map or a keyed set is a nested state at any depth, with no declaration", () => {
      const poke = defineSignal("poke");
      const leaf = defineState<{ id: string; n: number }>()
        .name("leaf")
        .signals({ poke })
        .variant("x", { initial: true })
        .build();
      const cell = defineState<{ n: number }>().name("cell").signals({ poke }).variant("x", { initial: true }).build();
      const mid = defineState<{ n: number; leaves: Items<typeof leaf, string> }>()
        .name("mid")
        .signals({ poke })
        .variant("x", { initial: true })
        .build();
      const top = defineState<{ mid: InstanceOf<typeof mid>; cells: Items<typeof cell> }>()
        .name("top")
        .variant("x", { initial: true })
        .build();
      defineFlow(leaf.x, { poke: (s) => ({ ...s, n: s.n + 1 }) });
      defineFlow(cell.x, { poke: (s) => ({ n: s.n + 1 }) });
      defineFlow(mid.x, { poke: (s) => ({ ...s, n: s.n + 1 }) });
      const t = {
        top: {
          mid: mid.x({ n: 0, leaves: leaf.items({ key: (l) => l.id }).with(leaf.x({ id: "l", n: 0 })) }),
          cells: cell.items().with("c", cell.x({ n: 0 })),
        },
      };
      const calls: Call[] = [];
      applyFlow(t, [top], (sm) => recordAll(sm, [top.x, mid.x, cell.x, leaf.x], calls));

      expect(dispatch(t, poke()).kind).toBe(ResultKind.OK);

      expect(labels(calls)).toEqual(["mid.x update", "leaf.x update l", "cell.x update c"]);
      expect(String(t.top)).toBe(
        "top.x(mid=mid.x(n=1 leaves=Items(1){l=leaf.x(id=l n=1)}) cells=Items(1){c=cell.x(n=1)})",
      );
    });
  });

  describe("the diff, position by position", () => {
    it("a new position enters with no prev; a gone one exits with its subtree, children first", () => {
      const a = member.waiting({ id: 1, badge: badge.on({ n: 1 }) });
      const { t, calls } = makeRoom({ members: members(["a", a]) });
      const open = t.room;

      dispatch(t, set({ to: "open", members: members(["b", member.waiting({ id: 2 })]) }));

      const b = t.room.members?.get("b");
      expect(calls).toEqual([
        { label: "badge.on exit", state: a.badge, prev: a.badge, key: undefined },
        { label: "member.waiting exit", state: a, prev: a, key: "a" },
        { label: "room.open update", state: t.room, prev: open, key: undefined },
        { label: "member.waiting enter", state: b, prev: undefined, key: "b" },
      ]);
    });

    it("the same variant updates; another variant exits, then enters with the instance it replaces as prev", () => {
      const a = member.waiting({ id: 1 });
      const b = member.waiting({ id: 2 });
      const { t, calls } = makeRoom({ members: members(["a", a], ["b", b]) });
      const a2 = member.waiting({ id: 10 });
      const b2 = member.active(b);

      dispatch(t, set({ to: "open", members: members(["a", a2], ["b", b2]) }));

      expect(calls.filter((c) => c.label.startsWith("member"))).toEqual([
        { label: "member.waiting exit", state: b, prev: b, key: "b" },
        { label: "member.waiting update", state: a2, prev: a, key: "a" },
        { label: "member.active enter", state: b2, prev: b, key: "b" },
      ]);
    });

    it("another definition at a position exits, and the new one enters with no prev", () => {
      const host = member.active({ id: 1 });
      const { t, calls } = makeRoom({ host });
      const visitor = guest.in({ id: 2 });

      dispatch(t, set({ to: "open", host: visitor }));

      expect(calls.filter((c) => !c.label.startsWith("room"))).toEqual([
        { label: "member.active exit", state: host, prev: host, key: undefined },
        { label: "guest.in enter", state: visitor, prev: undefined, key: undefined },
      ]);
    });

    it("a parent that changes variant and drops its Items exits every member, before its own exit", () => {
      const a = member.waiting({ id: 1 });
      const b = member.active({ id: 2 });
      const { room, t, calls } = makeRoom({ members: members(["a", a], ["b", b]) });
      const open = t.room;

      dispatch(t, set({ to: "closed" }));

      expect(stateVar(t.room)).toBe(room.closed);
      expect(calls).toEqual([
        { label: "member.active exit", state: b, prev: b, key: "b" },
        { label: "member.waiting exit", state: a, prev: a, key: "a" },
        { label: "room.open exit", state: open, prev: open, key: undefined },
        { label: "room.closed enter", state: t.room, prev: open, key: undefined },
      ]);
    });

    it("a key reused for another instance reads by position: the same variant updates, another variant exits and enters", () => {
      const first = member.waiting({ id: 1 });
      const { t, calls } = makeRoom({ members: members(["a", first]) });
      const second = member.waiting({ id: 2 });

      dispatch(t, set({ to: "open", members: members(["a", second]) }));

      expect(labels(calls)).toEqual(["room.open update", "member.waiting update a"]);

      calls.length = 0;
      dispatch(t, set({ to: "open", members: members(["a", member.active({ id: 3 })]) }));

      expect(labels(calls)).toEqual(["member.waiting exit a", "room.open update", "member.active enter a"]);
    });
  });

  describe("order", () => {
    it("exits run children first and later siblings first inside each state's tree, states in the flow's order; updates and enters run parents first", () => {
      const both = defineSignal("both");
      const m1 = defineState<{ id: number; badge?: InstanceOf<typeof badge> }>()
        .name("m1")
        .variant("w", { initial: true })
        .variant("a")
        .build();
      const r1 = defineState<{ members: Items<typeof m1> }>()
        .name("r1")
        .signals({ both })
        .variant("open", { initial: true })
        .variant("closed")
        .build();
      const r2 = defineState<{ host: InstanceOf<typeof m1> }>()
        .name("r2")
        .signals({ both })
        .variant("open", { initial: true })
        .variant("closed")
        .build();
      const promote = (m: InstanceOf<typeof m1>) => m1.a({ ...m, badge: m.badge && badge.off(m.badge) });
      defineFlow(r1.open, {
        both: (s) =>
          r1.closed({ members: [...s.members].reduce((items, [k, m]) => items.with(k, promote(m)), s.members) }),
      });
      defineFlow(r2.open, { both: (s) => r2.closed({ host: promote(s.host) }) });
      const t = {
        r1: {
          members: m1
            .items()
            .with("x", m1.w({ id: 1, badge: badge.on({ n: 1 }) }))
            .with("y", m1.w({ id: 2 })),
        },
        r2: { host: m1.w({ id: 3 }) },
      };
      const calls: Call[] = [];
      applyFlow(t, [r1, r2], (sm) =>
        recordAll(sm, [r1.open, r1.closed, r2.open, r2.closed, m1.w, m1.a, badge.on, badge.off], calls),
      );

      dispatch(t, both());

      expect(labels(calls)).toEqual([
        "m1.w exit y",
        "badge.on exit",
        "m1.w exit x",
        "r1.open exit",
        "m1.w exit",
        "r2.open exit",
        "r1.closed enter",
        "m1.a enter x",
        "badge.off enter",
        "m1.a enter y",
        "r2.closed enter",
        "m1.a enter",
      ]);
    });

    it("a parent's variant change alongside a nested state's update at a kept position: exits (child, then parent), the update, the parent's enter", () => {
      const host = member.active({ id: 1 });
      const leaving = member.waiting({ id: 2 });
      const { t, calls } = makeRoom({ host, members: members(["gone", leaving]) });
      const updated = member.active({ id: 10 });

      dispatch(t, set({ to: "closed", host: updated, members: members() }));

      expect(labels(calls)).toEqual([
        "member.waiting exit gone",
        "room.open exit",
        "member.active update",
        "room.closed enter",
      ]);
    });
  });

  describe("what runs nothing", () => {
    it("the same instance at a position runs nothing; a reducer's new instance of the parent's variant updates the parent only", () => {
      const a = member.waiting({ id: 1, badge: badge.on({ n: 1 }) });
      const kept = members(["a", a]);
      const { t, calls } = makeRoom({ members: kept, host: guest.in({ id: 9 }) });
      const host = t.room.host;

      dispatch(t, set({ to: "open", members: kept, host }));

      expect(labels(calls)).toEqual(["room.open update"]);
    });

    it("a node the engine rebuilt only to hold a changed nested state gets no call; a reducer's new instance of the same variant updates", () => {
      const poke = defineSignal<{ id: number }>("poke");
      const cell = defineState<{ id: number; n: number }>()
        .name("cell")
        .signals({ poke })
        .variant("x", { initial: true })
        .build();
      const grid = defineState<{ n: number; cells: Items<typeof cell> }>()
        .name("grid")
        .signals({ poke })
        .variant("x", { initial: true })
        .build();
      defineFlow(cell.x, { poke: (c, { id }) => (c.id === id ? { ...c, n: c.n + 1 } : StateResult.ignored()) });
      // The grid answers only for id 0: then both the grid and its cell change.
      defineFlow(grid.x, { poke: (g, { id }) => (id === 0 ? { ...g, n: g.n + 1 } : StateResult.ignored()) });
      const t = {
        grid: {
          n: 0,
          cells: cell
            .items()
            .with("a", cell.x({ id: 0, n: 0 }))
            .with("b", cell.x({ id: 1, n: 0 })),
        },
      };
      const calls: Call[] = [];
      applyFlow(t, [grid], (sm) => recordAll(sm, [grid.x, cell.x], calls));

      // Twice: a rebuild of a rebuild keeps the origin of the instance the reducer built.
      for (const n of [1, 2]) {
        calls.length = 0;
        dispatch(t, poke({ id: 1 }));

        expect(labels(calls)).toEqual(["cell.x update b"]);
        expect(String(t.grid)).toBe(`grid.x(n=0 cells=Items(2){a=cell.x(id=0 n=0) b=cell.x(id=1 n=${n})})`);
      }

      calls.length = 0;
      dispatch(t, poke({ id: 0 }));

      expect(labels(calls)).toEqual(["grid.x update", "cell.x update a"]);
      expect(String(t.grid)).toBe("grid.x(n=1 cells=Items(2){a=cell.x(id=0 n=1) b=cell.x(id=1 n=2)})");
    });

    it("a nested reducer that returns its own instance leaves its parent the same object, runs no handler and logs no change", async () => {
      const poke = defineSignal("poke");
      const cell = defineState<{ n: number }>().name("cell").signals({ poke }).variant("x", { initial: true }).build();
      const grid = defineState<{ cells: Items<typeof cell> }>().name("grid").variant("x", { initial: true }).build();
      defineFlow(cell.x, { poke: (c) => c });
      const entries: StateFlowLogEntry[] = [];
      const t = { grid: { cells: cell.items().with("a", cell.x({ n: 0 })) } };
      const calls: Call[] = [];
      applyFlow(t, [grid], (sm) => recordAll(sm, [grid.x, cell.x], calls), {
        logHandlers: [(entry) => entries.push(entry)],
      });
      const before = t.grid;

      expect(dispatch(t, poke()).kind).toBe(ResultKind.OK);
      await tick();

      expect(t.grid).toBe(before);
      expect(calls).toEqual([]);
      expect(entries.map((entry) => entry.stateChanges)).toEqual([[]]);
    });

    it("nested states of the initial snapshot get no enter", () => {
      const { calls } = makeRoom({
        members: members(["a", member.waiting({ id: 1, badge: badge.on({ n: 1 }) })]),
        host: guest.in({ id: 2 }),
      });

      expect(calls).toEqual([]);
    });
  });

  describe("reducers over the tree", () => {
    it("a signal runs every reducer in the tree whose variant declares it, each on the snapshot from before the signal", () => {
      const tick = defineSignal("tick");
      const seen: string[] = [];
      const clock = defineState<{ n: number }>()
        .name("clock")
        .signals({ tick })
        .variant("x", { initial: true })
        .build();
      const hand = defineState<{ n: number }>().name("hand").signals({ tick }).variant("x", { initial: true }).build();
      const face = defineState<{ n: number }>().name("face").variant("x", { initial: true }).build();
      const watch = defineState<{ n: number; hand: InstanceOf<typeof hand>; face: InstanceOf<typeof face> }>()
        .name("watch")
        .signals({ tick })
        .variant("x", { initial: true })
        .build();
      defineFlow(watch.x, {
        tick: (w, _signal, ctx) => {
          seen.push(`watch sees clock ${String(clock(ctx))}`);
          return { ...w, n: w.n + 1 };
        },
      });
      defineFlow(hand.x, {
        tick: (h, _signal, ctx) => {
          seen.push(`hand sees parent ${String(ctx.parent)}, clock ${String(clock(ctx))}`);
          return { n: h.n + 1 };
        },
      });
      defineFlow(clock.x, {
        tick: (c, _signal, ctx) => {
          seen.push(`clock sees watch ${String(watch(ctx))}`);
          return { n: c.n + 1 };
        },
      });
      const t = { watch: { n: 0, hand: hand.x({ n: 0 }), face: face.x({ n: 0 }) }, clock: { n: 0 } };
      applyFlow(t, [watch, clock], () => {});

      expect(dispatch(t, tick()).kind).toBe(ResultKind.OK);

      expect(seen).toEqual([
        "watch sees clock clock.x(n=0)",
        "hand sees parent watch.x(n=0 hand=hand.x(n=0) face=face.x(n=0)), clock clock.x(n=0)",
        "clock sees watch watch.x(n=0 hand=hand.x(n=0) face=face.x(n=0))",
      ]);
      expect([String(t.watch), String(t.clock)]).toEqual([
        "watch.x(n=1 hand=hand.x(n=1) face=face.x(n=0))",
        "clock.x(n=1)",
      ]);
    });

    it("an element picks itself by ctx.key, and only it changes", () => {
      const pause = defineSignal<{ key: string }>("pause");
      const producer = defineState<{ n: number }>()
        .name("producer")
        .signals({ pause })
        .variant("active", { initial: true })
        .variant("paused")
        .build();
      defineFlow(producer.active, {
        pause: (p, { key }, ctx) => (ctx.key === key ? producer.paused(p) : StateResult.ignored()),
      });
      const media = defineState<{ producers: Items<typeof producer> }>()
        .name("media")
        .variant("active", { initial: true })
        .build();
      const cam = producer.active({ n: 1 });
      const mic = producer.active({ n: 2 });
      const t = { media: { producers: producer.items().with("cam", cam).with("mic", mic) } };
      const calls: Call[] = [];
      applyFlow(t, [media], (sm) => recordAll(sm, [media.active, producer.active, producer.paused], calls));

      expect(dispatch(t, pause({ key: "cam" })).kind).toBe(ResultKind.OK);

      expect(labels(calls)).toEqual(["producer.active exit cam", "producer.paused enter cam"]);
      expect(stateVar(t.media.producers.get("cam") as InstanceOf<typeof producer>)).toBe(producer.paused);
      expect(t.media.producers.get("mic")).toBe(mic);
    });
  });

  describe("transitions of nested states", () => {
    const go = defineSignal<{ key: string }>("go");

    /** A producer that a media holds by key; its reducer for go declares a transition when go names its key. */
    function defineMedia() {
      const producer = defineState<{ id: string }>()
        .name("producer")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("creating", { transitional: true })
        .variant("active", { async: true })
        .variant("failed")
        .build();
      defineFlow(producer.idle, {
        go: (p, { key }, ctx) =>
          ctx.key === key
            ? StateResult.transition(producer.active(p), producer.creating(p), producer.failed(p))
            : StateResult.ignored(),
      });
      const media = defineState<{ producers: Items<typeof producer> }>()
        .name("media")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("busy")
        .build();
      // The parent answers too, keeping its producers.
      defineFlow(media.idle, { go: (m) => media.busy(m) });
      return { producer, media };
    }

    function makeMedia({ producer, media }: ReturnType<typeof defineMedia>, init: (sm: StateManager) => void) {
      const t = {
        media: {
          producers: producer
            .items()
            .with("cam", producer.idle({ id: "cam" }))
            .with("mic", producer.idle({ id: "mic" })),
        },
      };
      applyFlow(t, [media], init);
      return t as unknown as { media: InstanceOf<typeof media> };
    }

    it("a nested transition lifts: temp, next and failed are the parent's answer with the child's temp, next and failed in place, and its transition handlers get the child's key", async () => {
      for (const work of [() => HandlerResult.ok(), () => HandlerResult.rejected("no camera")]) {
        const made = defineMedia();
        const keys: unknown[] = [];
        let finish: (r: HandlerResult) => void = () => {};
        const t = makeMedia(made, (sm) =>
          sm.addTransitionHandler(made.producer.active, (_next, _snapshot, _prev, key) => {
            keys.push(key);
            return new Promise<HandlerResult>((resolve) => {
              finish = resolve;
            });
          }),
        );
        const mic = t.media.producers.get("mic");

        const r = dispatch(t, go({ key: "cam" }));

        expect(r.kind).toBe(ResultKind.InTransition);
        expect(String(t.media)).toBe(
          "media.busy(producers=Items(2){cam=producer.creating(id=cam) mic=producer.idle(id=mic)})",
        );
        expect(keys).toEqual(["cam"]);
        finish(work());
        await r.done();
        expect(String(t.media)).toBe(
          `media.busy(producers=Items(2){cam=${work().kind === ResultKind.OK ? "producer.active" : "producer.failed"}(id=cam) mic=producer.idle(id=mic)})`,
        );
        expect(t.media.producers.get("mic")).toBe(mic);
      }
    });

    it("a transition mock on a nested variant gets the child's key, and gives work to a variant with no handler", async () => {
      const made = defineMedia();
      const t = makeMedia(made, () => {});
      const keys: unknown[] = [];
      using _mock = mockHandlers(made.producer.active, {
        transition: async (_next, _snapshot, _prev, key) => {
          keys.push(key);
          return HandlerResult.ok();
        },
      });

      const r = dispatch(t, go({ key: "mic" }));

      expect(r.kind).toBe(ResultKind.InTransition);
      await r.done();
      expect(keys).toEqual(["mic"]);
      expect(stateVar(t.media.producers.get("mic") as InstanceOf<typeof made.producer>)).toBe(made.producer.active);
    });

    it("two transitions anywhere in the flow are an Error, and nothing commits", () => {
      const { producer, media } = defineMedia();
      const lamp = defineState<{ n: number }>()
        .name("lamp")
        .signals({ go })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      defineFlow(lamp.off, { go: (l) => StateResult.transition(lamp.on(l), lamp.off(l), lamp.off(l)) });
      const target = {
        media: { producers: producer.items().with("cam", producer.idle({ id: "cam" })) },
        lamp: { n: 0 },
      };
      applyFlow(target, [media, lamp], () => {});
      const before = [target.media, target.lamp];

      const r = dispatch(target, go({ key: "cam" }));

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe(
        "two transitions declared in one dispatch: media.producers[cam] and lamp [SF055] Declare the transition in one reducer; let the other answer with next.",
      );
      expect([target.media, target.lamp]).toEqual(before);
    });

    it("a transitional variant commits at any depth only inside the declaring node's temp: an answer that puts one at depth 2 outside it is an Error", () => {
      const producer = defineState<{ id: string }>()
        .name("producer")
        .variant("idle", { initial: true })
        .variant("creating", { transitional: true })
        .build();
      const media = defineState<{ producers: Items<typeof producer> }>()
        .name("media")
        .variant("idle", { initial: true })
        .build();
      const root = defineState<{ media: InstanceOf<typeof media> }>()
        .name("root")
        .signals({ go })
        .variant("x", { initial: true })
        .build();
      // root's answer puts a creating producer two levels down, with no transition.
      defineFlow(root.x, {
        go: (r) =>
          root.x({ media: media.idle({ producers: r.media.producers.with("cam", producer.creating({ id: "cam" })) }) }),
      });
      const target = { root: { media: media.idle({ producers: producer.items() }) } };
      applyFlow(target, [root], () => {});
      const before = target.root;

      const r = dispatch(target, go({ key: "cam" }));

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe(
        "root.media.producers[cam] would be left in producer.creating, a transitional variant, which commits only as the temp of a declared transition [SF021] Return that variant as the temp of StateResult.transition, or another variant as next.",
      );
      expect(target.root).toBe(before);
    });
  });

  describe("composing answers", () => {
    const go = defineSignal("go");

    // A three-level tree, outer -> inner -> core, whose reducers each test defines.
    const shapes = () => {
      const core = defineState<{ n: number }>()
        .name("core")
        .signals({ go })
        .variant("on", { initial: true })
        .variant("off")
        .build();
      const inner = defineState<{ n: number; core: InstanceOf<typeof core> }>()
        .name("inner")
        .signals({ go })
        .variant("x", { initial: true })
        .variant("y")
        .build();
      const outer = defineState<{ n: number; inner?: InstanceOf<typeof inner> }>()
        .name("outer")
        .signals({ go })
        .variant("open", { initial: true })
        .variant("closed")
        .build();
      return { core, inner, outer };
    };
    type Shapes = ReturnType<typeof shapes>;

    function makeTree({ core, inner, outer }: Shapes) {
      const t = { outer: { n: 0, inner: inner.x({ n: 0, core: core.on({ n: 0 }) }) } };
      applyFlow(t, [outer], () => {});
      return t as unknown as { outer: InstanceOf<Shapes["outer"]> };
    }

    it("a child's answer lands at its position in a parent that kept it or did not answer", () => {
      for (const parentAnswers of [true, false]) {
        const s = shapes();
        defineFlow(s.core.on, { go: (c) => s.core.off(c) });
        if (parentAnswers) {
          // `...o` keeps the child: the same instance at its position.
          defineFlow(s.outer.open, { go: (o) => ({ ...o, n: o.n + 1 }) });
        }
        defineFlow(s.inner.x, { go: (i) => ({ ...i, n: i.n + 1 }) });
        const t = makeTree(s);

        expect(dispatch(t, go()).kind, String(parentAnswers)).toBe(ResultKind.OK);

        expect(String(t.outer), String(parentAnswers)).toBe(
          `outer.open(n=${parentAnswers ? 1 : 0} inner=inner.x(n=1 core=core.off(n=0)))`,
        );
      }
    });

    it("at depth 2 with no answer above, the answer lands in the committed nodes", () => {
      const s = shapes();
      defineFlow(s.core.on, { go: (c) => s.core.off(c) });
      const t = makeTree(s);
      const inner = t.outer.inner;

      expect(dispatch(t, go()).kind).toBe(ResultKind.OK);

      expect(String(t.outer)).toBe("outer.open(n=0 inner=inner.x(n=0 core=core.off(n=0)))");
      // The committed inner was rebuilt around the new core: the same props, no parser run.
      expect(t.outer.inner).not.toBe(inner);
      expect(t.outer.inner?.n).toBe(inner?.n);
    });

    it("an ancestor that replaced the node in between, keeping the answered node, commits both changes", () => {
      const s = shapes();
      defineFlow(s.core.on, { go: (c) => s.core.off(c) });
      // inner has no reducer; outer replaces it with another variant that holds the same core.
      defineFlow(s.outer.open, {
        go: (o) => s.outer.closed({ ...o, inner: o.inner && s.inner.y({ ...o.inner, n: 5 }) }),
      });
      const t = makeTree(s);

      expect(dispatch(t, go()).kind).toBe(ResultKind.OK);

      expect(String(t.outer)).toBe("outer.closed(n=0 inner=inner.y(n=5 core=core.off(n=0)))");
    });

    it("a parent that replaced or removed an answering child is an Error, and nothing commits", () => {
      const reducers = {
        replaced: (s: Shapes) => (o: { n: number; inner?: InstanceOf<Shapes["inner"]> }) =>
          ({ ...o, inner: o.inner && s.inner.y(o.inner) }) as never,
        removed: () => (o: { n: number }) => ({ n: o.n }) as never,
      };
      for (const [label, reducer] of Object.entries(reducers)) {
        const s = shapes();
        defineFlow(s.inner.x, { go: (i) => ({ ...i, n: i.n + 1 }) });
        defineFlow(s.outer.open, { go: reducer(s) });
        const t = makeTree(s);
        const before = t.outer;

        const r = dispatch(t, go());

        expect(r.kind, label).toBe(ResultKind.Error);
        expect(r.error?.message, label).toBe(
          "outer replaced or removed outer.inner, whose own reducer also answered [SF023] Keep the nested state in the parent's answer, or let only one of the two reducers answer.",
        );
        expect(t.outer, label).toBe(before);
      }
    });

    it("at depth 2, an ancestor that removed the node in between, or holds a copy of the answered node, is an Error", () => {
      const reducers = {
        "removed the node in between": () => (o: { n: number }) => ({ n: o.n }) as never,
        "holds a copy of the answered node": (s: Shapes) => (o: { n: number; inner?: InstanceOf<Shapes["inner"]> }) =>
          ({ ...o, inner: o.inner && s.inner.y({ ...o.inner, core: s.core.on({ n: 0 }) }) }) as never,
      };
      for (const [label, reducer] of Object.entries(reducers)) {
        const s = shapes();
        defineFlow(s.core.on, { go: (c) => s.core.off(c) });
        defineFlow(s.outer.open, { go: reducer(s) });
        const t = makeTree(s);
        const before = t.outer;

        const r = dispatch(t, go());

        expect(r.kind, label).toBe(ResultKind.Error);
        expect(r.error?.message, label).toBe(
          "outer replaced or removed outer.inner.core, whose own reducer also answered [SF023] Keep the nested state in the parent's answer, or let only one of the two reducers answer.",
        );
        expect(t.outer, label).toBe(before);
      }
    });

    it("a nested answer that removes an answering node below it is an Error too, and nothing commits", () => {
      const s = shapes();
      defineFlow(s.core.on, { go: (c) => s.core.off(c) });
      // inner answers without its core, whose own reducer answered.
      defineFlow(s.inner.x, { go: (i) => ({ n: i.n + 1 }) as never });
      const t = makeTree(s);
      const before = t.outer;

      const r = dispatch(t, go());

      expect(r.kind).toBe(ResultKind.Error);
      expect(r.error?.message).toBe(
        "outer.inner replaced or removed outer.inner.core, whose own reducer also answered [SF023] Keep the nested state in the parent's answer, or let only one of the two reducers answer.",
      );
      expect(t.outer).toBe(before);
    });

    it("a transition's temp or failed that removes an answering node below the declaring state is an Error, and nothing commits", () => {
      for (const which of ["temp", "failed"] as const) {
        const s = shapes();
        defineFlow(s.inner.x, { go: (i) => ({ ...i, n: i.n + 1 }) });
        // A valid transition but for the one end that drops inner: temp closed, next and failed open.
        defineFlow(s.outer.open, {
          go: (o) =>
            which === "temp"
              ? StateResult.transition(s.outer.open(o), s.outer.closed({ n: o.n }), s.outer.open(o))
              : StateResult.transition(s.outer.open(o), s.outer.closed(o), s.outer.open({ n: o.n })),
        });
        const t = makeTree(s);
        const before = t.outer;

        const r = dispatch(t, go());

        expect(r.kind, which).toBe(ResultKind.Error);
        expect(r.error?.message, which).toBe(
          "outer replaced or removed outer.inner, whose own reducer also answered [SF023] Keep the nested state in the parent's answer, or let only one of the two reducers answer.",
        );
        expect(t.outer, which).toBe(before);
      }
    });

    it("a parent whose parser throws after its first construction still commits a child's change: a rebuild runs no parser", () => {
      const s = shapes();
      defineFlow(s.core.on, { go: (c) => s.core.off(c) });
      let parsed = 0;
      const strict = defineState<{ inner: InstanceOf<Shapes["inner"]> }>()
        .name("strict")
        .variant("x", { initial: true })
        .parser((p) => {
          parsed += 1;
          if (parsed > 1) {
            throw new Error("parsed twice");
          }
          return { ...(p as { inner: InstanceOf<Shapes["inner"]> }) };
        })
        .build();
      const t = { strict: { inner: s.inner.x({ n: 0, core: s.core.on({ n: 0 }) }) } };
      applyFlow(t, [strict], () => {});

      expect(dispatch(t, go()).kind).toBe(ResultKind.OK);

      expect(parsed).toBe(1);
      expect(String(t.strict)).toBe("strict.x(inner=inner.x(n=0 core=core.off(n=0)))");
    });

    it("a rebuild keeps what the parser built: an own getter, which then reads the rebuilt node, and a null prototype", () => {
      const s = shapes();
      defineFlow(s.inner.x, { go: (i) => ({ ...i, n: i.n + 1 }) });
      type Inner = InstanceOf<Shapes["inner"]>;
      const host = defineState<{ inner: Inner; readonly innerN: number }>()
        .name("host")
        .variant("x", { initial: true })
        .parser((p) =>
          Object.create(null, {
            inner: { value: (p as { inner: Inner }).inner, enumerable: true },
            innerN: {
              get(this: { inner: Inner }): number {
                return this.inner.n;
              },
              enumerable: true,
            },
          }),
        )
        .stringRepr((h) => `holds ${String(h.inner)}`)
        .build();
      const t = { host: { inner: s.inner.x({ n: 0, core: s.core.on({ n: 0 }) }) } } as unknown as {
        host: InstanceOf<typeof host>;
      };
      applyFlow(t, [host], () => {});

      expect(dispatch(t, go()).kind).toBe(ResultKind.OK);

      expect(Object.getPrototypeOf(t.host)).toBeNull();
      expect(String(t.host)).toBe("host.x(holds inner.x(n=1 core=core.on(n=0)))");
      expect(t.host.innerN).toBe(1);
    });

    it("a getter that returns a nested state is a value derived from the props, not a position: the node runs its reducer and handlers once", () => {
      const s = shapes();
      defineFlow(s.core.on, { go: (c) => s.core.off(c) });
      type Inner = InstanceOf<Shapes["inner"]>;
      const alias = defineState<{ inner: Inner; readonly core: Inner["core"] }>()
        .name("alias")
        .variant("x", { initial: true })
        .parser((p) => ({
          inner: (p as { inner: Inner }).inner,
          get core(): Inner["core"] {
            return this.inner.core;
          },
        }))
        .build();
      const t = { alias: { inner: s.inner.x({ n: 0, core: s.core.on({ n: 0 }) }) } } as unknown as {
        alias: InstanceOf<typeof alias>;
      };
      const calls: Call[] = [];
      applyFlow(t, [alias], (sm) => recordAll(sm, [s.core.on, s.core.off], calls));

      expect(dispatch(t, go()).kind).toBe(ResultKind.OK);

      expect(labels(calls)).toEqual(["core.on exit", "core.off enter"]);
      expect(t.alias.core).toBe(t.alias.inner.core);
      expect(String(t.alias.core)).toBe("core.off(n=0)");
    });
  });

  describe("handlers and the log", () => {
    it("a nested handler gets the step's snapshot, frozen and holding the committed tree", () => {
      const room = defineRoom();
      const t = { room: {} } as unknown as { room: StateInstance<RoomProps> };
      const seen: FlowSnapshot[] = [];
      applyFlow(t, [room], (sm) =>
        sm.addEnterHandler(member.waiting, (_m, snapshot) => {
          seen.push(snapshot);
          return HandlerResult.ok();
        }),
      );

      dispatch(t, set({ to: "open", members: members(["a", member.waiting({ id: 1 })]) }));

      expect(seen).toHaveLength(1);
      expect(Object.isFrozen(seen[0])).toBe(true);
      expect(seen[0].room).toBe(t.room);
    });

    it("a nested exit handler's Rejected refuses the dispatch: nothing commits, and its handler result names the handler and the node by path", async () => {
      const entries: StateFlowLogEntry[] = [];
      const room = defineRoom();
      const t = { room: { members: members(["a", member.waiting({ id: 1 })]) } } as unknown as {
        room: StateInstance<RoomProps>;
      };
      function onMemberExit(): HandlerResult {
        return HandlerResult.rejected("not now");
      }
      applyFlow(t, [room], (sm) => sm.addExitHandler(member.waiting, onMemberExit), {
        logHandlers: [(entry) => entries.push(entry)],
      });
      const before = t.room;

      const r = dispatch(t, set({ to: "open", members: members() }));
      await tick();

      expect(r.kind).toBe(ResultKind.Rejected);
      expect(t.room).toBe(before);
      expect(entries[0].handlerResults).toEqual([
        { type: "exit", handlerName: "onMemberExit", stateName: "room.members[a]", result: "Rejected: not now" },
      ]);
    });

    it("handler results and changes are named by path, and finalStates show the nested variants", async () => {
      const entries: StateFlowLogEntry[] = [];
      const { t } = makeRoom({ host: member.waiting({ id: 1, badge: badge.on({ n: 1 }) }) }, entries);

      dispatch(
        t,
        set({
          to: "open",
          host: member.waiting({ id: 1, badge: badge.off({ n: 1 }) }),
          members: members(["cam", member.active({ id: 2 })]),
        }),
      );
      await tick();

      expect(entries[0].stateChanges.map((change) => change.stateName)).toEqual([
        "room",
        "room.host",
        "room.host.badge",
        "room.members[cam]",
      ]);
      expect(entries[0].handlerResults.map((line) => `${line.type} ${line.stateName}`)).toEqual([
        "exit room.host.badge",
        "update room",
        "update room.host",
        "enter room.host.badge",
        "enter room.members[cam]",
      ]);
      expect(entries[0].finalStates).toEqual({
        room: "room.open(members=Items(1){cam=member.active(id=2)} host=member.waiting(id=1 badge=badge.off(n=1)))",
      });
    });

    it("with a declared transition, nested answers commit in the temp step: below the declaring state they land in temp and stay in its end; elsewhere the end leaves them as committed", async () => {
      const start = defineSignal("start");
      const part = defineState<{ n: number }>().name("part").signals({ start }).variant("x", { initial: true }).build();
      const lamp = defineState<{ on: boolean }>()
        .name("lamp")
        .signals({ start })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      const job = defineState<{ part: InstanceOf<typeof part> }>()
        .name("job")
        .signals({ start })
        .variant("idle", { initial: true })
        .variant("running")
        .variant("done")
        .variant("failed")
        .build();
      const panel = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("panel")
        .variant("x", { initial: true })
        .build();
      defineFlow(part.x, { start: (p) => ({ n: p.n + 1 }) });
      defineFlow(lamp.off, { start: (l) => lamp.on(l) });
      // temp, next and failed keep the part the reducer ran on, so the part's own answer lands in each of them.
      defineFlow(job.idle, { start: (j) => StateResult.transition(job.done(j), job.running(j), job.failed(j)) });
      const entries: StateFlowLogEntry[] = [];
      const calls: Call[] = [];
      const t = { job: { part: part.x({ n: 0 }) }, panel: { lamp: lamp.off({ on: false }) } };
      applyFlow(t, [job, panel], (sm) => recordAll(sm, [part.x, lamp.off, lamp.on, panel.x], calls), {
        logHandlers: [(entry) => entries.push(entry)],
      });
      const changes: string[] = [];
      using _sub = subscribeFlow(t, (change) => changes.push(`${change.stateName} ${change.nextVariant}`));

      // No work handler: the end runs inside the dispatch.
      expect(dispatch(t, start()).kind).toBe(ResultKind.OK);
      await tick();

      expect(String(t.job)).toBe("job.done(part=part.x(n=1))");
      expect(String(t.panel)).toBe("panel.x(lamp=lamp.on(on=F))");
      expect(labels(calls)).toEqual(["lamp.off exit", "part.x update", "lamp.on enter"]);
      expect(entries.map((entry) => entry.stateChanges.map((change) => change.stateName))).toEqual([
        ["job", "job.part", "panel", "panel.lamp"],
        ["job"],
      ]);
      expect(changes).toEqual(["job running", "part x", "panel x", "lamp on", "job done"]);
    });

    it("the nested states a transition's temp holds enter in the temp step, before the work starts", async () => {
      const start = defineSignal("start");
      const seat = defineState<{ n: number }>().name("seat").variant("free", { initial: true }).build();
      const hall = defineState<{ seats?: Items<typeof seat> }>()
        .name("hall")
        .signals({ start })
        .variant("idle", { initial: true })
        .variant("loading")
        .variant("ready", { async: true })
        .variant("failed")
        .build();
      const seats = seat.items().with("s1", seat.free({ n: 1 }));
      defineFlow(hall.idle, {
        start: () => StateResult.transition(hall.ready({ seats }), hall.loading({ seats }), hall.failed({})),
      });
      const order: string[] = [];
      const t = { hall: {} } as unknown as { hall: InstanceOf<typeof hall> };
      applyFlow(
        t,
        [hall],
        (sm) => {
          sm.addEnterHandler(seat.free, (_s, _snapshot, _prev, key) => {
            order.push(`seat ${String(key)} enters while hall is ${String(stateVar(t.hall))}`);
            return HandlerResult.ok();
          });
          sm.addTransitionHandler(hall.ready, async () => {
            order.push(`work runs while hall is ${String(stateVar(t.hall))}`);
            return HandlerResult.ok();
          });
        },
        { logHandlers: [() => {}] },
      );

      const r = dispatch(t, start());

      expect(r.kind).toBe(ResultKind.InTransition);
      expect(order).toEqual(["seat s1 enters while hall is hall.idle", "work runs while hall is hall.loading"]);
      expect((await r.done()).kind).toBe(ResultKind.OK);
      expect(stateVar(t.hall)).toBe(hall.ready);
    });
  });

  describe("tree helpers below the top level", () => {
    it("instanceAt reads a node through an Items position; replaceAt puts a node there, rebuilding its ancestors in place with their origin", () => {
      const leaf = defineState<{ n: number }>().name("leaf").variant("x", { initial: true }).build();
      const mid = defineState<{ leaves: Items<typeof leaf> }>().name("mid").variant("x", { initial: true }).build();
      const top = defineState<{ mid: InstanceOf<typeof mid> }>().name("top").variant("x", { initial: true }).build();
      const b = leaf.x({ n: 2 });
      const leaves = leaf
        .items()
        .with("a", leaf.x({ n: 1 }))
        .with("b", b)
        .with("c", leaf.x({ n: 3 }));
      // The tree helpers take any state's instance, which a typed instance is not assignable to.
      const root = top.x({ mid: mid.x({ leaves }) }) as unknown as StateInstance;
      const snapshot: FlowSnapshot = Object.freeze({ top: root });
      const at = (key: string) => ({ state: "top", positions: [{ prop: "mid" }, { prop: "leaves", key }] });

      expect(instanceAt(snapshot, at("b"))).toBe(b);
      expect(instanceAt(snapshot, at("z"))).toBeUndefined();

      const b2 = leaf.x({ n: 20 }) as unknown as StateInstance;
      const replaced = replaceAt(snapshot, at("b"), b2);

      expect(Object.isFrozen(replaced)).toBe(true);
      expect(instanceAt(replaced, at("b"))).toBe(b2);
      expect(String(replaced.top)).toBe(
        "top.x(mid=mid.x(leaves=Items(3){a=leaf.x(n=1) b=leaf.x(n=20) c=leaf.x(n=3)}))",
      );
      const midAt = { state: "top", positions: [{ prop: "mid" }] };
      expect(originOf(replaced.top)).toBe(root);
      expect(originOf(instanceAt(replaced, midAt) as StateInstance)).toBe(instanceAt(snapshot, midAt));
    });
  });
});
