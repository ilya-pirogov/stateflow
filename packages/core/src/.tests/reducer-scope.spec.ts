import { describe, expect, it } from "vitest";

import { applyFlow, defineFlow, defineSignal, defineState, dispatch, lock, ResultKind } from "..";
import { isInReducer } from "../reducer-scope";

const ping = defineSignal("ping");
const boom = defineSignal("boom");

describe("reducer-scope", () => {
  it("is false at rest", () => {
    expect(isInReducer()).toBe(false);
  });

  it("is true inside a reducer and restored after", async () => {
    let seenInside = false;
    const s = defineState<{ n: number }>().name("s").signals({ ping }).variant("idle", true).build();
    defineFlow(s.idle, {
      ping: (state) => {
        seenInside = isInReducer();
        return s.idle(state);
      },
    });
    const target = { s: s.idle({ n: 0 }) };
    applyFlow(target, [s], () => {});
    await using send = await lock(target);
    await send(ping()).done();
    expect(seenInside).toBe(true);
    expect(isInReducer()).toBe(false);
  });

  it("throws when a reducer dispatches, surfacing as Result.error", async () => {
    const s = defineState<{ n: number }>().name("s2").signals({ boom }).variant("idle", true).build();
    defineFlow(s.idle, {
      boom: (state) => {
        // Illegal: dispatching from inside a reducer.
        dispatch(target, boom());
        return s.idle(state);
      },
    });
    const target = { s2: s.idle({ n: 0 }) };
    applyFlow(target, [s], () => {});
    await using send = await lock(target);
    const result = send(boom());
    expect(result.kind).toBe(ResultKind.Error);
    expect(String(result)).toContain("Cannot dispatch from inside a reducer");
    expect(isInReducer()).toBe(false);
  });
});
