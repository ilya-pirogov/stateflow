import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyFlow, defineFlow, defineSignal, defineState, lock, setConsoleLogSilenced } from "..";
import type { StateFlowLogEntry } from "../logger";
import { Result } from "../result";

/**
 * `lock(target, label)` — an optional label adds one outer console-group level so all the
 * signals dispatched inside a single critical section read as one unit:
 *
 *   ▼ player play request
 *       ▶ [SF/player] play - OK
 *       ▶ [SF/driver] activate - OK
 *
 * Because StateFlow emits each entry asynchronously (`collector.finish().then(emit)`), a naive
 * `console.group()` around the lock body cannot nest the per-signal logs. So a labeled lock
 * BUFFERS its entries and flushes them together — inside one `console.group(label)` /
 * `console.groupEnd()` — when the lock releases. An unlabeled lock is unchanged (immediate emit).
 */
describe("lock(target, label) — grouped logging", () => {
  const signals = {
    go: defineSignal("go"),
    finish: defineSignal("finish"),
    load: defineSignal("load"),
  };

  const s = defineState<{ n: number }>()
    .name("lbl")
    .signals(signals)
    .variant("idle", true)
    .variant("active")
    .variant("loading")
    .build();

  defineFlow(s.idle, {
    go: (state) => s.active({ n: state.n + 1 }),
    load: (state) => s.loading(state),
  });
  defineFlow(s.active, {
    go: (state) => ({ n: state.n + 1 }),
    finish: (state) => s.idle(state),
  });
  defineFlow(s.loading, {});

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  let app: { lbl: { n: number } };
  let entries: StateFlowLogEntry[];
  let timeline: string[];
  let groupSpy: ReturnType<typeof vi.spyOn>;
  let groupEndSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = { lbl: { n: 0 } };
    entries = [];
    timeline = [];

    // This suite asserts the console grouping itself, so opt back into console output
    // (StateFlow silences it by default under vitest).
    setConsoleLogSilenced(false);

    groupSpy = vi.spyOn(console, "group").mockImplementation((...args: unknown[]) => {
      timeline.push(`group:${String(args[0])}`);
    });
    groupEndSpy = vi.spyOn(console, "groupEnd").mockImplementation(() => {
      timeline.push("groupEnd");
    });

    const handler = (entry: StateFlowLogEntry): void => {
      entries.push(entry);
      timeline.push(`entry:${entry.signal.split("{")[0]}`);
    };

    applyFlow(
      app,
      [s],
      (sm) => {
        sm.addEnterHandler(s.loading, () =>
          Result.transition(async () => {
            await Promise.resolve();
            return Result.ok();
          }, 1000),
        );
      },
      { logHandlers: [handler] },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setConsoleLogSilenced(null);
  });

  it("buffers entries during the lock and flushes them inside console.group(label) on release", async () => {
    {
      await using send = await lock(app, "play request");
      await send(signals.go()).done();

      // Still inside the lock: nothing emitted yet, no group opened.
      expect(entries).toHaveLength(0);
      expect(groupSpy).not.toHaveBeenCalled();
    }

    // Released: one outer group opened with the label, the entry emitted inside, group closed.
    expect(groupSpy).toHaveBeenCalledTimes(1);
    expect(groupSpy).toHaveBeenCalledWith("play request");
    expect(groupEndSpy).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].groupLabel).toBe("play request");
  });

  it("nests entries BETWEEN group() and groupEnd() in dispatch order", async () => {
    {
      await using send = await lock(app, "multi");
      await send(signals.go()).done();
      await send(signals.go()).done();
      await send(signals.finish()).done();
    }

    // The whole timeline proves correct nesting: open → entries (in order) → close.
    expect(timeline).toEqual(["group:multi", "entry:go", "entry:go", "entry:finish", "groupEnd"]);
    expect(entries.every((e) => e.groupLabel === "multi")).toBe(true);
  });

  it("includes async-transition entries in the group", async () => {
    {
      await using send = await lock(app, "load request");
      await send(signals.load()).done();
    }

    expect(groupSpy).toHaveBeenCalledWith("load request");
    const loadEntry = entries.find((e) => e.signal.startsWith("load"));
    expect(loadEntry).toBeDefined();
    expect(loadEntry?.isAsync).toBe(true);
    expect(loadEntry?.groupLabel).toBe("load request");
  });

  it("opens no console group when the labeled lock dispatched nothing", async () => {
    {
      await using send = await lock(app, "empty");
      void send;
    }

    expect(groupSpy).not.toHaveBeenCalled();
    expect(groupEndSpy).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
  });

  it("leaves unlabeled lock() unchanged: immediate emit, no grouping, no groupLabel", async () => {
    {
      await using send = await lock(app);
      await send(signals.go()).done();
    }
    await tick();

    expect(groupSpy).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0].groupLabel).toBeUndefined();
  });
});
