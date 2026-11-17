import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  HandlerResult,
  type InstanceOf,
  type Items,
  mockHandlers,
  ResultKind,
  StateResult,
  setHandlersDisabled,
} from "..";

/**
 * mockHandlers: a mock replaces, on every target, all handlers of its variant and kind until its
 * disposer runs, and runs whether the handlers-off switch is on or not, with the arguments the replaced handlers
 * would get. Kinds it does not name follow the switch. A transition mock, on an asynchronous variant only, gives a
 * transition work also where no transition handler is registered.
 */
describe("mockHandlers", () => {
  const toggle = defineSignal("toggle");
  const bump = defineSignal("bump");

  type LampProps = { level: number; reading: number | null };

  /** A lamp: off -> on on toggle, on -> on with a new level on bump, on -> off on toggle; on reads a sensor. */
  function defineLamp() {
    const lamp = defineState<LampProps>()
      .name("lamp")
      .signals({ toggle, bump })
      .variant("off", { initial: true })
      .variant("on", { results: { measured: (data) => Number(data) } })
      .build();
    defineFlow(lamp.off, { toggle: (s) => lamp.on({ ...s, level: 10 }) });
    defineFlow(
      lamp.on,
      { toggle: (s) => lamp.off({ ...s, level: 0 }), bump: (s) => ({ ...s, level: s.level + 1 }) },
      { measured: (s, reading) => ({ ...s, reading }) },
    );
    return lamp;
  }
  type Lamp = ReturnType<typeof defineLamp>;
  type LampTarget = { lamp: InstanceOf<Lamp> };

  /** A lamp target whose real handlers on lamp.on record "<label> <kind>". */
  function makeLamp(lamp: Lamp, label: string, calls: string[]): LampTarget {
    const target = { lamp: { level: 0, reading: null } };
    applyFlow(target, [lamp], (sm) => {
      sm.addEnterHandler(lamp.on, () => {
        calls.push(`${label} enter`);
        return HandlerResult.ok();
      });
      sm.addExitHandler(lamp.on, () => {
        calls.push(`${label} exit`);
        return HandlerResult.ok();
      });
      sm.addUpdateHandler(lamp.on, () => {
        calls.push(`${label} update`);
        return HandlerResult.ok();
      });
      sm.addCommitHandler(lamp.on, () => {
        calls.push(`${label} commit`);
      });
    });
    return target as unknown as LampTarget;
  }

  afterEach(() => {
    setHandlersDisabled(false);
  });

  it("a mock replaces every handler of its variant and kind on every target, with the real arguments, the step's signal included, the switch on or off", () => {
    for (const disabled of [false, true]) {
      const lamp = defineLamp();
      const calls: string[] = [];
      const args: unknown[][] = [];
      const signals: unknown[] = [];
      const first = makeLamp(lamp, "first", calls);
      const second = makeLamp(lamp, "second", calls);
      setHandlersDisabled(disabled);
      using _mocks = mockHandlers(lamp.on, {
        enter: (state, snapshot, prev, key, signal) => {
          args.push([String(state), snapshot.lamp === state, String(prev), key]);
          signals.push(signal);
          return HandlerResult.ok();
        },
        exit: (state) => {
          calls.push(`mock exit ${String(state)}`);
          return HandlerResult.ok();
        },
        update: (state, _snapshot, prev, _key, signal) => {
          calls.push(`mock update ${String(prev)} -> ${String(state)}`);
          signals.push(signal);
          return HandlerResult.ok();
        },
        commit: (state) => {
          calls.push(`mock commit ${String(state)}`);
        },
      });

      for (const target of [first, second]) {
        expect(dispatch(target, toggle()).kind).toBe(ResultKind.OK);
        dispatch(target, bump());
        dispatch(target, toggle());
      }

      const label = `switch ${disabled ? "on" : "off"}`;
      expect(args, label).toEqual([
        ["lamp.on(level=10 reading=N)", true, "lamp.off(level=0 reading=N)", undefined],
        ["lamp.on(level=10 reading=N)", true, "lamp.off(level=0 reading=N)", undefined],
      ]);
      // The enter's and the update's on each target, every step committed, so none aborted.
      expect(
        signals.map((signal) => signal instanceof AbortSignal && !signal.aborted),
        label,
      ).toEqual([true, true, true, true]);
      const once = [
        "mock commit lamp.on(level=10 reading=N)",
        "mock update lamp.on(level=10 reading=N) -> lamp.on(level=11 reading=N)",
        "mock exit lamp.on(level=11 reading=N)",
      ];
      expect(calls, label).toEqual([...once, ...once]);
    }
  });

  it("a mock gets a nested state's key, and its named result folds like a handler's", () => {
    const add = defineSignal<{ key: string }>("add");
    const lamp = defineLamp();
    const room = defineState<{ lamps: Items<Lamp> }>()
      .name("room")
      .signals({ add })
      .variant("open", { initial: true })
      .build();
    defineFlow(room.open, {
      add: (r, { key }) => ({ lamps: r.lamps.with(key, lamp.on({ level: 1, reading: null })) }),
    });
    const target = { room: { lamps: lamp.items() } };
    applyFlow(target, [room], () => {});
    const keys: unknown[] = [];
    using _mocks = mockHandlers(lamp.on, {
      enter: (_state, _snapshot, _prev, key) => {
        keys.push(key);
        return lamp.on.results.measured(42);
      },
    });

    dispatch(target, add({ key: "desk" }));

    expect(keys).toEqual(["desk"]);
    expect(String((target as unknown as { room: InstanceOf<typeof room> }).room.lamps.get("desk"))).toBe(
      "lamp.on(level=1 reading=42)",
    );
  });

  it("the disposer restores the registered handlers; a second dispose changes nothing", () => {
    const lamp = defineLamp();
    const calls: string[] = [];
    const target = makeLamp(lamp, "real", calls);
    const mocks = mockHandlers(lamp.on, {
      enter: () => {
        calls.push("mock enter");
        return HandlerResult.ok();
      },
    });

    dispatch(target, toggle());
    mocks[Symbol.dispose]();
    dispatch(target, toggle());
    dispatch(target, toggle());
    // A later mock of the kind is not removed by the old disposer.
    using _later = mockHandlers(lamp.on, {
      enter: () => {
        calls.push("later enter");
        return HandlerResult.ok();
      },
    });
    mocks[Symbol.dispose]();
    dispatch(target, toggle());
    dispatch(target, toggle());

    expect(calls).toEqual([
      "mock enter",
      "real commit",
      "real exit",
      "real enter",
      "real commit",
      "real exit",
      "later enter",
      "real commit",
    ]);
  });

  it("a second mock of one variant and kind throws; another kind of the variant can be mocked", () => {
    const lamp = defineLamp();
    using _first = mockHandlers(lamp.on, { enter: () => HandlerResult.ok() });

    expect(() => mockHandlers(lamp.on, { enter: () => HandlerResult.ok(), exit: () => HandlerResult.ok() })).toThrow(
      "lamp.on: its enter handlers are mocked already; dispose that mock first",
    );
    // The refused call added nothing: exit is still free.
    using _exit = mockHandlers(lamp.on, { exit: () => HandlerResult.ok() });
    // Another variant is another key.
    using _off = mockHandlers(lamp.off, { enter: () => HandlerResult.ok() });
  });

  it("a key that is not a kind it mocks throws, and the call installs nothing", () => {
    const lamp = defineLamp();
    const calls: string[] = [];
    const target = makeLamp(lamp, "real", calls);
    // Passed as a variable, an object with a key outside the mocks' type compiles: the excess-property check
    // applies to an object literal only.
    const given = {
      enter: () => HandlerResult.rejected("mocked"),
      work: async () => HandlerResult.rejected("mocked"),
    };

    expect(() => mockHandlers(lamp.on, given)).toThrow(
      "lamp.on: mockHandlers mocks enter, exit, update, transition and commit handlers, not work",
    );

    // Nothing was installed: the real enter runs.
    expect(dispatch(target, toggle()).kind).toBe(ResultKind.OK);
    expect(calls).toEqual(["real enter", "real commit"]);
  });

  it("partial mocking: one kind mocked, the others follow the switch", () => {
    const lamp = defineLamp();
    const calls: string[] = [];
    const target = makeLamp(lamp, "real", calls);
    using _mocks = mockHandlers(lamp.on, {
      enter: () => {
        calls.push("mock enter");
        return HandlerResult.ok();
      },
    });

    dispatch(target, toggle());
    dispatch(target, toggle());
    setHandlersDisabled(true);
    dispatch(target, toggle());
    dispatch(target, toggle());

    // Switch off: the mock and the real exit and commit; switch on: only the mock.
    expect(calls).toEqual(["mock enter", "real commit", "real exit", "mock enter"]);
  });

  describe("transition mocks", () => {
    const start = defineSignal("start");

    /** A job whose start declares a transition into done, asynchronous, which declares the named result loaded; the
     * job keeps its instance as temp. */
    function defineJob() {
      const job = defineState<{ manifest: string | null }>()
        .name("job")
        .signals({ start })
        .variant("idle", { initial: true })
        .variant("done", { async: true, results: { loaded: (data) => String(data) } })
        .variant("failed")
        .build();
      defineFlow(job.idle, {
        start: (s, _signal, ctx) => StateResult.transition(job.done(s), job(ctx), job.failed(s)),
      });
      defineFlow(job.done, {}, { loaded: (s, manifest) => ({ ...s, manifest }) });
      return job;
    }

    it("a transition mock gives work to a variant with no transition handler, with the real arguments, the switch on or off", async () => {
      for (const disabled of [false, true]) {
        const job = defineJob();
        const target = { job: { manifest: null } };
        applyFlow(target, [job], () => {});
        setHandlersDisabled(disabled);
        const args: unknown[] = [];
        using _mocks = mockHandlers(job.done, {
          transition: async (next, snapshot, prev, key, signal) => {
            args.push(String(next), snapshot.job === next, String(prev), key, signal instanceof AbortSignal);
            return job.done.results.loaded("mocked");
          },
        });

        const r = dispatch(target, start());

        const label = `switch ${disabled ? "on" : "off"}`;
        expect(r.kind, label).toBe(ResultKind.InTransition);
        expect((await r.done()).kind, label).toBe(ResultKind.OK);
        expect(args, label).toEqual(["job.done(manifest=N)", true, "job.idle(manifest=N)", undefined, true]);
        expect(String(target.job), label).toBe("job.done(manifest=mocked)");
        setHandlersDisabled(false);
      }
    });

    it("a transition mock replaces the registered transition handlers of its variant; a refusal from it takes the node to failed", async () => {
      const job = defineJob();
      const real = vi.fn(async () => HandlerResult.ok());
      const target = { job: { manifest: null } };
      applyFlow(target, [job], (sm) => sm.addTransitionHandler(job.done, real));
      using _mocks = mockHandlers(job.done, { transition: async () => HandlerResult.rejected("no manifest") });

      const outcome = await dispatch(target, start()).done();

      expect(String(outcome)).toBe("Rejected: no manifest");
      expect(String(target.job)).toBe("job.failed(manifest=N)");
      expect(real).not.toHaveBeenCalled();
    });

    it("a transition mock takes an asynchronous variant only: on any other the call throws and installs nothing", () => {
      const lamp = defineLamp();
      const calls: string[] = [];
      const target = makeLamp(lamp, "real", calls);

      // Cast, as plain JavaScript would pass it: the variant's type refuses a transition mock too.
      expect(() =>
        mockHandlers(lamp.on, {
          enter: () => HandlerResult.rejected("mocked"),
          transition: async () => HandlerResult.ok(),
        } as never),
      ).toThrow("lamp.on is not asynchronous: only a variant declared with { async: true } has transition handlers");

      // Nothing was installed: the real enter runs.
      expect(dispatch(target, toggle()).kind).toBe(ResultKind.OK);
      expect(calls).toEqual(["real enter", "real commit"]);
    });
  });

  it("a mock's refusal refuses the step as a handler's does", () => {
    const lamp = defineLamp();
    const target = makeLamp(lamp, "real", []);
    using _mocks = mockHandlers(lamp.on, {
      enter: () => HandlerResult.rejected("no power"),
    });
    const before = target.lamp;

    const result = dispatch(target, toggle());

    expect(String(result)).toBe("Rejected: no power");
    expect(target.lamp).toBe(before);
  });
});
