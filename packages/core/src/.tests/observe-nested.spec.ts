import { describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  type FlowChange,
  type InstanceOf,
  type Items,
  observe,
  type StateFlowLogEntry,
  subscribeFlow,
} from "..";

/**
 * Observation of nested states: observe() takes a variant of a state held below the target's top-level states, and
 * is told of every node of that state that changes into it, with the node's path; subscribeFlow delivers a FlowChange
 * per changed nested node, with its path, after its top-level state's change. Every definition with reducers is made
 * inside its test, because defineFlow binds once per variant.
 */
describe("observe and subscribeFlow on nested states", () => {
  // Observers, subscribers and log entries are delivered after the dispatch returns.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("a nested state's variant: each change of the node into it tells the observer, with the committed instance and the node's path; the compare gets the node's instances before and after, and the entry names the node by its path", async () => {
    const bump = defineSignal("bump");
    const part = defineState<{ n: number }>()
      .name("part")
      .signals({ bump })
      .variant("idle", { initial: true })
      .variant("on")
      .build();
    defineFlow(part.idle, { bump: (p) => part.on({ n: p.n + 1 }) });
    defineFlow(part.on, { bump: (p) => ({ n: p.n + 1 }) });
    const holder = defineState<{ part: InstanceOf<typeof part> }>()
      .name("holder")
      .variant("x", { initial: true })
      .build();
    const entries: StateFlowLogEntry[] = [];
    const target = { holder: { part: part.idle({ n: 0 }) } };
    applyFlow(target, [holder], () => {}, { logHandlers: [(entry) => entries.push(entry)] });
    const compared: string[] = [];
    const told: Array<[unknown, string]> = [];
    using _part = observe(
      target,
      [part.on],
      function seen(state, path) {
        told.push([state, path]);
      },
      (a, b) => {
        compared.push(`${String(a)} -> ${String(b)}`);
        return true;
      },
    );
    // The holder is rebuilt around its changed part; its observer gets the top-level state's name as the path.
    const holders: string[] = [];
    using _holder = observe(target, [holder.x], (_state, path) => {
      holders.push(path);
    });

    dispatch(target, bump());
    const first = target.holder.part;
    dispatch(target, bump());
    await tick();

    expect(compared).toEqual(["part.idle(n=0) -> part.on(n=1)", "part.on(n=1) -> part.on(n=2)"]);
    expect(told).toEqual([
      [first, "holder.part"],
      [target.holder.part, "holder.part"],
    ]);
    expect(holders).toEqual(["holder", "holder"]);
    expect(entries.map((entry) => entry.observers.filter((o) => o.observerName === "seen"))).toEqual([
      [{ stateName: "holder.part", observerName: "seen", needObserve: true }],
      [{ stateName: "holder.part", observerName: "seen", needObserve: true }],
    ]);
  });

  it("the elements of a keyed Items: each element that changes into the variant tells the observer, with its path; one that appears in it has no instance before, so its callback runs without the compare; one that leaves tells no one", async () => {
    const wake = defineSignal("wake");
    const add = defineSignal<{ id: string }>("add");
    const drop = defineSignal<{ id: string }>("drop");
    const cam = defineState<{ id: string }>()
      .name("cam")
      .signals({ wake })
      .variant("off", { initial: true })
      .variant("live")
      .build();
    defineFlow(cam.off, { wake: (c) => cam.live(c) });
    const rack = defineState<{ cams: Items<typeof cam> }>()
      .name("rack")
      .signals({ add, drop })
      .variant("up", { initial: true })
      .build();
    defineFlow(rack.up, {
      add: (r, { id }) => ({ cams: r.cams.with(cam.live({ id })) }),
      drop: (r, { id }) => ({ cams: r.cams.without(id) }),
    });
    const entries: StateFlowLogEntry[] = [];
    const target = {
      rack: {
        cams: cam
          .items({ key: (c) => c.id })
          .with(cam.off({ id: "a" }))
          .with(cam.off({ id: "b" })),
      },
    };
    applyFlow(target, [rack], () => {}, { logHandlers: [(entry) => entries.push(entry)] });
    const compared: string[] = [];
    const told: string[] = [];
    using _observer = observe(
      target,
      [cam.live],
      function live(state, path) {
        told.push(`${path}: ${String(state)}`);
      },
      (a, b) => {
        compared.push(`${String(a)} -> ${String(b)}`);
        return true;
      },
    );

    dispatch(target, wake());
    dispatch(target, add({ id: "c" }));
    dispatch(target, drop({ id: "a" }));
    await tick();

    expect(compared).toEqual(["cam.off(id=a) -> cam.live(id=a)", "cam.off(id=b) -> cam.live(id=b)"]);
    expect(told).toEqual([
      "rack.cams[a]: cam.live(id=a)",
      "rack.cams[b]: cam.live(id=b)",
      "rack.cams[c]: cam.live(id=c)",
    ]);
    expect(entries.map((entry) => entry.observers)).toEqual([
      [
        { stateName: "rack.cams[a]", observerName: "live", needObserve: true },
        { stateName: "rack.cams[b]", observerName: "live", needObserve: true },
      ],
      [{ stateName: "rack.cams[c]", observerName: "live", needObserve: true }],
      [],
    ]);
  });

  it("subscribeFlow: after a top-level state's change, which has no path, one FlowChange per nested node that changed, named by its own state, with its path, the commit's signal and dispatchOrder; an empty side is undefined, its variant (none)", async () => {
    const add = defineSignal<{ id: string }>("add");
    const drop = defineSignal<{ id: string }>("drop");
    const cam = defineState<{ id: string }>().name("cam").variant("live", { initial: true }).build();
    const rack = defineState<{ cams: Items<typeof cam> }>()
      .name("rack")
      .signals({ add, drop })
      .variant("up", { initial: true })
      .build();
    defineFlow(rack.up, {
      add: (r, { id }) => ({ cams: r.cams.with(cam.live({ id })) }),
      drop: (r, { id }) => ({ cams: r.cams.without(id) }),
    });
    const target = { rack: { cams: cam.items({ key: (c) => c.id }) } };
    applyFlow(target, [rack], () => {});
    const changes: FlowChange[] = [];
    using _sub = subscribeFlow(target, (change) => changes.push(change));

    dispatch(target, add({ id: "a" }));
    const element = target.rack.cams.get("a");
    dispatch(target, drop({ id: "a" }));
    await tick();

    expect(changes.map((c) => [c.stateName, c.path, c.prevVariant, c.nextVariant])).toEqual([
      ["rack", undefined, "up", "up"],
      ["cam", "rack.cams[a]", "(none)", "live"],
      ["rack", undefined, "up", "up"],
      ["cam", "rack.cams[a]", "live", "(none)"],
    ]);
    // A top-level state's change has no path key at all.
    expect(changes.filter((c) => "path" in c)).toEqual([changes[1], changes[3]]);
    expect(changes[1].prev).toBeUndefined();
    expect(changes[1].next).toBe(element);
    expect(changes[3].prev).toBe(element);
    expect(changes[3].next).toBeUndefined();
    expect([changes[1].signal, changes[1].dispatchOrder]).toEqual([changes[0].signal, changes[0].dispatchOrder]);
    expect([changes[3].signal, changes[3].dispatchOrder]).toEqual([changes[2].signal, changes[2].dispatchOrder]);
  });

  it("a position that held another state: the node's observer runs with no compare, and its FlowChange is named by the new state, with the other state's instance as prev", async () => {
    const swap = defineSignal("swap");
    const pin = defineState<{ n: number }>().name("pin").variant("on", { initial: true }).build();
    const peg = defineState<{ n: number }>().name("peg").variant("on", { initial: true }).build();
    type Slot = InstanceOf<typeof pin> | InstanceOf<typeof peg>;
    const board = defineState<{ slot: Slot }>().name("board").signals({ swap }).variant("x", { initial: true }).build();
    defineFlow(board.x, { swap: (b) => ({ slot: peg.on({ n: b.slot.n }) }) });
    const target: { board: { slot: Slot } } = { board: { slot: pin.on({ n: 1 }) } };
    applyFlow(target, [board], () => {});
    const before = target.board.slot;
    const compare = vi.fn(() => true);
    const told: string[] = [];
    using _observer = observe(
      target,
      [peg.on],
      (state, path) => {
        told.push(`${path}: ${String(state)}`);
      },
      compare,
    );
    const changes: FlowChange[] = [];
    using _sub = subscribeFlow(target, (change) => changes.push(change));

    dispatch(target, swap());
    await tick();

    expect(compare).not.toHaveBeenCalled();
    expect(told).toEqual(["board.slot: peg.on(n=1)"]);
    expect(changes.map((c) => [c.stateName, c.path, c.prevVariant, c.nextVariant])).toEqual([
      ["board", undefined, "x", "x"],
      ["peg", "board.slot", "on", "on"],
    ]);
    expect(changes[1].prev).toBe(before);
  });

  it("two definitions that share a name: an observer of one's variant is told only of that definition's nodes", async () => {
    const step = defineSignal("step");
    const a = defineState<{ n: number }>().name("twin").signals({ step }).variant("on", { initial: true }).build();
    const b = defineState<{ n: number }>().name("twin").signals({ step }).variant("on", { initial: true }).build();
    defineFlow(a.on, { step: (s) => ({ n: s.n + 1 }) });
    defineFlow(b.on, { step: (s) => ({ n: s.n + 10 }) });
    const pair = defineState<{ a: InstanceOf<typeof a>; b: InstanceOf<typeof b> }>()
      .name("pair")
      .variant("x", { initial: true })
      .build();
    const target = { pair: { a: a.on({ n: 0 }), b: b.on({ n: 0 }) } };
    applyFlow(target, [pair], () => {});
    const told: string[] = [];
    using _observer = observe(target, [a.on], (state, path) => {
      told.push(`${path}: ${state.n}`);
    });

    dispatch(target, step());
    await tick();

    expect(told).toEqual(["pair.a: 1"]);
  });
});
