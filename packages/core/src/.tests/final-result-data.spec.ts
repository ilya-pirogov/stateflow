import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  HandlerResult,
  type StateFlowLogEntry,
  type StateManager,
  StateResult,
} from "..";

/**
 * A log entry gives its final result twice: `finalResult` as the text a person reads, and `finalResultData` as plain
 * data a tool reads, so a tool never parses the text. The text is the same as without the data.
 */
describe("finalResultData", () => {
  const toggle = defineSignal("toggle");
  const refuse = defineSignal("refuse");
  const warm = defineSignal("warm");
  const bump = defineSignal("bump");

  const lamp = defineState<{ n: number }>()
    .name("lamp")
    .signals({ toggle, refuse, warm, bump })
    .variant("off", { initial: true })
    .variant("on")
    .variant("warming")
    .variant("lit", { async: true })
    .build();
  defineFlow(lamp.off, {
    toggle: (s) => lamp.on({ n: s.n + 1 }),
    refuse: () => StateResult.rejected("not now"),
    warm: (s) => StateResult.transition(lamp.lit(s), lamp.warming(s), lamp.off(s)),
  });

  /** The entry of `signal` dispatched once to a fresh lamp whose handlers `init` registers. */
  async function entryOf(signal: ReturnType<typeof toggle>, init: (sm: StateManager) => void = () => {}) {
    const entries: StateFlowLogEntry[] = [];
    const target = { lamp: { n: 0 } };
    applyFlow(target, [lamp], init, { logHandlers: [(entry) => entries.push(entry)] });
    await dispatch(target, signal).done();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return entries[0];
  }

  it.each([
    ["OK", toggle(), () => {}, "OK", { kind: "OK", message: null, code: null, errors: [] }],
    [
      "Ignored",
      bump(),
      () => {},
      "Ignored: no reducer for bump in lamp.off",
      { kind: "Ignored", message: "no reducer for bump in lamp.off", code: "SF064", errors: [] },
    ],
    [
      "Rejected",
      refuse(),
      () => {},
      "Rejected: not now",
      { kind: "Rejected", message: "not now", code: null, errors: [] },
    ],
    [
      "InTransition",
      warm(),
      (sm: StateManager) => sm.addTransitionHandler(lamp.lit, async () => HandlerResult.ok()),
      "InTransition",
      { kind: "InTransition", message: null, code: null, errors: [] },
    ],
    [
      "Error",
      toggle(),
      (sm: StateManager) =>
        sm.addEnterHandler(lamp.on, () => {
          throw new TypeError("no bulb");
        }),
      "TypeError: no bulb",
      { kind: "Error", message: null, code: null, errors: [{ name: "TypeError", message: "no bulb" }] },
    ],
  ] as const)("%s: the data gives the kind, the message and the errors; the text is as before", async (_kind, signal, init, text, data) => {
    const entry = await entryOf(signal, init);

    expect(entry.finalResult).toBe(text);
    expect(entry.message).toBe(`[SF/Object] ${signal} - ${text}`);
    expect(entry.finalResultData).toEqual(data);
    expect(JSON.parse(JSON.stringify(entry.finalResultData))).toEqual(entry.finalResultData);
  });

  it("merged Errors are one flat list of name and message, in merge order, though the merges nest", async () => {
    const entry = await entryOf(toggle(), (sm) => {
      sm.addEnterHandler(lamp.on, () => HandlerResult.error(new TypeError("a")));
      sm.addEnterHandler(lamp.on, () => HandlerResult.error(new RangeError("b")));
      sm.addEnterHandler(lamp.on, () => HandlerResult.error(new Error("c")));
    });

    expect(entry.finalResult).toBe("AggregateError: a; b; c");
    expect(entry.finalResultData).toEqual({
      kind: "Error",
      message: null,
      code: null,
      errors: [
        { name: "TypeError", message: "a" },
        { name: "RangeError", message: "b" },
        { name: "Error", message: "c" },
      ],
    });
  });

  /** An Error whose message is `message`, which `new Error()` would turn into a string. */
  function withMessage(message: unknown): Error {
    const error = new Error();
    Object.defineProperty(error, "message", { value: message });
    return error;
  }

  const circular: { self?: unknown } = {};
  circular.self = circular;

  it.each([
    [
      "an AggregateError of values that are not Errors",
      new AggregateError(["str", 42, { a: 1 }], "agg"),
      "AggregateError: agg",
      [{ name: "AggregateError", message: "agg" }],
    ],
    [
      "an empty AggregateError",
      new AggregateError([], "none"),
      "AggregateError: none",
      [{ name: "AggregateError", message: "none" }],
    ],
    [
      "an Error whose message is an object",
      withMessage({ a: 1 }),
      "Error: [object Object]",
      [{ name: "Error", message: "[object Object]" }],
    ],
    ["an Error whose message is a bigint", withMessage(BigInt(1)), "Error: 1", [{ name: "Error", message: "1" }]],
    [
      "an Error whose message is a circular object",
      withMessage(circular),
      "Error: [object Object]",
      [{ name: "Error", message: "[object Object]" }],
    ],
    ["an Error whose message is undefined", withMessage(undefined), "Error", [{ name: "Error", message: "" }]],
  ])("%s a handler threw is one error of strings, read as the text reads it, and survives JSON", async (_what, thrown, text, errors) => {
    const entry = await entryOf(toggle(), (sm) =>
      sm.addEnterHandler(lamp.on, () => {
        throw thrown;
      }),
    );

    expect(entry.finalResult).toBe(text);
    expect(entry.finalResultData).toEqual({ kind: "Error", message: null, code: null, errors });
    expect(JSON.parse(JSON.stringify(entry.finalResultData))).toEqual(entry.finalResultData);
  });

  it("an error whose name throws after the text read it still gives its entry, with the text as before", async () => {
    // The text reads the name three times: when the throw becomes a result, in the handler's result, in the final
    // result. Any later read throws.
    let reads = 0;
    class Sneaky extends Error {
      override get name(): string {
        reads += 1;
        if (reads > 3) {
          throw new Error("name read once too often");
        }
        return "Sneaky";
      }
    }
    const entries: StateFlowLogEntry[] = [];
    const target = { lamp: { n: 0 } };
    applyFlow(
      target,
      [lamp],
      (sm) =>
        sm.addEnterHandler(lamp.on, () => {
          throw new Sneaky("m");
        }),
      { logHandlers: [(entry) => entries.push(entry)] },
    );

    dispatch(target, toggle());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(entries.map((entry) => entry.finalResult)).toEqual(["Sneaky: m"]);
    expect(entries[0].message).toBe("[SF/Object] toggle{} - Sneaky: m");
    expect(entries[0].finalResultData).toBeUndefined();
  });
});
