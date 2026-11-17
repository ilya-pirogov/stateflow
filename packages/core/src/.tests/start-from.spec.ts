import { describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  DisposableBox,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  HandlerResult,
  type InstanceOf,
  ResultKind,
  type StateFlowLogEntry,
  StateResult,
  stateVar,
  watch,
} from "..";

/**
 * FlowConfig.start: a flow starts from given instances in place of each state's initial variant. A given instance
 * counts as committed where it was taken, so nothing runs for it.
 */
describe("a flow that starts from a given state", () => {
  const signals = { bump: defineSignal("bump"), stop: defineSignal("stop"), light: defineSignal("light") };
  /** Off lights through starting, the temp of a declared transition that is not marked transitional, into on. */
  const lamp = defineState<{ watts: number }>()
    .name("lamp")
    .signals(signals)
    .variant("off", { initial: true })
    .variant("warming", { transitional: true })
    .variant("starting")
    .variant("on", { async: true })
    .build();
  defineFlow(lamp.off, { light: (s) => StateResult.transition(lamp.on(s), lamp.starting(s), lamp.off(s)) });
  defineFlow(lamp.warming, {});
  defineFlow(lamp.starting, { stop: (s) => lamp.off(s) });
  defineFlow(lamp.on, { bump: (s) => ({ watts: s.watts + 1 }), stop: (s) => lamp.off(s) });

  const rack = defineState<{ lamps: ReturnType<typeof lamp.items> }>()
    .name("rack")
    .variant("up", { initial: true })
    .build();

  type Lamp = InstanceOf<typeof lamp>;

  /** A target whose props would start the lamp off, and which records what it emits. */
  class Target {
    lamp = { watts: 0 } as Lamp;
    readonly emitted: unknown[][] = [];
    emit(...args: unknown[]): void {
      this.emitted.push(args);
    }
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("starts in the given instance, an asynchronous variant included, and runs no enter, transition or commit handler for it; signals reduce from it", () => {
    const target = new Target();
    const given = lamp.on({ watts: 5 });
    const ran = vi.fn(() => HandlerResult.ok());

    applyFlow(
      target,
      [lamp],
      (sm) => {
        sm.addEnterHandler(lamp.on, ran);
        sm.addTransitionHandler(lamp.on, async () => ran());
        sm.addCommitHandler(lamp.on, ran);
      },
      { start: { lamp: given } },
    );

    expect(target.lamp).toBe(given);
    expect(ran).not.toHaveBeenCalled();

    expect(dispatch(target, signals.bump()).kind).toBe(ResultKind.OK);
    expect(String(target.lamp)).toBe("lamp.on(watts=6)");
  });

  it("refuses a given instance in a transitional variant, as it refuses an initial one: no transition is pending", () => {
    expect(() => applyFlow(new Target(), [lamp], () => {}, { start: { lamp: lamp.warming({ watts: 5 }) } })).toThrow(
      "lamp starts in a transitional variant, which commits only as the temp of a declared transition",
    );
  });

  it("an event and a watch compare their first commit with the given state: an event on entering its variant stays silent, and a watch's prev is the given state", async () => {
    const target = new Target();
    const watched = vi.fn();
    const isOn = (s: { lamp: { watts: number } }): boolean => stateVar(s.lamp) === lamp.on;
    applyFlow(target, [lamp], (sm) => sm.defineEvent("lit", (cur, prev) => isOn(cur) && !isOn(prev)), {
      start: { lamp: lamp.on({ watts: 5 }) },
    });
    watch(target, (cur, prev) => cur.lamp.watts !== prev.lamp.watts, watched);

    dispatch(target, signals.bump());
    await tick();

    expect(target.emitted).toEqual([]);
    expect(watched).toHaveBeenCalledTimes(1);
    expect(watched.mock.calls[0].map((s: { lamp: Lamp }) => s.lamp.watts)).toEqual([6, 5]);
  });

  it("a given tree keeps its nested states, which take signals from the first dispatch", () => {
    const target = { rack: { lamps: lamp.items() } };
    const given = rack.up({
      lamps: lamp
        .items()
        .with("a", lamp.on({ watts: 5 }))
        .with("b", lamp.off({ watts: 1 })),
    });

    applyFlow(target, [rack], () => {}, { start: { rack: given } });
    expect(target.rack).toBe(given);

    expect(dispatch(target, signals.stop()).kind).toBe(ResultKind.OK);
    expect(String(target.rack.lamps.get("a"))).toBe("lamp.off(watts=5)");
    expect(target.rack.lamps.get("b")).toBe(given.lamps.get("b"));
  });
  it("starts in a temp not marked transitional with nothing pending: a dispatch reduces at once, and no transition handler runs", () => {
    const target = new Target();
    const ran = vi.fn(async () => HandlerResult.ok());
    applyFlow(target, [lamp], (sm) => sm.addTransitionHandler(lamp.on, ran), {
      start: { lamp: lamp.starting({ watts: 5 }) },
    });

    expect(dispatch(target, signals.stop()).kind).toBe(ResultKind.OK);
    expect(String(target.lamp)).toBe("lamp.off(watts=5)");
    expect(ran).not.toHaveBeenCalled();
  });

  it("checks nothing else: a name that matches no state of the flow is ignored, and an instance of another definition is taken", () => {
    const ignored = new Target();
    applyFlow(ignored, [lamp], () => {}, { start: { lmap: lamp.on({ watts: 5 }) } });
    expect(String(ignored.lamp)).toBe("lamp.off(watts=0)");

    const foreign = new Target();
    const given = rack.up({ lamps: lamp.items() });
    applyFlow(foreign, [lamp], () => {}, { start: { lamp: given } });
    expect(foreign.lamp).toBe(given);
  });

  it("runs the check that two definitions do not declare a result of one name on a given instance too", () => {
    const sw = defineState<{ watts: number }>()
      .name("switch")
      .variant("up", { initial: true, results: { switched: (data) => Boolean(data) } })
      .build();
    const meter = defineState<{ n: number }>()
      .name("meter")
      .variant("read", { initial: true, results: { switched: (data) => Number(data) } })
      .build();
    const target = { lamp: { watts: 0 } as Lamp, meter: { n: 0 } };

    expect(() => applyFlow(target, [lamp, meter], () => {}, { start: { lamp: sw.up({ watts: 5 }) } })).toThrow(
      "switch and meter both declare a result named switched",
    );
  });

  it("writes no log entry for the start; the first dispatch writes the first", async () => {
    const entries: StateFlowLogEntry[] = [];
    const target = new Target();
    applyFlow(target, [lamp], () => {}, {
      start: { lamp: lamp.on({ watts: 5 }) },
      logHandlers: [(entry) => entries.push(entry)],
    });
    await tick();
    expect(entries).toEqual([]);

    dispatch(target, signals.bump());
    await tick();
    expect(entries.map((entry) => entry.signal)).toEqual(["bump{}"]);
  });

  describe("disposable boxes", () => {
    const plug = { unplug: defineSignal("unplug"), touch: defineSignal("touch") };

    /** A resource that counts its disposals. */
    class Conn {
      disposed = 0;
      [Symbol.dispose](): void {
        this.disposed += 1;
      }
    }

    /** A socket holding conn: unplug drops it, touch counts up and keeps it. */
    const socket = defineState<{ conn: DisposableBox<Conn> | null; n: number }>()
      .name("socket")
      .signals(plug)
      .variant("live", { initial: true })
      .build();
    defineFlow(socket.live, { unplug: (s) => ({ ...s, conn: null }), touch: (s) => ({ ...s, n: s.n + 1 }) });

    function makeSocket(given: InstanceOf<typeof socket>): { socket: InstanceOf<typeof socket> } {
      const target = { socket: { conn: null, n: 0 } as unknown as InstanceOf<typeof socket> };
      applyFlow(target, [socket], () => {}, { start: { socket: given }, logHandlers: [() => {}] });
      return target;
    }

    it("disposeFlow disposes the box a given state still holds", () => {
      const conn = new Conn();
      const target = makeSocket(socket.live({ conn: DisposableBox.of(conn), n: 0 }));

      disposeFlow(target);

      expect(conn.disposed).toBe(1);
    });

    it("one box given to two flows: the first to drop it disposes it, the other then refuses a dispatch that keeps it and disposes nothing at disposeFlow", () => {
      const conn = new Conn();
      const given = socket.live({ conn: DisposableBox.of(conn), n: 0 });
      const first = makeSocket(given);
      const second = makeSocket(given);

      dispatch(first, plug.unplug());
      expect(conn.disposed).toBe(1);

      expect(dispatch(second, plug.touch()).error?.message).toMatch(
        /^socket\.conn holds Box\(Conn#\d+\) in next, which the engine disposed already \[SF028\] Make a new box for the resource instead of reusing the disposed one\.$/,
      );
      expect(second.socket).toBe(given);

      disposeFlow(second);
      expect(conn.disposed).toBe(1);
    });
  });
});
