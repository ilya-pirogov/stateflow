import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// setGlobalDispatchContextProvider comes from the package index ON PURPOSE — consumers
// import it from "@state-flow/core", so this pins the public export.
import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  lock,
  setConsoleLogSilenced,
  setGlobalDispatchContextProvider,
} from "..";
import type { StateFlowLogEntry } from "../logger";

/**
 * Dispatch-context capture — `lock(target, label)` calls the globally registered provider
 * SYNCHRONOUSLY in its prologue (i.e. still in the caller's stack: for UI-triggered locks,
 * inside the interaction event's synchronous propagation) and stamps the snapshot onto every
 * entry of the labeled section as `dispatchContext`, plus the console.group header.
 *
 * The default (no provider) MUST be byte-identical to the pre-feature behavior: raw label in
 * console.group, no extra field on entries.
 */
describe("lock(target, label) — dispatch context capture", () => {
  const signals = {
    go: defineSignal("go"),
    finish: defineSignal("finish"),
  };

  const s = defineState<{ n: number }>().name("dcx").signals(signals).variant("idle", true).variant("active").build();

  defineFlow(s.idle, {
    go: (state) => s.active({ n: state.n + 1 }),
  });
  defineFlow(s.active, {
    go: (state) => ({ n: state.n + 1 }),
    finish: (state) => s.idle(state),
  });

  let app: { dcx: { n: number } };
  let entries: StateFlowLogEntry[];
  let groupSpy: ReturnType<typeof vi.spyOn>;
  let unsetProvider: (() => void) | null = null;

  beforeEach(() => {
    app = { dcx: { n: 0 } };
    entries = [];

    setConsoleLogSilenced(false);
    groupSpy = vi.spyOn(console, "group").mockImplementation(() => {});
    vi.spyOn(console, "groupEnd").mockImplementation(() => {});

    applyFlow(app, [s], () => {}, {
      logHandlers: [(entry: StateFlowLogEntry): void => void entries.push(entry)],
    });
  });

  afterEach(() => {
    unsetProvider?.();
    unsetProvider = null;
    vi.restoreAllMocks();
    setConsoleLogSilenced(null);
  });

  it("stamps the provider snapshot on every entry of the section and decorates the group header", async () => {
    unsetProvider = setGlobalDispatchContextProvider(() => "click(button#play 'Play')+0ms");

    {
      await using send = await lock(app, "play request");
      await send(signals.go()).done();
      await send(signals.finish()).done();
    }

    expect(groupSpy).toHaveBeenCalledTimes(1);
    expect(groupSpy).toHaveBeenCalledWith("play request ⟵ click(button#play 'Play')+0ms");
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      // groupLabel stays the RAW label; the context rides the dedicated field.
      expect(entry.groupLabel).toBe("play request");
      expect(entry.dispatchContext).toBe("click(button#play 'Play')+0ms");
    }
  });

  it("captures SYNCHRONOUSLY at lock() CALL time — before even one microtask", async () => {
    let current = "click(button#play)+0ms";
    unsetProvider = setGlobalDispatchContextProvider(() => current);

    // Mutate the marker synchronously RIGHT AFTER the un-awaited lock() call: only a capture
    // in lock()'s synchronous prologue (the caller's stack — the interaction event's
    // propagation window) sees the original value; a microtask-deferred capture would not.
    const pending = lock(app, "race");
    current = "keydown(Escape)+0ms";

    const send = await pending;
    try {
      await send(signals.go()).done();
    } finally {
      await send[Symbol.asyncDispose]();
    }

    expect(entries[0]?.dispatchContext).toBe("click(button#play)+0ms");
  });

  it("no provider (the default): raw header, no dispatchContext field — byte-identical behavior", async () => {
    {
      await using send = await lock(app, "play request");
      await send(signals.go()).done();
    }

    expect(groupSpy).toHaveBeenCalledWith("play request");
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("dispatchContext");
  });

  it("null-returning and THROWING providers degrade to the no-context behavior", async () => {
    unsetProvider = setGlobalDispatchContextProvider(() => null);
    {
      await using send = await lock(app, "a");
      await send(signals.go()).done();
    }
    expect(groupSpy).toHaveBeenLastCalledWith("a");
    expect(entries[0]).not.toHaveProperty("dispatchContext");

    unsetProvider();
    unsetProvider = setGlobalDispatchContextProvider(() => {
      throw new Error("provider exploded");
    });
    {
      await using send = await lock(app, "b");
      await send(signals.finish()).done();
    }
    expect(groupSpy).toHaveBeenLastCalledWith("b");
    expect(entries[1]).not.toHaveProperty("dispatchContext");
  });

  it("does not call the provider for unlabeled locks", async () => {
    const provider = vi.fn(() => "click(div)+0ms");
    unsetProvider = setGlobalDispatchContextProvider(provider);

    {
      await using send = await lock(app);
      await send(signals.go()).done();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider).not.toHaveBeenCalled();
    expect(entries[0]?.dispatchContext).toBeUndefined();
  });

  it("unsubscribe restores the default; re-registration wins", async () => {
    const unset = setGlobalDispatchContextProvider(() => "first");
    unset();
    {
      await using send = await lock(app, "after-unset");
      await send(signals.go()).done();
    }
    expect(entries[0]).not.toHaveProperty("dispatchContext");

    unsetProvider = setGlobalDispatchContextProvider(() => "second");
    {
      await using send = await lock(app, "re-registered");
      await send(signals.finish()).done();
    }
    expect(entries[1]?.dispatchContext).toBe("second");
  });

  it("a STALE unsubscribe cannot clobber a newer registration (last registration wins)", async () => {
    const unsetFirst = setGlobalDispatchContextProvider(() => "first");
    unsetProvider = setGlobalDispatchContextProvider(() => "second");
    // e.g. a disposed tracker instance unsubscribing after a newer one registered
    unsetFirst();

    {
      await using send = await lock(app, "stale-unset");
      await send(signals.go()).done();
    }
    expect(entries[0]?.dispatchContext).toBe("second");
  });

  it("delivers dispatchContext on the SILENCED path too (recorder still sees it)", async () => {
    setConsoleLogSilenced(true);
    unsetProvider = setGlobalDispatchContextProvider(() => "click(video)+1ms");

    {
      await using send = await lock(app, "silenced");
      await send(signals.go()).done();
    }

    expect(groupSpy).not.toHaveBeenCalled();
    expect(entries[0]?.groupLabel).toBe("silenced");
    expect(entries[0]?.dispatchContext).toBe("click(video)+1ms");
  });

  it("appends the lock wait to the context when the lock was contended", async () => {
    unsetProvider = setGlobalDispatchContextProvider(() => "click(button#play)+0ms");

    // Holder keeps the lock busy long enough for a measurable wait (>= 5ms threshold).
    const holder = await lock(app, "holder");
    const contended = (async () => {
      await using send = await lock(app, "contended");
      await send(signals.go()).done();
    })();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await holder[Symbol.asyncDispose]();
    await contended;

    const entry = entries.find((e) => e.groupLabel === "contended");
    expect(entry?.dispatchContext).toMatch(/^click\(button#play\)\+0ms \[lock \d+ms\]$/);
  });
});
