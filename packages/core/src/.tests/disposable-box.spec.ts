import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  Box,
  DisposableBox,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  HandlerResult,
  type InstanceOf,
  type Items,
  isBox,
  type Result,
  ResultKind,
  type StateManager,
  StateResult,
} from "..";

/** A resource that counts its disposals. */
class Conn {
  disposed = 0;

  [Symbol.dispose](): void {
    this.disposed += 1;
  }
}

/**
 * DisposableBox: a Box the engine owns once the flow has it. The plan refuses a face that holds one box in two places
 * or a box the engine disposed, and a transition whose temp drops a box that one of its ends holds again; after every
 * step, the boxes the step carried that the committed states do not hold are disposed; and disposeFlow disposes every
 * box the final states hold. Definitions are made inside each test, because defineFlow binds once per variant.
 */
describe("DisposableBox", () => {
  type Resource = Disposable | AsyncDisposable;
  type LinkProps = { conn: DisposableBox<Resource> | null; spare: DisposableBox<Resource> | null };

  const attach = defineSignal<{ conn: DisposableBox<Resource> }>("attach");
  const connect = defineSignal("connect");
  const rewrap = defineSignal<{ conn: Conn }>("rewrap");
  const swap = defineSignal("swap");

  /**
   * A link. From down (initial), attach goes up with the payload's box as conn, and connect goes up with the props as
   * they are. In up, rewrap wraps the payload's value anew as conn, and swap moves conn to spare. Up's named result
   * connected sets the props it carries; opened, whose data is a box, sets conn.
   */
  function defineLink() {
    const link = defineState<LinkProps>()
      .name("link")
      .signals({ attach, connect, rewrap, swap })
      .variant("down", { initial: true })
      .variant("up", {
        results: {
          connected: (data) => data as Partial<LinkProps>,
          opened: (data) => data as DisposableBox<Resource>,
        },
      })
      .build();

    defineFlow(link.down, { attach: (s, { conn }) => link.up({ ...s, conn }), connect: (s) => link.up(s) });
    defineFlow(
      link.up,
      {
        rewrap: (s, { conn }) => ({ ...s, conn: DisposableBox.of(conn) }),
        swap: (s) => ({ conn: null, spare: s.conn }),
      },
      { connected: (s, data) => ({ ...s, ...data }), opened: (s, conn) => ({ ...s, conn }) },
    );

    return link;
  }
  type Link = ReturnType<typeof defineLink>;
  type LinkTarget = { link: InstanceOf<Link> };

  /** A target of the link's flow holding `conn`, with the handlers `init` registers. */
  function makeLink(
    link: Link,
    conn: DisposableBox<Resource> | null,
    init: (sm: StateManager) => void = () => {},
  ): LinkTarget {
    const target = { link: { conn, spare: null } } as unknown as LinkTarget;
    applyFlow(target, [link], init, { logHandlers: [() => {}] });

    return target;
  }

  const shift = defineSignal("shift");
  const put = defineSignal<{ conn: DisposableBox<Conn> }>("put");
  const clear = defineSignal("clear");
  const split = defineSignal<{ conn: Conn }>("split");

  /**
   * A dock, which holds a box in one of four places: its own conn, its nested bay, or the bay under the key a or b of
   * its berths; and a yard, another state. Each shift moves the box one place on, in that order, and from b to the
   * yard. put sets the dock's conn to the payload's box, clear empties it, and split wraps the payload's value twice,
   * as the dock's conn and as its bay's.
   */
  function defineDock() {
    const bay = defineState<{ conn: DisposableBox<Conn> | null }>()
      .name("bay")
      .variant("only", { initial: true })
      .build();
    const dock = defineState<{
      conn: DisposableBox<Conn> | null;
      bay: InstanceOf<typeof bay>;
      berths: Items<typeof bay>;
    }>()
      .name("dock")
      .signals({ shift, put, clear, split })
      .variant("only", { initial: true })
      .build();
    const yard = defineState<{ conn: DisposableBox<Conn> | null }>()
      .name("yard")
      .signals({ shift })
      .variant("only", { initial: true })
      .build();

    defineFlow(dock.only, {
      shift: (s) => {
        if (s.conn !== null) {
          return { ...s, conn: null, bay: bay.only({ conn: s.conn }) };
        }
        if (s.bay.conn !== null) {
          return { ...s, bay: bay.only({ conn: null }), berths: s.berths.with("a", bay.only({ conn: s.bay.conn })) };
        }
        const a = s.berths.get("a");
        if (a?.conn) {
          return { ...s, berths: s.berths.with("a", bay.only({ conn: null })).with("b", bay.only({ conn: a.conn })) };
        }
        return { ...s, berths: s.berths.with("b", bay.only({ conn: null })) };
      },
      put: (s, { conn }) => ({ ...s, conn }),
      clear: (s) => ({ ...s, conn: null }),
      split: (s, { conn }) => ({ ...s, conn: DisposableBox.of(conn), bay: bay.only({ conn: DisposableBox.of(conn) }) }),
    });

    // The yard takes the box when the dock gives it up from b.
    defineFlow(yard.only, {
      shift: (s, _, ctx) => {
        const b = dock(ctx).berths.get("b");
        return b?.conn ? { conn: b.conn } : s;
      },
    });

    return { bay, dock, yard };
  }
  type Dock = ReturnType<typeof defineDock>;
  type DockTarget = { dock: InstanceOf<Dock["dock"]>; yard: InstanceOf<Dock["yard"]> };

  /** A target of the dock's flow whose dock holds `conn` and an empty bay under the key a, with `init`'s handlers. */
  function makeDock({ bay, dock, yard }: Dock, conn: DisposableBox<Conn> | null, init: (sm: StateManager) => void) {
    const target = {
      dock: { conn, bay: bay.only({ conn: null }), berths: bay.items().with("a", bay.only({ conn: null })) },
      yard: { conn: null },
    } as unknown as DockTarget;
    applyFlow(target, [dock, yard], init, { logHandlers: [() => {}] });

    return target;
  }

  const lift = defineSignal("lift");
  const hoist = defineSignal<{ conn: DisposableBox<Conn> }>("hoist");
  const stop = defineSignal("stop");

  /**
   * A crane. From idle, lift declares a transition to up, an asynchronous variant, through lifting, with failed as the
   * failed end; lifting keeps the conn idle holds, or with `drop` drops it, while up and failed hold it. hoist declares
   * that transition with the payload's box as up's conn, and none in lifting and failed. In lifting, stop goes back to
   * idle, which aborts the transition. Up's named result loaded sets conn from its data's conn and leaves its spare out.
   */
  function defineCrane(drop = false) {
    const crane = defineState<{ conn: DisposableBox<Conn> | null }>()
      .name("crane")
      .signals({ lift, hoist, stop })
      .variant("idle", { initial: true })
      .variant("lifting")
      .variant("up", {
        async: true,
        results: { loaded: (data) => data as { conn: DisposableBox<Conn>; spare: DisposableBox<Conn> } },
      })
      .variant("failed")
      .build();

    defineFlow(crane.idle, {
      lift: (s) => StateResult.transition(crane.up(s), crane.lifting(drop ? { conn: null } : s), crane.failed(s)),
      hoist: (_s, { conn }) =>
        StateResult.transition(crane.up({ conn }), crane.lifting({ conn: null }), crane.failed({ conn: null })),
    });
    defineFlow(crane.lifting, { stop: (s) => crane.idle(s) });
    defineFlow(crane.up, {}, { loaded: (s, { conn }) => ({ ...s, conn }) });

    return crane;
  }
  type Crane = ReturnType<typeof defineCrane>;
  type CraneTarget = { crane: InstanceOf<Crane> };

  /** A target of the crane's flow holding `conn`, with the handlers `init` registers. */
  function makeCrane(crane: Crane, conn: DisposableBox<Conn> | null, init: (sm: StateManager) => void = () => {}) {
    const target = { crane: { conn } } as unknown as CraneTarget;
    applyFlow(target, [crane], init, { logHandlers: [() => {}] });

    return target;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("is a Box: Box.equals, isBox and deref treat it as one", () => {
    const conn = new Conn();
    const box = DisposableBox.of(conn);

    expect(box).toBeInstanceOf(Box);
    expect(isBox(box)).toBe(true);
    expect(box.deref()).toBe(conn);
    expect(box.equals(Box.of(conn))).toBe(true);
  });

  describe("the plan refuses, before any handler runs, with an Error that names the places", () => {
    it("a face that holds one box in two places, two wrappers of one value in two nodes included", () => {
      const made = defineDock();
      const ran: string[] = [];
      const target = makeDock(made, null, (sm) => {
        sm.addUpdateHandler(made.dock.only, () => {
          ran.push("update");
          return HandlerResult.ok();
        });
      });
      const conn = new Conn();

      const result = dispatch(target, split({ conn }));

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toMatch(
        /^dock\.conn and dock\.bay\.conn hold Box\(Conn#\d+\) in next; a DisposableBox has one place in the states \[SF027\] Keep each DisposableBox in one prop; move it rather than copy it\.$/,
      );
      expect(ran).toEqual([]);
      expect(target.dock.conn).toBeNull();
    });

    it("a face that holds a box the engine disposed already", () => {
      const made = defineDock();
      const conn = new Conn();
      const box = DisposableBox.of(conn);
      const target = makeDock(made, box, () => {});

      dispatch(target, clear());
      expect(conn.disposed).toBe(1);

      const result = dispatch(target, put({ conn: box }));

      expect(result.error?.message).toMatch(
        /^dock\.conn holds Box\(Conn#\d+\) in next, which the engine disposed already \[SF028\] Make a new box for the resource instead of reusing the disposed one\.$/,
      );
      expect(target.dock.conn).toBeNull();
      expect(conn.disposed).toBe(1);
    });

    it("a declared transition whose temp drops a box the committed states hold while its next holds it again", () => {
      const crane = defineCrane(true);
      const ran: string[] = [];
      const conn = new Conn();
      const target = makeCrane(crane, DisposableBox.of(conn), (sm) => {
        sm.addEnterHandler(crane.lifting, () => {
          ran.push("lifting");
          return HandlerResult.ok();
        });
      });

      const result = dispatch(target, lift());

      expect(result.error?.message).toMatch(
        /^crane\.conn holds Box\(Conn#\d+\) at the end of the transition, which the temp drops from crane\.conn; the temp's commit disposes it \[SF026\] Keep the box in the temp too, or give the end a new box\.$/,
      );
      expect(ran).toEqual([]);
      expect(String(target.crane)).toMatch(/^crane\.idle/);
      expect(conn.disposed).toBe(0);
    });

    it("an abort whose failed step would hold one box in two places: the failed of the transition it aborts and another state's failed", async () => {
      vi.useFakeTimers();
      const go = defineSignal("go");
      const halt = defineSignal("halt");
      const conn = new Conn();

      // The crane's transition wraps conn in its failed; the yard's answer to halt wraps it again in its own failed.
      const crane = defineState<{ conn: DisposableBox<Conn> | null }>()
        .name("crane")
        .signals({ go, halt })
        .variant("idle", { initial: true })
        .variant("lifting", { transitional: true })
        .variant("up", { async: true })
        .variant("failed")
        .build();
      const yard = defineState<{ conn: DisposableBox<Conn> | null }>()
        .name("yard")
        .signals({ halt })
        .variant("empty", { initial: true })
        .variant("busy")
        .variant("broken")
        .build();
      defineFlow(crane.idle, {
        go: (s) =>
          StateResult.transition(crane.up(s), crane.lifting(s), crane.failed({ conn: DisposableBox.of(conn) })),
      });
      defineFlow(crane.lifting, { halt: () => crane.idle({ conn: null }) });
      defineFlow(yard.empty, {
        halt: (s) => StateResult.ok(yard.busy(s), yard.broken({ conn: DisposableBox.of(conn) })),
      });

      const target = { crane: { conn: null }, yard: { conn: null } } as unknown as {
        crane: InstanceOf<typeof crane>;
        yard: InstanceOf<typeof yard>;
      };
      applyFlow(
        target,
        [crane, yard],
        (sm) => {
          sm.addTransitionHandler(crane.up, () => new Promise<HandlerResult>(() => {}));
        },
        { logHandlers: [() => {}] },
      );
      void dispatch(target, go()).done();
      await vi.advanceTimersByTimeAsync(0);

      const result = dispatch(target, halt(), { abort: true });

      expect(result.error?.message).toMatch(
        /^crane\.conn and yard\.conn hold Box\(Conn#\d+\) in the failed step; a DisposableBox has one place in the states \[SF027\] Keep each DisposableBox in one prop; move it rather than copy it\.; the transition continues \[SF039\] Fix the reducer's error named in the message\.$/,
      );
      expect([String(target.crane), String(target.yard)]).toEqual(["crane.lifting(conn=N)", "yard.empty(conn=N)"]);
    });
  });

  describe("the fold of a step's named results keeps the plan's rules: before the commit, the step is refused with an Error that names the places", () => {
    const knock = defineSignal("knock");

    /** A gate, another state, whose result reducer takes the link's result opened and stores its box. */
    function defineGate() {
      const gate = defineState<{ conn: DisposableBox<Resource> | null }>()
        .name("gate")
        .signals({ knock })
        .variant("shut", { initial: true })
        .variant("open")
        .build();
      defineFlow(gate.shut, {}, { opened: (_g, conn: DisposableBox<Resource>) => gate.open({ conn }) });

      return gate;
    }

    it("when two states' result reducers store one box from one named result: the link's fold and the gate's answer", () => {
      const link = defineLink();
      const gate = defineGate();
      const placed = new Conn();
      const opened = new Conn();
      const target = { link: { conn: null, spare: null }, gate: { conn: null } } as unknown as LinkTarget & {
        gate: InstanceOf<typeof gate>;
      };
      applyFlow(
        target,
        [link, gate],
        (sm) => {
          sm.addEnterHandler(link.up, () => link.up.results.opened(DisposableBox.of(opened)));
        },
        { logHandlers: [() => {}] },
      );

      const result = dispatch(target, attach({ conn: DisposableBox.of(placed) }));

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toMatch(
        /^link\.conn and gate\.conn hold Box\(Conn#\d+\) when the named results fold; a DisposableBox has one place in the states \[SF027\] Keep each DisposableBox in one prop; move it rather than copy it\.$/,
      );
      expect([String(target.link), String(target.gate)]).toEqual(["link.down(conn=N spare=N)", "gate.shut(conn=N)"]);

      // The refused step carried both boxes, and no state holds either.
      expect([placed.disposed, opened.disposed]).toEqual([1, 1]);
    });

    it("when a named result places a box the engine disposed already", () => {
      const link = defineLink();
      const old = new Conn();
      const fresh = new Conn();
      const stale = DisposableBox.of(old);
      const target = makeLink(link, stale, (sm) => {
        sm.addUpdateHandler(link.up, () => link.up.results.connected({ spare: stale }));
      });
      dispatch(target, attach({ conn: DisposableBox.of(fresh) }));
      expect(old.disposed).toBe(1);

      const result = dispatch(target, rewrap({ conn: fresh }));

      expect(result.error?.message).toMatch(
        /^link\.spare holds Box\(Conn#\d+\) when the named results fold, which the engine disposed already \[SF028\] Make a new box for the resource instead of reusing the disposed one\.$/,
      );
      expect(target.link.spare).toBeNull();
      expect([old.disposed, fresh.disposed]).toEqual([1, 0]);
    });

    it("at a transition's end, when two states' result reducers store one box from the work's named result: the end goes to failed", async () => {
      vi.useFakeTimers();
      const crane = defineCrane();
      const hook = defineState<{ conn: DisposableBox<Conn> | null }>()
        .name("hook")
        .signals({ knock })
        .variant("empty", { initial: true })
        .variant("full")
        .build();
      defineFlow(hook.empty, {}, { loaded: (_h, { conn }: { conn: DisposableBox<Conn> }) => hook.full({ conn }) });

      const conn = new Conn();
      const spare = new Conn();
      const target = { crane: { conn: null }, hook: { conn: null } } as unknown as CraneTarget & {
        hook: InstanceOf<typeof hook>;
      };
      applyFlow(
        target,
        [crane, hook],
        (sm) => {
          sm.addTransitionHandler(crane.up, async () =>
            crane.up.results.loaded({ conn: DisposableBox.of(conn), spare: DisposableBox.of(spare) }),
          );
        },
        { logHandlers: [() => {}] },
      );

      const done = dispatch(target, lift()).done();
      await vi.advanceTimersByTimeAsync(0);
      const outcome = await done;

      expect(outcome.error?.message).toMatch(
        /^crane\.conn and hook\.conn hold Box\(Conn#\d+\) when the named results fold; a DisposableBox has one place in the states \[SF027\] Keep each DisposableBox in one prop; move it rather than copy it\.$/,
      );
      expect([String(target.crane), String(target.hook)]).toEqual(["crane.failed(conn=N)", "hook.empty(conn=N)"]);
      expect([conn.disposed, spare.disposed]).toEqual([1, 1]);
    });

    it("at a transition's end with nothing to fold, when the temp step's named result folded over the box next holds again: the end is refused and goes to failed", () => {
      const swing = defineSignal("swing");
      const jib = defineState<{ conn: DisposableBox<Conn> | null }>()
        .name("jib")
        .signals({ swing })
        .variant("idle", { initial: true })
        .variant("swinging", { results: { swapped: (data) => data as DisposableBox<Conn> } })
        .variant("out")
        .variant("failed")
        .build();

      // Temp keeps the box idle holds and next holds it again, which the plan accepts; failed holds none.
      defineFlow(jib.idle, {
        swing: (s) => StateResult.transition(jib.out(s), jib.swinging(s), jib.failed({ conn: null })),
      });
      defineFlow(jib.swinging, {}, { swapped: (s, conn) => ({ ...s, conn }) });

      const held = new Conn();
      const swapped = new Conn();
      const target = { jib: { conn: DisposableBox.of(held) } } as unknown as { jib: InstanceOf<typeof jib> };
      applyFlow(
        target,
        [jib],
        (sm) => {
          // The temp step swaps the box out, so the temp's commit disposes the one next holds.
          sm.addEnterHandler(jib.swinging, () => jib.swinging.results.swapped(DisposableBox.of(swapped)));
        },
        { logHandlers: [() => {}] },
      );

      // out is not asynchronous, so the transition has no work and its end runs inside the call.
      const result = dispatch(target, swing());

      expect(result.error?.message).toMatch(
        /^jib\.conn holds Box\(Conn#\d+\) at the end of the transition, which the engine disposed already \[SF028\] Make a new box for the resource instead of reusing the disposed one\.$/,
      );
      expect(String(target.jib)).toBe("jib.failed(conn=N)");
      expect([held.disposed, swapped.disposed]).toEqual([1, 1]);
    });
  });

  describe("the fold of a step's named results is accepted when each box keeps one place", () => {
    it.each<[string, (s: InstanceOf<Link>) => Partial<LinkProps>, keyof LinkProps]>([
      ["a fold that keeps the box where its node holds it", (s) => ({ conn: s.conn }), "conn"],
      ["a fold that moves the box to another prop of its node", (s) => ({ conn: null, spare: s.conn }), "spare"],
    ])("%s", (_what, data, place) => {
      const link = defineLink();
      const conn = new Conn();
      const target = makeLink(link, null, (sm) => {
        sm.addEnterHandler(link.up, (s) => link.up.results.connected(data(s)));
      });

      expect(dispatch(target, attach({ conn: DisposableBox.of(conn) })).kind).toBe(ResultKind.OK);

      expect(target.link[place]?.deref()).toBe(conn);
      expect(conn.disposed).toBe(0);
    });
  });

  describe("the plan accepts, and nothing is disposed", () => {
    it("a box moved into a nested state, to a key of an Items, to another key, to another state, and to another prop of its node", () => {
      const made = defineDock();
      const conn = new Conn();
      const target = makeDock(made, DisposableBox.of(conn), () => {});

      for (const hop of ["into the bay", "to berth a", "to berth b", "to the yard"]) {
        expect(dispatch(target, shift()).kind, hop).toBe(ResultKind.OK);
      }

      expect(target.dock.berths.get("b")?.conn).toBeNull();
      expect(target.yard.conn?.deref()).toBe(conn);
      expect(conn.disposed).toBe(0);

      const link = defineLink();
      const kept = new Conn();
      const linked = makeLink(link, null);
      dispatch(linked, attach({ conn: DisposableBox.of(kept) }));

      expect(dispatch(linked, swap()).kind).toBe(ResultKind.OK);
      expect(linked.link.spare?.deref()).toBe(kept);
      expect(kept.disposed).toBe(0);
    });

    it("a value wrapped anew in place of its box", () => {
      const link = defineLink();
      const conn = new Conn();
      const target = makeLink(link, null);
      dispatch(target, attach({ conn: DisposableBox.of(conn) }));
      const old = target.link.conn;

      expect(dispatch(target, rewrap({ conn })).kind).toBe(ResultKind.OK);

      expect(target.link.conn).not.toBe(old);
      expect(target.link.conn?.deref()).toBe(conn);
      expect(conn.disposed).toBe(0);
    });

    it("a declared transition whose temp keeps the box the committed states hold, through to its next", () => {
      const crane = defineCrane();
      const conn = new Conn();
      const target = makeCrane(crane, DisposableBox.of(conn));

      // No transition handler: the end runs inside the call.
      expect(dispatch(target, lift()).kind).toBe(ResultKind.OK);

      expect(String(target.crane)).toMatch(/^crane\.up/);
      expect(target.crane.conn?.deref()).toBe(conn);
      expect(conn.disposed).toBe(0);
    });
  });

  it("after a commit, a box the committed states no longer hold is disposed at once, after every handler of the step, its commit delegates and the commit handlers included", () => {
    const link = defineLink();
    const old = new Conn();
    const fresh = new Conn();

    const seen: number[] = [];
    const target = makeLink(link, DisposableBox.of(old), (sm) => {
      sm.addEnterHandler(link.up, () => {
        seen.push(old.disposed);
        return HandlerResult.ok().onCommit(() => seen.push(old.disposed));
      });
      sm.addCommitHandler(link.up, () => {
        seen.push(old.disposed);
      });
    });

    expect(dispatch(target, attach({ conn: DisposableBox.of(fresh) })).kind).toBe(ResultKind.OK);

    expect(seen).toEqual([0, 0, 0]);
    expect(old.disposed).toBe(1);
    expect(fresh.disposed).toBe(0);
  });

  it("a box the initial states hold under two props is disposed once when a step drops both", () => {
    const drop = defineSignal("drop");
    const twin = defineState<{ a: DisposableBox<Conn> | null; b: DisposableBox<Conn> | null }>()
      .name("twin")
      .signals({ drop })
      .variant("only", { initial: true })
      .build();
    defineFlow(twin.only, { drop: () => ({ a: null, b: null }) });

    const conn = new Conn();
    const box = DisposableBox.of(conn);
    const target = { twin: { a: box, b: box } };
    applyFlow(target, [twin], () => {}, { logHandlers: [() => {}] });

    dispatch(target, drop());

    expect(conn.disposed).toBe(1);
  });

  it("a box that a reducer placed from a payload in a step a handler refuses is disposed: the flow owns it once a reducer placed it", () => {
    const link = defineLink();
    const conn = new Conn();
    const target = makeLink(link, null, (sm) => {
      sm.addEnterHandler(link.up, () => HandlerResult.rejected("no route"));
    });

    expect(dispatch(target, attach({ conn: DisposableBox.of(conn) })).message).toBe("no route");

    expect(String(target.link)).toMatch(/^link\.down/);
    expect(conn.disposed).toBe(1);
  });

  it("an enter handler's named result replaces a box: the old one is disposed after the commit only", () => {
    const link = defineLink();
    const old = new Conn();
    const fresh = new Conn();
    const seen: number[] = [];
    const target = makeLink(link, DisposableBox.of(old), (sm) => {
      sm.addEnterHandler(link.up, () => link.up.results.connected({ conn: DisposableBox.of(fresh) }));
      sm.addEnterHandler(link.up, () => {
        seen.push(old.disposed);
        return HandlerResult.ok();
      });
    });

    expect(dispatch(target, connect()).kind).toBe(ResultKind.OK);

    expect(target.link.conn?.deref()).toBe(fresh);
    expect(seen).toEqual([0]);
    expect(old.disposed).toBe(1);
    expect(fresh.disposed).toBe(0);
  });

  describe("a box a reducer placed, which a named result of the same step folds over, is disposed", () => {
    it("after the commit", () => {
      const link = defineLink();
      const placed = new Conn();
      const opened = new Conn();
      const target = makeLink(link, null, (sm) => {
        sm.addEnterHandler(link.up, () => link.up.results.opened(DisposableBox.of(opened)));
      });

      expect(dispatch(target, attach({ conn: DisposableBox.of(placed) })).kind).toBe(ResultKind.OK);

      expect(target.link.conn?.deref()).toBe(opened);
      expect([placed.disposed, opened.disposed]).toEqual([1, 0]);
    });

    it("when a later round of the step refuses", () => {
      const link = defineLink();
      const knock = defineSignal("knock");

      // A gate, another state, opens when the link's result opened folds; its open refuses, in the step's second round.
      const gate = defineState<{ open: boolean }>()
        .name("gate")
        .signals({ knock })
        .variant("shut", { initial: true })
        .variant("open")
        .build();
      defineFlow(gate.shut, {}, { opened: () => gate.open({ open: true }) });

      const placed = new Conn();
      const opened = new Conn();
      const target = { link: { conn: null, spare: null }, gate: { open: false } } as unknown as LinkTarget & {
        gate: InstanceOf<typeof gate>;
      };
      applyFlow(
        target,
        [link, gate],
        (sm) => {
          sm.addEnterHandler(link.up, () => link.up.results.opened(DisposableBox.of(opened)));
          sm.addEnterHandler(gate.open, () => HandlerResult.rejected("gate stuck"));
        },
        { logHandlers: [() => {}] },
      );

      expect(dispatch(target, attach({ conn: DisposableBox.of(placed) })).message).toBe("gate stuck");

      expect(String(target.link)).toMatch(/^link\.down/);
      expect([placed.disposed, opened.disposed]).toEqual([1, 1]);
    });

    it("by a later round, after the commit: another state's result reducer placed it in an earlier round", () => {
      const link = defineLink();
      const knock = defineSignal("knock");
      const first = new Conn();
      const second = new Conn();

      // A gate, another state, answers the link's result opened with a box of its own; its open's named result
      // swapped replaces that box in the step's second round.
      const gate = defineState<{ conn: DisposableBox<Conn> | null }>()
        .name("gate")
        .signals({ knock })
        .variant("shut", { initial: true })
        .variant("open", { results: { swapped: (data) => data as DisposableBox<Conn> } })
        .build();
      defineFlow(gate.shut, {}, { opened: () => gate.open({ conn: DisposableBox.of(first) }) });
      defineFlow(gate.open, {}, { swapped: (s, conn) => ({ ...s, conn }) });

      const target = { link: { conn: null, spare: null }, gate: { conn: null } } as unknown as LinkTarget & {
        gate: InstanceOf<typeof gate>;
      };
      applyFlow(
        target,
        [link, gate],
        (sm) => {
          sm.addEnterHandler(link.up, () => link.up.results.opened(DisposableBox.of(new Conn())));
          sm.addEnterHandler(gate.open, () => gate.open.results.swapped(DisposableBox.of(second)));
        },
        { logHandlers: [() => {}] },
      );

      expect(dispatch(target, attach({ conn: DisposableBox.of(new Conn()) })).kind).toBe(ResultKind.OK);

      expect(target.gate.conn?.deref()).toBe(second);
      expect([first.disposed, second.disposed]).toEqual([1, 0]);
    });

    it("at a transition's end, after the end's commit", async () => {
      const crane = defineCrane();
      const placed = new Conn();
      const loaded = new Conn();
      const target = makeCrane(crane, null, (sm) => {
        sm.addTransitionHandler(crane.up, async () =>
          crane.up.results.loaded({ conn: DisposableBox.of(loaded), spare: DisposableBox.of(new Conn()) }),
        );
      });

      expect((await dispatch(target, hoist({ conn: DisposableBox.of(placed) })).done()).kind).toBe(ResultKind.OK);

      expect(target.crane.conn?.deref()).toBe(loaded);
      expect([placed.disposed, loaded.disposed]).toEqual([1, 0]);
    });
  });

  // A work that never settles, so the timeout, an accepted abort or disposeFlow ends the transition.
  const hang = (): Promise<HandlerResult> => new Promise<HandlerResult>(() => {});

  it.each<[string, () => Promise<HandlerResult>, (target: CraneTarget) => void]>([
    ["the work refused", () => Promise.resolve(HandlerResult.rejected("jammed")), () => {}],
    ["the end step refused", () => Promise.resolve(HandlerResult.ok()), () => {}],
    ["the timeout", hang, () => {}],
    ["an accepted abort", hang, (target) => dispatch(target, stop(), { abort: true })],
    ["disposeFlow", hang, (target) => disposeFlow(target)],
  ])("a box a reducer placed in a transition's next is disposed when the end does not commit: %s", async (_ending, work, meanwhile) => {
    vi.useFakeTimers();
    const crane = defineCrane();
    const placed = new Conn();
    const target = makeCrane(crane, null, (sm) => {
      sm.addTransitionHandler(crane.up, work);

      // Runs only where the end step runs.
      sm.addEnterHandler(crane.up, () => HandlerResult.rejected("no room"));
    });

    const done = dispatch(target, hoist({ conn: DisposableBox.of(placed) })).done();
    await vi.advanceTimersByTimeAsync(0);
    meanwhile(target);
    await vi.advanceTimersByTimeAsync(500);
    await done;

    expect(placed.disposed).toBe(1);
  });

  it("a box a reducer placed in a transition's next is disposed once the failed step committed, when the temp step is refused", () => {
    const crane = defineCrane();
    const placed = new Conn();
    const seen: number[] = [];
    const target = makeCrane(crane, null, (sm) => {
      sm.addEnterHandler(crane.lifting, () => HandlerResult.rejected("no hook"));
      sm.addCommitHandler(crane.failed, () => {
        seen.push(placed.disposed);
      });
    });

    expect(dispatch(target, hoist({ conn: DisposableBox.of(placed) })).message).toBe("no hook");

    expect(String(target.crane)).toMatch(/^crane\.failed/);
    expect(seen).toEqual([0]);
    expect(placed.disposed).toBe(1);
  });

  describe("a refused step's boxes go with those of the step into failed after it", () => {
    type SocketProps = { conn: DisposableBox<Conn> | null; meter: DisposableBox<Conn> | null };
    type Plugged = { conn: DisposableBox<Conn>; meter: DisposableBox<Conn> };

    const plug = defineSignal<Plugged>("plug");
    const wire = defineSignal<Plugged>("wire");
    const power = defineSignal("power");
    const retry = defineSignal("retry");

    /**
     * A socket. From empty, plug answers live with the payload's conn and meter, and dead, its failed, with the conn
     * only; wire declares the same as a transition through wiring, which holds neither. power declares a transition to
     * powered, an asynchronous variant, through wiring, where plug answers as from empty, so with { abort: true } it
     * aborts that transition. From dead, retry goes live with the props as they are.
     */
    function defineSocket() {
      const socket = defineState<SocketProps>()
        .name("socket")
        .signals({ plug, wire, power, retry })
        .variant("empty", { initial: true })
        .variant("wiring", { transitional: true })
        .variant("powered", { async: true })
        .variant("live")
        .variant("dead")
        .build();

      const plugIn = (_s: SocketProps, { conn, meter }: Plugged) =>
        StateResult.ok(socket.live({ conn, meter }), socket.dead({ conn, meter: null }));
      defineFlow(socket.empty, {
        plug: plugIn,
        wire: (_s, { conn, meter }) =>
          StateResult.transition(
            socket.live({ conn, meter }),
            socket.wiring({ conn: null, meter: null }),
            socket.dead({ conn, meter: null }),
          ),
        power: (s) => StateResult.transition(socket.powered(s), socket.wiring(s), socket.dead(s)),
      });
      defineFlow(socket.wiring, { plug: plugIn });
      defineFlow(socket.dead, { retry: (s) => socket.live(s) });

      return socket;
    }
    type SocketTarget = { socket: InstanceOf<ReturnType<typeof defineSocket>> };

    it.each<[string, (target: SocketTarget, payload: Plugged) => Promise<Result>]>([
      [
        "a dispatch's refused step and its step into failed",
        async (target, payload) => dispatch(target, plug(payload)),
      ],
      ["a transition's refused end and its failed end", (target, payload) => dispatch(target, wire(payload)).done()],
      [
        "an accepted abort's refused step and its step into failed",
        async (target, payload) => {
          void dispatch(target, power()).done();
          await vi.advanceTimersByTimeAsync(0);
          const aborting = dispatch(target, plug(payload), { abort: true }).done();

          // The work never settles, so the abort waits out the transition's timeout.
          await vi.advanceTimersByTimeAsync(500);
          return aborting;
        },
      ],
    ])("%s: the failed commits the conn both hold, which stays, and the meter only the refused step held is disposed once, after the failed step's commit delegates and commit handlers", async (_shape, run) => {
      vi.useFakeTimers();
      const socket = defineSocket();
      const conn = new Conn();
      const meter = new Conn();

      let refuse = true;
      const seen: number[] = [];
      const target = { socket: { conn: null, meter: null } } as unknown as SocketTarget;
      applyFlow(
        target,
        [socket],
        (sm) => {
          sm.addTransitionHandler(socket.powered, hang);
          sm.addEnterHandler(socket.live, () => (refuse ? HandlerResult.rejected("no power") : HandlerResult.ok()));
          sm.addEnterHandler(socket.dead, () => HandlerResult.ok().onCommit(() => seen.push(meter.disposed)));
          sm.addCommitHandler(socket.dead, () => {
            seen.push(meter.disposed);
          });
        },
        { logHandlers: [() => {}] },
      );

      const result = await run(target, { conn: DisposableBox.of(conn), meter: DisposableBox.of(meter) });

      expect(String(result)).toBe("Rejected: no power");
      expect(String(target.socket)).toMatch(/^socket\.dead\(conn=Box\(Conn#\d+\) meter=N\)$/);
      expect(seen).toEqual([0, 0]);
      expect([conn.disposed, meter.disposed]).toEqual([0, 1]);

      // A later dispatch that keeps the conn is accepted: the engine never disposed it.
      refuse = false;
      expect(dispatch(target, retry()).kind).toBe(ResultKind.OK);
      expect(target.socket.conn?.deref()).toBe(conn);
      expect(conn.disposed).toBe(0);
    });
  });

  it("when a step does not commit, the boxes it planned and those its named results carry are disposed, a result's data that is itself a box included, unless a node of the committed states holds them", () => {
    const link = defineLink();
    const { bay, dock, yard } = defineDock();
    const before = new Conn();
    const placed = new Conn();
    const made = new Conn();
    const opened = new Conn();
    const elsewhere = new Conn();

    // The link holds `before`; the dock, another state, holds `elsewhere`.
    const parked = DisposableBox.of(elsewhere);
    const target = {
      link: { conn: DisposableBox.of(before), spare: null },
      dock: { conn: parked, bay: bay.only({ conn: null }), berths: bay.items() },
      yard: { conn: null },
    } as unknown as LinkTarget & DockTarget;
    applyFlow(
      target,
      [link, dock, yard],
      (sm) => {
        // s.conn is the box the reducer placed from the payload; prev.conn the one the node held before the step.
        sm.addEnterHandler(link.up, (s) => link.up.results.connected({ conn: s.conn, spare: DisposableBox.of(made) }));
        sm.addEnterHandler(link.up, (_s, _snapshot, prev) => link.up.results.connected({ spare: prev?.conn ?? null }));
        sm.addEnterHandler(link.up, () => link.up.results.opened(DisposableBox.of(opened)));
        sm.addEnterHandler(link.up, () => link.up.results.connected({ spare: parked }));
        sm.addEnterHandler(link.up, () => HandlerResult.rejected("no route"));
      },
      { logHandlers: [() => {}] },
    );

    expect(dispatch(target, attach({ conn: DisposableBox.of(placed) })).message).toBe("no route");

    expect([before, placed, made, opened, elsewhere].map((conn) => conn.disposed)).toEqual([0, 1, 1, 1, 0]);
  });

  describe("a transition handler's named result", () => {
    it("when the end commits, the box its result reducer places stays, and the one it leaves out is disposed after the end's commit", async () => {
      const crane = defineCrane();
      const placed = new Conn();
      const left = new Conn();
      const seen: number[] = [];
      const target = makeCrane(crane, null, (sm) => {
        sm.addTransitionHandler(crane.up, async () =>
          crane.up.results.loaded({ conn: DisposableBox.of(placed), spare: DisposableBox.of(left) }),
        );
        sm.addCommitHandler(crane.up, () => {
          seen.push(left.disposed);
        });
      });

      expect((await dispatch(target, lift()).done()).kind).toBe(ResultKind.OK);

      expect(target.crane.conn?.deref()).toBe(placed);
      expect(seen).toEqual([0]);
      expect([placed.disposed, left.disposed]).toEqual([0, 1]);
    });

    it("when the end does not commit, its boxes are disposed with no handler listening: another work refused, the timeout, an accepted abort, disposeFlow, or a result that settles after the end", async () => {
      vi.useFakeTimers();
      for (const ending of ["refused", "timeout", "aborted", "disposed", "late"] as const) {
        const crane = defineCrane();
        const conn = new Conn();
        const spare = new Conn();

        // The first work settles with the boxes at once; in "late", once the second has refused.
        let settle: () => void = () => {};
        const target = makeCrane(crane, null, (sm) => {
          sm.addTransitionHandler(crane.up, () => {
            const result = crane.up.results.loaded({ conn: DisposableBox.of(conn), spare: DisposableBox.of(spare) });
            if (ending !== "late") {
              return Promise.resolve(result);
            }
            return new Promise((resolve) => {
              settle = () => resolve(result);
            });
          });
          sm.addTransitionHandler(crane.up, () =>
            ending === "refused" || ending === "late"
              ? Promise.resolve(HandlerResult.rejected("jammed"))
              : new Promise<HandlerResult>(() => {}),
          );
        });

        const done = dispatch(target, lift()).done();
        await vi.advanceTimersByTimeAsync(0);
        if (ending === "aborted") {
          dispatch(target, stop(), { abort: true });
        }
        if (ending === "disposed") {
          disposeFlow(target);
        }
        await vi.advanceTimersByTimeAsync(500);
        await done;
        settle();
        await vi.advanceTimersByTimeAsync(0);

        expect([conn.disposed, spare.disposed], ending).toEqual([1, 1]);
      }
    });
  });

  it("a node's props are read as values: a getter the parser built is not called, at plan time, after a commit or at disposeFlow", () => {
    let reads = 0;
    const gauge = defineState<{ conn: DisposableBox<Resource> | null; readonly level: number }>()
      .name("gauge")
      .signals({ swap })
      .variant("only", { initial: true })
      .parser((p) => ({
        conn: (p as { conn: DisposableBox<Resource> | null }).conn,
        get level(): number {
          reads += 1;
          return 0;
        },
      }))
      .stringRepr(() => "gauge")
      .build();

    // The reducer builds its next itself, so the reads of its spread and of the build are counted before the plan's.
    let readsBuilt = -1;
    defineFlow(gauge.only, {
      swap: (s) => {
        const next = gauge.only({ ...s, conn: null });
        readsBuilt = reads;
        return next;
      },
    });

    const conn = new Conn();
    let readsAtCommit = -1;

    // The parser derives level, so the initial props leave it out.
    const target = { gauge: { conn: DisposableBox.of(conn) } } as unknown as { gauge: InstanceOf<typeof gauge> };
    applyFlow(
      target,
      [gauge],
      (sm) => {
        sm.addUpdateHandler(gauge.only, () =>
          HandlerResult.ok().onCommit(() => {
            readsAtCommit = reads;
          }),
        );
      },
      { logHandlers: [() => {}] },
    );

    dispatch(target, swap());
    expect(conn.disposed).toBe(1);
    expect(readsAtCommit).toBe(readsBuilt);
    expect(reads).toBe(readsBuilt);

    disposeFlow(target);
    expect(reads).toBe(readsBuilt);
  });

  it("disposeFlow disposes every box the final states hold, a nested state's too, each once", () => {
    const leaf = defineState<{ conn: DisposableBox<Conn> }>().name("leaf").variant("only", { initial: true }).build();
    const root = defineState<{ conn: DisposableBox<Conn>; leaf: InstanceOf<typeof leaf> }>()
      .name("root")
      .variant("only", { initial: true })
      .build();

    const outer = new Conn();
    const inner = new Conn();
    const target = { root: { conn: DisposableBox.of(outer), leaf: leaf.only({ conn: DisposableBox.of(inner) }) } };
    applyFlow(target, [root], () => {}, { logHandlers: [() => {}] });

    disposeFlow(target);

    expect([outer.disposed, inner.disposed]).toEqual([1, 1]);
  });

  it("an async dispose is called and not awaited; its rejection, like a sync dispose's throw, goes to console.error", async () => {
    const link = defineLink();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    let calls = 0;
    let reject: (reason: Error) => void = () => {};
    const slow = {
      [Symbol.asyncDispose]: (): Promise<void> => {
        calls += 1;
        return new Promise<void>((_resolve, r) => {
          reject = r;
        });
      },
    };
    const broken = {
      [Symbol.dispose]: (): void => {
        throw new Error("stuck");
      },
    };
    const target = makeLink(link, DisposableBox.of(slow));

    dispatch(target, attach({ conn: DisposableBox.of(broken) }));
    expect(calls).toBe(1);
    expect(error).not.toHaveBeenCalled();

    reject(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[SF\/Object\] the dispose of Box\(Object#\d+\) failed:$/),
      new Error("late"),
    );

    disposeFlow(target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\[SF\/Object\] the dispose of Box\(Object#\d+\) failed:$/),
      new Error("stuck"),
    );
  });
});
