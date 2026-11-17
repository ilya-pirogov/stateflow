import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingWorld, runCounterExample, runPlayerExample, runSessionExample } from "../../examples/examples";
import { setHandlersDisabled } from "..";

/**
 * The test of a correct target: with every handler off and no mock, a full run from start to end is a
 * simulation of the flow's own logic and changes nothing outside StateFlow. Each scenario of examples.ts reaches
 * the world only through the `world` it is given, so a recording world shows every call it would make. With
 * handlers off every declared transition has no work and commits its next at once, with the props the world
 * would fill left at their defaults, so code that runs only after a failed end or an abort is not exercised:
 * examples.spec.ts reaches those paths with mocks.
 */
describe("simulation of the examples", () => {
  /** Runs every scenario with its own recording world, on fake timers run until the scenarios end: the player's slow
   * play waits for its timeout. */
  async function runAll(): Promise<Record<string, { ends: string[]; calls: string[] }>> {
    const runs: Record<string, { ends: string[]; calls: string[] }> = {};
    const running = (async () => {
      for (const [name, run] of [
        ["counter", runCounterExample],
        ["player", runPlayerExample],
        ["session", runSessionExample],
      ] as const) {
        const { world, calls } = recordingWorld();
        runs[name] = { ends: await run(world), calls };
      }
    })();
    await vi.runAllTimersAsync();
    await running;
    return runs;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setHandlersDisabled(false);
    vi.useRealTimers();
  });

  it("with every handler off, every example runs to its end states and makes no call on its world", async () => {
    setHandlersDisabled(true);

    const runs = await runAll();

    expect(runs).toEqual({
      counter: { ends: ["first.zero(allowed)", "second.done(c=2;m=still bad state)"], calls: [] },
      // Every play commits active at once with no manifest, and the last stop finds nothing pending, so it stops
      // as any signal does.
      player: {
        ends: [
          "driver.active(https://example.com/ok)",
          "driver.active(https://example.com/missing)",
          "driver.active(https://example.com/slow)",
          "driver.idle()",
        ],
        calls: [],
      },
      // open and every addProducer commit at once with no socket and no producer, and close finds nothing
      // pending, so it closes as any signal does.
      session: {
        ends: [
          "media.active(transport=transport.open(no socket) producers=Items(1){cam=producer.active(no rtp paused)})",
          "media.idle(transport=transport.closed(no socket) producers=Items(0){})",
        ],
        calls: [],
      },
    });
  });

  it("positive control: with handlers on, the same scenarios make the world calls they are written to make", async () => {
    const runs = await runAll();

    expect(runs).toEqual({
      counter: {
        ends: ["first.zero(allowed)", "second.done(c=2;m=still bad state)"],
        calls: ["light true", "light false", "notify counter done at 2"],
      },
      player: {
        ends: [
          "driver.active(https://example.com/ok)",
          "driver.failed(https://example.com/missing: no manifest)",
          "driver.failed(https://example.com/slow: driver did not reach driver.active within 50 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.)",
          "driver.idle()",
        ],
        calls: [
          "fetchManifest https://example.com/ok",
          "attach https://example.com/ok",
          "detach",
          "fetchManifest https://example.com/missing",
          "fetchManifest https://example.com/slow",
          "fetchManifest https://example.com/slow",
        ],
      },
      session: {
        ends: [
          "media.active(transport=transport.open(socket) producers=Items(1){cam=producer.active(rtp paused)})",
          "media.idle(transport=transport.closed(no socket) producers=Items(0){})",
        ],
        calls: [
          "connect",
          "produce cam",
          "produce mic",
          // pause: cam stays active, and its update handler pauses the producer
          "pause producer cam",
          // removeProducer
          "close producer mic",
          // close aborts this one; then cam, which leaves active, and the open transport exit
          "produce slow",
          "close producer cam",
          "close socket",
        ],
      },
    });
  });
});
