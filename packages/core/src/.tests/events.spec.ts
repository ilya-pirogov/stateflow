import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  StateFlowError,
  type StateFlowLogEntry,
  stateVar,
  watch,
} from "..";

/**
 * Events (StateManager.defineEvent) and watches (watch): after every commit each decides on the committed states and
 * on the states as of the commit before, fires on a later turn, and leaves its decision in the entry's observers.
 */
describe("events and watches", () => {
  const signals = { bump: defineSignal("bump"), go: defineSignal("go"), back: defineSignal("back") };
  const cnt = defineState<{ n: number }>()
    .name("cnt")
    .signals(signals)
    .variant("idle", { initial: true })
    .variant("active")
    .build();
  const aux = defineState<{ m: number }>().name("aux").signals(signals).variant("only", { initial: true }).build();
  defineFlow(cnt.idle, { bump: (s) => ({ n: s.n + 1 }), go: (s) => cnt.active(s) });
  defineFlow(cnt.active, { bump: (s) => ({ n: s.n + 1 }), back: (s) => cnt.idle(s) });
  defineFlow(aux.only, { bump: (s) => ({ m: s.m + 1 }) });

  /** A target that records what it emits. */
  class Target {
    cnt = { n: 0 };
    aux = { m: 0 };
    readonly emitted: unknown[][] = [];
    emit(...args: unknown[]): void {
      this.emitted.push(args);
    }
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function flow(initializer: Parameters<typeof applyFlow<[typeof cnt, typeof aux]>>[2]): {
    target: Target;
    entries: StateFlowLogEntry[];
  } {
    const target = new Target();
    const entries: StateFlowLogEntry[] = [];
    applyFlow(target, [cnt, aux], initializer, { logHandlers: [(entry) => entries.push(entry)] });
    return { target, entries };
  }

  it("an event fires on a later turn after the commit its predicate accepts, with its payload; prev is the previous commit's states, the initial ones first; the entry records the decision under observers with the changed states", async () => {
    const { target, entries } = flow((sm) => {
      sm.defineEvent(
        "grew",
        (cur, prev) => cur.cnt.n > prev.cnt.n,
        (cur) => cur.cnt.n,
      );
    });

    dispatch(target, signals.bump());
    expect(target.emitted).toEqual([]);
    await tick();
    expect(target.emitted).toEqual([["grew", 1]]);
    expect(entries[0]?.observers).toEqual([{ observerName: "event:grew", stateName: "cnt,aux", needObserve: true }]);

    dispatch(target, signals.go());
    await tick();
    expect(target.emitted).toEqual([["grew", 1]]);
    expect(entries[1]?.observers).toEqual([{ observerName: "event:grew", stateName: "cnt", needObserve: false }]);
  });

  it("an event on a variant's entry needs no payload: the emit carries the name alone", async () => {
    const { target } = flow((sm) => {
      sm.defineEvent(
        "activated",
        (cur, prev) => stateVar(cur.cnt) !== stateVar(prev.cnt) && stateVar(cur.cnt) === cnt.active,
      );
    });
    dispatch(target, signals.bump());
    dispatch(target, signals.go());
    dispatch(target, signals.bump());
    await tick();
    expect(target.emitted).toEqual([["activated"]]);
  });

  it("events fire in definition order after one commit", async () => {
    const { target } = flow((sm) => {
      sm.defineEvent("first", (cur, prev) => cur.cnt.n !== prev.cnt.n);
      sm.defineEvent("second", (cur, prev) => cur.aux.m !== prev.aux.m);
    });
    dispatch(target, signals.bump());
    await tick();
    expect(target.emitted).toEqual([["first"], ["second"]]);
  });

  it("a throwing predicate is the entry's observer error and emits nothing; the commit stands", async () => {
    const { target, entries } = flow((sm) => {
      sm.defineEvent("broken", () => {
        throw new Error("no");
      });
    });
    dispatch(target, signals.bump());
    await tick();
    expect(target.cnt.n).toBe(1);
    expect(target.emitted).toEqual([]);
    expect(entries[0]?.observers).toEqual([
      { observerName: "event:broken", stateName: "cnt,aux", needObserve: false, error: expect.stringContaining("no") },
    ]);
  });

  it("applyFlow refuses an event on a target without emit", () => {
    const target = { cnt: { n: 0 }, aux: { m: 0 } };
    expect(() =>
      applyFlow(target, [cnt, aux], (sm) => {
        sm.defineEvent("grew", (cur, prev) => cur.cnt.n > prev.cnt.n);
      }),
    ).toThrow(StateFlowError);
    expect(() =>
      applyFlow({ cnt: { n: 0 }, aux: { m: 0 } }, [cnt, aux], (sm) => {
        sm.defineEvent("grew", (cur, prev) => cur.cnt.n > prev.cnt.n);
      }),
    ).toThrow("emit");
  });

  it("a watch runs its callback with the two snapshots when its predicate accepts a commit, its disposer stops it, and a disposed flow refuses a new one", async () => {
    const { target, entries } = flow(() => {});
    const seen: Array<[number, number]> = [];
    const w = watch(
      target,
      (cur, prev) => cur.cnt.n !== prev.cnt.n,
      (cur, prev) => seen.push([cur.cnt.n, prev.cnt.n]),
    );

    dispatch(target, signals.bump());
    dispatch(target, signals.go());
    await tick();
    expect(seen).toEqual([[1, 0]]);
    expect(entries[0]?.observers[0]).toMatchObject({
      observerName: expect.stringMatching(/^watch:/),
      needObserve: true,
    });

    w[Symbol.dispose]();
    dispatch(target, signals.bump());
    await tick();
    expect(seen).toEqual([[1, 0]]);

    disposeFlow(target);
    expect(() =>
      watch(
        target,
        () => true,
        () => {},
      ),
    ).toThrow("is disposed");
  });
});
