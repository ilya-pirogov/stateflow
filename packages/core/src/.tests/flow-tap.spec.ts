import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addFlowTap,
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  type FlowTap,
  HandlerResult,
  lock,
  ResultKind,
  type StateInstance,
  type StateManager,
  StateResult,
} from "..";

/**
 * A tap is told, inside the step, the signal of each dispatch that reaches its reducers and what every handler call
 * gave. Taps are a set that every flow tells; addFlowTap returns the function that removes one. A tap that throws is
 * reported on console.error and neither the step nor the other taps stop.
 */
describe("addFlowTap", () => {
  const toggle = defineSignal("toggle");
  const bump = defineSignal("bump");
  const start = defineSignal("start");
  const slow = defineSignal("slow");

  const light = defineState<{ n: number }>()
    .name("light")
    .signals({ toggle, bump, start, slow })
    .variant("off", { initial: true })
    .variant("on")
    .variant("busy")
    .variant("ready", { async: true })
    .variant("failed")
    .build();
  defineFlow(light.off, {
    toggle: (s) => light.on({ n: s.n + 1 }),
    start: (s) => StateResult.transition(light.ready({ n: s.n + 1 }), light.busy(s), light.failed(s)),
    slow: (s) => StateResult.transition(light.ready({ n: s.n + 1 }), light.busy(s), light.failed(s), { timeoutMs: 1 }),
  });
  defineFlow(light.on, { bump: (s) => ({ n: s.n + 1 }) });
  // An abort of the transition, sent while busy, goes back to off.
  defineFlow(light.busy, { bump: (s) => light.off(s), toggle: (s) => light.on(s) });
  defineFlow(light.ready, { toggle: (s) => light.on(s) });

  /** A work that settles with what `settle` is given. */
  function deferredWork(): { work: () => Promise<HandlerResult>; settle: (result: HandlerResult) => void } {
    let settle: (result: HandlerResult) => void = () => {};
    const promise = new Promise<HandlerResult>((resolve) => {
      settle = resolve;
    });
    return { work: () => promise, settle: (result) => settle(result) };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  type Target = { light: StateInstance<{ n: number }> };

  function make(init: (sm: StateManager) => void = () => {}): Target {
    const target = { light: { n: 0 } };
    applyFlow(target, [light], init);
    return target as unknown as Target;
  }

  /** A tap that records what it is told as text, with the state the target holds at that moment. */
  function recording(target: Target, told: string[]): FlowTap {
    return {
      dispatched: (t, signal) => {
        if (t === target) {
          told.push(`${signal[Symbol.toStringTag]} at ${String(target.light)}`);
        }
      },
      handled: (t, kind, call, result) => {
        if (t === target) {
          told.push(`${kind} ${call.name} ${result.kind} at ${String(target.light)}`);
        }
      },
      ended: () => {},
    };
  }

  const removers: (() => void)[] = [];
  afterEach(() => {
    for (const remove of removers.splice(0)) {
      remove();
    }
    vi.restoreAllMocks();
  });

  it("tells the signal and each handler's result, inside the step, before the commit", () => {
    const target = make((sm) => sm.addEnterHandler(light.on, () => HandlerResult.ok()));
    const told: string[] = [];
    removers.push(addFlowTap(recording(target, told)));

    dispatch(target, toggle());

    expect(told).toEqual(["toggle at light.off(n=0)", `enter light ${ResultKind.OK} at light.off(n=0)`]);
    expect(String(target.light)).toBe("light.on(n=1)");
  });

  it("tells nothing more to a tap once it is removed", () => {
    const target = make();
    const told: string[] = [];
    const remove = addFlowTap(recording(target, told));
    dispatch(target, toggle());
    remove();
    dispatch(target, bump());

    expect(told).toEqual(["toggle at light.off(n=0)"]);
  });

  it("reports a tap's throw on console.error, and the step and the other taps go on", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = make((sm) => sm.addEnterHandler(light.on, () => HandlerResult.ok()));
    const boom = new Error("boom");
    const thrower: FlowTap = {
      dispatched: () => {
        throw boom;
      },
      handled: () => {
        throw boom;
      },
      ended: () => {},
    };
    const told: string[] = [];
    removers.push(addFlowTap(thrower), addFlowTap(recording(target, told)));

    const result = dispatch(target, toggle());

    expect(result.kind).toBe(ResultKind.OK);
    expect(String(target.light)).toBe("light.on(n=1)");
    expect(told).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("[SF/Object] a tap threw:", boom);
  });

  it("tells a handler's refusal, and a dispatch the reducers ignore", () => {
    const target = make((sm) => sm.addEnterHandler(light.on, () => HandlerResult.rejected("no")));
    const told: string[] = [];
    removers.push(addFlowTap(recording(target, told)));

    dispatch(target, toggle());
    dispatch(target, bump());

    expect(told).toEqual([
      "toggle at light.off(n=0)",
      `enter light ${ResultKind.Rejected} at light.off(n=0)`,
      "bump at light.off(n=0)",
    ]);
  });

  it("tells a muted dispatch", () => {
    const target = make();
    const told: string[] = [];
    removers.push(addFlowTap(recording(target, told)));

    dispatch(target, toggle(), { mute: true });

    expect(told).toEqual(["toggle at light.off(n=0)"]);
  });

  it("tells a transition handler's result when its work settles, before the end commits", async () => {
    const target = make((sm) => sm.addTransitionHandler(light.ready, async () => HandlerResult.ok()));
    const told: string[] = [];
    removers.push(addFlowTap(recording(target, told)));

    dispatch(target, start());
    await tick();

    expect(told).toEqual(["start at light.off(n=0)", `transition light ${ResultKind.OK} at light.busy(n=0)`]);
    expect(String(target.light)).toBe("light.ready(n=1)");
  });

  it("tells a send queued behind a transition when it runs, after the transition's end", async () => {
    const { work, settle } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(light.ready, work));
    const told: string[] = [];
    removers.push(addFlowTap(recording(target, told)));
    await using send = await lock(target);

    send(start());
    send(toggle());
    expect(told).toEqual(["start at light.off(n=0)"]);
    settle(HandlerResult.ok());
    await tick();

    expect(told).toEqual([
      "start at light.off(n=0)",
      `transition light ${ResultKind.OK} at light.busy(n=0)`,
      "toggle at light.ready(n=1)",
    ]);
  });

  it("tells an abort when it is sent, then the work's result, which the abort drops", async () => {
    const { work, settle } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(light.ready, work));
    const told: string[] = [];
    removers.push(addFlowTap(recording(target, told)));

    dispatch(target, start());
    dispatch(target, bump(), { abort: true });
    settle(HandlerResult.ok());
    await tick();

    expect(told).toEqual([
      "start at light.off(n=0)",
      "bump at light.busy(n=0)",
      `transition light ${ResultKind.OK} at light.busy(n=0)`,
    ]);
    expect(String(target.light)).toBe("light.off(n=0)");
  });

  it("tells a failed step in order: the signal, the work's refusal, then the failed end's handlers, before it commits", async () => {
    const target = make((sm) => {
      sm.addTransitionHandler(light.ready, async () => HandlerResult.rejected("no"));
      sm.addEnterHandler(light.failed, () => HandlerResult.ok());
    });
    const told: string[] = [];
    removers.push(addFlowTap(recording(target, told)));

    dispatch(target, start());
    await tick();

    expect(told).toEqual([
      "start at light.off(n=0)",
      `transition light ${ResultKind.Rejected} at light.busy(n=0)`,
      `enter light ${ResultKind.OK} at light.busy(n=0)`,
    ]);
    expect(String(target.light)).toBe("light.failed(n=0)");
  });

  it("refuses a dispatch from a tap as from a handler, so no other step runs inside the one it is told of", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = make((sm) => sm.addTransitionHandler(light.ready, deferredWork().work));
    removers.push(
      addFlowTap({
        dispatched: (_t, signal) => {
          if (signal[Symbol.toStringTag] === "toggle") {
            dispatch(target, start());
          }
        },
        handled: () => {},
        ended: () => {},
      }),
    );

    const result = dispatch(target, toggle());

    expect(result.kind).toBe(ResultKind.OK);
    expect(String(target.light)).toBe("light.on(n=1)");
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][1])).toContain("from inside its own dispatch");
  });

  it("tells the taps there were when the telling started, each once, though one re-adds itself or adds another", () => {
    const target = make();
    const told: string[] = [];
    const added: string[] = [];
    let remove = (): void => {};
    const readding: FlowTap = {
      dispatched: (_t, signal) => {
        told.push(signal[Symbol.toStringTag]);
        // Bounded, so that a telling that follows the live set fails here rather than never ending.
        if (told.length < 3) {
          remove();
          remove = addFlowTap(readding);
          removers.push(addFlowTap(recording(target, added)));
        }
      },
      handled: () => {},
      ended: () => {},
    };
    remove = addFlowTap(readding);
    removers.push(() => remove());

    dispatch(target, toggle());

    expect(told).toEqual(["toggle"]);
    expect(added).toEqual([]);
  });

  it("tells a late answer, one that settles after a timeout ended its transition, after the failed end committed", async () => {
    const { work, settle } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(light.ready, work));
    const told: string[] = [];
    removers.push(addFlowTap(recording(target, told)));

    dispatch(target, slow());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(String(target.light)).toBe("light.failed(n=0)");
    settle(HandlerResult.ok());
    await tick();

    expect(told).toEqual(["slow at light.off(n=0)", `transition light ${ResultKind.OK} at light.failed(n=0)`]);
  });

  it("reports a tap's throw when it is told a work's result, and the transition still reaches its end", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = make((sm) => sm.addTransitionHandler(light.ready, async () => HandlerResult.ok()));
    const boom = new Error("boom");
    removers.push(
      addFlowTap({
        dispatched: () => {},
        handled: () => {
          throw boom;
        },
        ended: () => {},
      }),
    );

    const result = dispatch(target, start());

    expect((await result.done()).kind).toBe(ResultKind.OK);
    expect(String(target.light)).toBe("light.ready(n=1)");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[SF/Object] a tap threw:", boom);
  });

  it("refuses a send through the target's lock from a tap, as from a handler", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = make();
    await using send = await lock(target);
    removers.push(
      addFlowTap({
        dispatched: (_t, signal) => {
          if (signal[Symbol.toStringTag] === "toggle") {
            send(bump());
          }
        },
        handled: () => {},
        ended: () => {},
      }),
    );

    const result = send(toggle());

    expect(result.kind).toBe(ResultKind.OK);
    expect(String(target.light)).toBe("light.on(n=1)");
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][1])).toContain("from inside its own dispatch");
  });

  it("refuses a send from a tap told of a queued send while the queue drains, and the queued send still commits", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { work, settle } = deferredWork();
    const target = make((sm) => sm.addTransitionHandler(light.ready, work));
    await using send = await lock(target);
    removers.push(
      addFlowTap({
        dispatched: (_t, signal) => {
          if (signal[Symbol.toStringTag] === "toggle") {
            send(bump());
          }
        },
        handled: () => {},
        ended: () => {},
      }),
    );

    send(start());
    const queued = send(toggle());
    settle(HandlerResult.ok());

    expect((await queued.done()).kind).toBe(ResultKind.OK);
    expect(String(target.light)).toBe("light.on(n=1)");
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][1])).toContain("from inside its own dispatch");
  });
});
