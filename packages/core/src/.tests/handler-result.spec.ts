import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  HandlerResult,
  type Result,
  ResultKind,
  type StateFlowLogEntry,
  type StateInstance,
  type StateManager,
  StateResult,
} from "..";

/**
 * An enter, exit or update handler's Rejected or throw refuses the dispatch: nothing commits, the dispatch's result is
 * the failure (a throw, or a return that is not a HandlerResult, becomes an Error), and the handler's result in the log
 * entry carries it. Handlers run phase by phase, exit, then update, then enter: every handler of the failing phase
 * runs, its failures merge in call order (states in the flow's order, one variant's handlers in registration order),
 * and the later phases, the commit and the commit handlers do not. A commit handler runs after the commit and cannot
 * refuse it. When the reducer declared a failed, the refused step goes to it with the same merged refusal as the
 * result, and the failed step's own handlers cannot refuse it: their failure, a failing exit's included, which the
 * failed step calls again where it leaves the same instance, is an Error of the result (failed.spec.ts has the failed
 * path itself).
 */
describe("handler result", () => {
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

  type Target = { light: StateInstance<{ n: number }> };

  function make(init: Parameters<typeof applyFlow>[2], entries: StateFlowLogEntry[]): Target {
    const target = { light: { n: 0 } };
    applyFlow(target, [light], init, { logHandlers: [(entry) => entries.push(entry)] });
    return target as unknown as Target;
  }

  // Log entries are delivered after the dispatch returns.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  type Handler = () => HandlerResult;

  // For each handler kind: where it is registered, the dispatch that runs it, and the state before that
  // dispatch. toggle leaves off and enters on; bump changes on in place, so its target is toggled first.
  const kinds: [string, (sm: StateManager, h: Handler) => void, (t: Target) => Result, string][] = [
    ["exit", (sm, h) => sm.addExitHandler(light.off, h), (t) => dispatch(t, toggle()), "light.off(n=0)"],
    ["enter", (sm, h) => sm.addEnterHandler(light.on, h), (t) => dispatch(t, toggle()), "light.off(n=0)"],
    [
      "update",
      (sm, h) => sm.addUpdateHandler(light.on, h),
      (t) => {
        dispatch(t, toggle());
        return dispatch(t, bump());
      },
      "light.on(n=1)",
    ],
  ];

  // What a failing handler does, the result kind it gives, and that result's string form, which its handler result in
  // the log entry and the entry's finalResult share. A Symbol has a string form; the next two thrown values have none.
  const failures: [string, Handler, ResultKind, string][] = [
    ["returns a Rejected", () => HandlerResult.rejected("refused"), ResultKind.Rejected, "Rejected: refused"],
    [
      "throws an Error",
      () => {
        throw new Error("boom");
      },
      ResultKind.Error,
      "Error: boom",
    ],
    [
      "throws a Symbol",
      () => {
        throw Symbol("boom");
      },
      ResultKind.Error,
      "Error: Symbol(boom)",
    ],
    [
      "throws an object whose toString throws",
      () => {
        throw {
          toString() {
            throw new Error("no string form");
          },
        };
      },
      ResultKind.Error,
      "Error: a thrown value with no string form",
    ],
    [
      "throws an object with no prototype",
      () => {
        throw Object.create(null);
      },
      ResultKind.Error,
      "Error: a thrown value with no string form",
    ],
    [
      "returns a promise",
      // Only a cast gets an async handler past the type: enter, exit and update handlers are synchronous.
      async function later() {
        return HandlerResult.ok();
      } as unknown as Handler,
      ResultKind.Error,
      "StateFlowError: Handler 'later' returned a promise; enter, exit and update handlers are synchronous [SF050] Return a HandlerResult synchronously; put the waiting in a transition handler.",
    ],
    [
      "returns no HandlerResult",
      // Only a cast gets a handler that returns nothing past the type, as plain JavaScript would.
      function forgetful() {} as unknown as Handler,
      ResultKind.Error,
      "StateFlowError: Handler 'forgetful' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.",
    ],
    [
      "returns a reducer's StateResult",
      // This and the merge below need a cast too: a StateResult or an engine result is no HandlerResult to the
      // type either, and the engine's check refuses them in plain JavaScript.
      function reducerResult() {
        return StateResult.rejected("refused");
      } as unknown as Handler,
      ResultKind.Error,
      "StateFlowError: Handler 'reducerResult' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.",
    ],
    [
      "returns a merge",
      function merged() {
        return HandlerResult.ok().merge(HandlerResult.ok());
      } as unknown as Handler,
      ResultKind.Error,
      "StateFlowError: Handler 'merged' did not return a HandlerResult [SF053] Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.",
    ],
  ];

  const refusals = kinds.flatMap(([kind, add, run, before]) =>
    failures.map(
      ([what, handler, resultKind, text]) => [kind, what, add, run, before, handler, resultKind, text] as const,
    ),
  );

  it.each(
    refusals,
  )("an %s handler that %s refuses the dispatch: nothing commits, the result is the failure, and its handler result carries it", async (kind, _what, add, run, before, handler, resultKind, text) => {
    const entries: StateFlowLogEntry[] = [];
    const target = make((sm) => add(sm, handler), entries);

    const result = run(target);

    expect(result.kind).toBe(resultKind);
    expect(String(result)).toBe(text);
    expect(String(target.light)).toBe(before);
    await tick();
    const entry = entries[entries.length - 1];
    expect(entry.finalResult).toBe(text);
    expect(entry.finalStates).toEqual({ light: before });
    expect(entry.handlerResults).toEqual([expect.objectContaining({ type: kind, stateName: "light", result: text })]);
  });

  /** A light like the one above whose reducers declare failed: toggle and bump go to broken when a handler refuses. */
  function defineFailingLight() {
    const lamp = defineState<{ n: number }>()
      .name("light")
      .signals({ toggle, bump })
      .variant("off", { initial: true })
      .variant("on")
      .variant("broken")
      .build();
    defineFlow(lamp.off, { toggle: (s) => StateResult.ok(lamp.on({ n: s.n + 1 }), lamp.broken(s)) });
    defineFlow(lamp.on, { bump: (s) => StateResult.ok(lamp.on({ n: s.n + 1 }), lamp.broken(s)) });
    return lamp;
  }
  type FailingLight = ReturnType<typeof defineFailingLight>;

  // As `kinds`, on a failing light, with the state each refusal ends in. An exit has a case of its own below: the
  // failed step leaves the instance the refused step left, so it calls the exit again.
  const failingKinds: [
    string,
    (sm: StateManager, lamp: FailingLight, h: Handler) => void,
    (t: Target) => Result,
    string,
  ][] = [
    ["enter", (sm, lamp, h) => sm.addEnterHandler(lamp.on, h), (t) => dispatch(t, toggle()), "light.broken(n=0)"],
    [
      "update",
      (sm, lamp, h) => sm.addUpdateHandler(lamp.on, h),
      (t) => {
        dispatch(t, toggle());
        return dispatch(t, bump());
      },
      "light.broken(n=1)",
    ],
  ];

  it.each(
    failingKinds.flatMap(([kind, add, run, end]) =>
      failures.map(
        ([what, handler, resultKind, text]) => [kind, what, add, run, end, handler, resultKind, text] as const,
      ),
    ),
  )("with failed declared, an %s handler that %s takes the state to failed, and the result is the failure", (_kind, _what, add, run, end, handler, resultKind, text) => {
    const lamp = defineFailingLight();
    const target = { light: { n: 0 } };
    applyFlow(target, [lamp], (sm) => add(sm, lamp, handler));
    const typed = target as unknown as Target;

    const result = run(typed);

    expect(result.kind).toBe(resultKind);
    expect(String(result)).toBe(text);
    expect(String(typed.light)).toBe(end);
  });

  // A failing exit, and the result once its second call, in the failed step, failed too: an Error over a Rejected, or
  // two Errors as one.
  const exitFailures: [string, Handler, string][] = [
    [
      "returns a Rejected",
      () => HandlerResult.rejected("refused"),
      "StateFlowError: refused [SF029] Make the failed variant's handlers succeed; report trouble there through state, not a refusal.",
    ],
    [
      "throws an Error",
      () => {
        throw new Error("boom");
      },
      "AggregateError: boom; boom",
    ],
  ];

  it.each(
    exitFailures,
  )("with failed declared, an exit handler that %s runs again in the failed step, which leaves the same instance: the state goes to failed, and its second failure joins the result as an Error", (_what, handler, text) => {
    const lamp = defineFailingLight();
    let calls = 0;
    const target = { light: { n: 0 } };
    applyFlow(target, [lamp], (sm) =>
      sm.addExitHandler(lamp.off, () => {
        calls += 1;
        return handler();
      }),
    );
    const typed = target as unknown as Target;

    const result = dispatch(typed, toggle());

    expect(calls).toBe(2);
    expect(String(typed.light)).toBe("light.broken(n=0)");
    expect(result.kind).toBe(ResultKind.Error);
    expect(String(result)).toBe(text);
  });

  it.each(
    failures,
  )("a failed step's handler that %s does not stop its commit: failed commits, and the result is an Error", (_what, handler, _kind, text) => {
    const lamp = defineFailingLight();
    const target = { light: { n: 0 } };
    applyFlow(target, [lamp], (sm) => {
      sm.addEnterHandler(lamp.on, () => HandlerResult.rejected("not now"));
      sm.addEnterHandler(lamp.broken, handler);
    });

    const result = dispatch(target, toggle());

    expect(String((target as unknown as Target).light)).toBe("light.broken(n=0)");
    // The failed step's failure outranks the step's Rejected: an Error stays itself, a Rejected becomes an Error.
    expect(result.kind).toBe(ResultKind.Error);
    expect(String(result)).toBe(
      text === "Rejected: refused"
        ? "StateFlowError: refused [SF029] Make the failed variant's handlers succeed; report trouble there through state, not a refusal."
        : text,
    );
  });

  it("every handler of the failing phase runs, of every state, and of two Rejected the first is the result; the later phases, the commit and the commit handlers do not", () => {
    const fan = defineState<{ n: number }>()
      .name("fan")
      .signals({ toggle })
      .variant("off", { initial: true })
      .variant("on")
      .build();
    defineFlow(fan.off, { toggle: (s) => fan.on(s) });
    const ran: string[] = [];
    const target = { light: { n: 0 }, fan: { n: 0 } };
    applyFlow(target, [light, fan], (sm) => {
      sm.addExitHandler(light.off, () => {
        ran.push("light exit 1");
        return HandlerResult.rejected("not now");
      });
      sm.addExitHandler(light.off, () => {
        ran.push("light exit 2");
        return HandlerResult.rejected("second");
      });
      sm.addExitHandler(fan.off, () => {
        ran.push("fan exit");
        return HandlerResult.ok();
      });
      sm.addEnterHandler(light.on, () => {
        ran.push("light enter");
        return HandlerResult.ok();
      });
      sm.addCommitHandler(light.on, () => {
        ran.push("light commit");
      });
    });

    const result = dispatch(target, toggle());

    expect(String(result)).toBe("Rejected: not now");
    expect(ran).toEqual(["light exit 1", "light exit 2", "fan exit"]);
    expect([String(target.light), String(target.fan)]).toEqual(["light.off(n=0)", "fan.off(n=0)"]);
  });

  it("a phase's refusals merge in call order: an Error wins over a Rejected, the first Rejected over a later one, and states go in the flow's order whatever the registration order", () => {
    const rejects = (message: string) => () => HandlerResult.rejected(message);
    const throws = (message: string) => () => {
      throw new Error(message);
    };
    // Two Rejected of one variant are the test above.
    const cases: Array<[string, Handler[], string]> = [
      ["Rejected, Error", [rejects("first"), throws("boom")], "Error: boom"],
      ["Error, Rejected", [throws("boom"), rejects("second")], "Error: boom"],
      ["Ignored, Rejected", [() => HandlerResult.ignored("skip"), rejects("second")], "Rejected: second"],
    ];
    for (const [label, handlers, text] of cases) {
      const target = make((sm) => {
        for (const handler of handlers) {
          sm.addExitHandler(light.off, handler);
        }
      }, []);

      const result = dispatch(target, toggle());

      expect(String(result), label).toBe(text);
      expect(String(target.light), label).toBe("light.off(n=0)");
    }

    const fan = defineState<{ n: number }>()
      .name("fan")
      .signals({ toggle })
      .variant("off", { initial: true })
      .variant("on")
      .build();
    defineFlow(fan.off, { toggle: (s) => fan.on(s) });
    const target = { light: { n: 0 }, fan: { n: 0 } };
    applyFlow(target, [light, fan], (sm) => {
      // fan's handler is registered first, but light comes first in the flow, so its exit is called first.
      sm.addExitHandler(fan.off, rejects("fan refuses"));
      sm.addExitHandler(light.off, rejects("light refuses"));
    });

    expect(String(dispatch(target, toggle()))).toBe("Rejected: light refuses");
  });

  it("the refusal names the handler that refused and the state change it refused", () => {
    const target = make((sm) => {
      sm.addExitHandler(light.off, function guard() {
        return HandlerResult.rejected("not now");
      });
      // Runs after the refusal and succeeds; its name must not replace the refusing handler's.
      sm.addExitHandler(light.off, function laterOk() {
        return HandlerResult.ok();
      });
    }, []);

    const result = dispatch(target, toggle());

    expect(() => result.expect(ResultKind.OK)).toThrow(
      "[SF] Signal 'toggle{}' in handler 'guard()' was rejected while trying to exit light: Message: not now",
    );
  });

  it("of a refusal that two handlers return as one constant, the result names the first, and the constant is left as it was", () => {
    const notNow = HandlerResult.rejected("not now");
    const target = make((sm) => {
      sm.addExitHandler(light.off, function guardA() {
        return notNow;
      });
      sm.addExitHandler(light.off, function guardB() {
        return notNow;
      });
    }, []);

    const result = dispatch(target, toggle());

    expect(() => result.expect(ResultKind.OK)).toThrow(
      "[SF] Signal 'toggle{}' in handler 'guardA()' was rejected while trying to exit light: Message: not now",
    );
    // The engine names a copy, so the constant still names no signal, handler or state.
    expect(() => notNow.expect(ResultKind.OK)).toThrow(
      /^\[SF\] Result was rejected: Message: not now \[SF066\] Handle the outcome the message names, or list its kind in expect\(\)\.$/,
    );
  });

  it("a handler's Ignored does not refuse: the state commits and the result is OK", () => {
    const target = make((sm) => sm.addEnterHandler(light.on, () => HandlerResult.ignored("already lit")), []);

    expect(dispatch(target, toggle()).kind).toBe(ResultKind.OK);
    expect(String(target.light)).toBe("light.on(n=1)");
  });

  it.each(
    failures.filter(([what]) => what.startsWith("throws")),
  )("a commit handler that %s cannot refuse: its handler result carries the Error, the commit stands and the result is OK", async (_what, handler, _kind, text) => {
    const entries: StateFlowLogEntry[] = [];
    const target = make((sm) => sm.addCommitHandler(light.on, handler), entries);

    expect(dispatch(target, toggle()).kind).toBe(ResultKind.OK);

    expect(String(target.light)).toBe("light.on(n=1)");
    await tick();
    expect(entries[0].handlerResults).toEqual([
      expect.objectContaining({ type: "commit", stateName: "light", result: text }),
    ]);
  });
});
