import { EventEmitter } from "node:events";
import {
  applyFlow,
  Box,
  disposeFlow,
  HandlerResult,
  type Infer,
  mockHandlers,
  SIGNALS,
  stateVar,
  type TransitionHandler,
} from "@state-flow/core";
import { describe, expect, it, vi } from "vitest";
import { driverState, type Manifest, media, producer, transport } from "../../../core/examples/examples";
import { handlersOff, neverAnswers, recordEvents, standIn, TestClock } from "..";

// The examples' signals, as their definitions carry them.
const { play } = driverState[SIGNALS];
const { addProducer, removeProducer } = media[SIGNALS];
/** examples.ts's player, built by the test so its flow takes the clock, with an emitter for its events. */
class PlayerTarget extends EventEmitter {
  readonly driver: Infer<typeof driverState> = { url: "", manifest: null };
}
/** examples.ts's session, built the same way. */
class SessionTarget extends EventEmitter {
  readonly media: Infer<typeof media> = { transport: transport.closed({ socket: null }), producers: producer.items() };
}
describe("harness", () => {
  it("drives a player and a session on one clock, handlers off, with scripted, refused and silent answers", async () => {
    using _off = handlersOff();
    const clock = new TestClock();
    const worldCalls: string[] = [];
    // The player's world answers in turn: it refuses, never answers, then gives a manifest.
    const manifest: Manifest = { url: "https://example.com/c", tracks: ["video"] };
    const answers = vi
      .fn<TransitionHandler<typeof driverState.active>>()
      .mockImplementationOnce(async () => HandlerResult.rejected("no manifest"))
      .mockImplementationOnce(neverAnswers)
      .mockImplementationOnce(async () => driverState.active.results.loaded({ manifest }));
    using _playerWorld = mockHandlers(driverState.active, { transition: answers });
    const mic = standIn({
      close() {
        worldCalls.push("close mic");
      },
      pause() {},
      resume() {},
    });
    using _sessionWorld = mockHandlers(producer.active, {
      transition: async () => producer.active.results.created({ producer: mic }),
    });
    // Handlers that would touch the world; with handlers off none runs.
    const player = new PlayerTarget();
    applyFlow(
      player,
      [driverState],
      (sm) => {
        sm.addEnterHandler(driverState.active, () => {
          worldCalls.push("attach");
          return HandlerResult.ok();
        });
        sm.defineEvent(
          "driver",
          (cur, prev) => cur.driver !== prev.driver,
          (cur) => String(cur.driver),
        );
      },
      { timers: clock },
    );
    // The session starts open and sending cam: no step and no handler runs for a given start.
    const socket = standIn({
      close() {
        worldCalls.push("close socket");
      },
    });
    const cam = standIn({
      close() {
        worldCalls.push("close cam");
      },
      pause() {},
      resume() {},
    });
    const camProducer = producer.active({ track: Box.of({ id: "cam" }), producer: cam, paused: false });
    const start = media.active({
      transport: transport.open({ socket }),
      producers: producer.items().with("cam", camProducer),
    });
    const session = new SessionTarget();
    applyFlow(
      session,
      [media],
      (sm) => {
        sm.addExitHandler(producer.active, (p) => {
          p.producer?.deref().close();
          return HandlerResult.ok();
        });
        sm.defineEvent(
          "producers",
          (cur, prev) => cur.media.producers !== prev.media.producers,
          (cur) => Object.fromEntries([...cur.media.producers].map(([key, p]) => [key, String(stateVar(p))])),
        );
      },
      { timers: clock, start: { media: start } },
    );
    const playerEvents = recordEvents(player, "driver");
    const sessionEvents = recordEvents(session, "producers");
    // Refused: failed holds the refusal; the events wait for the clock.
    await clock.send(player, play({ url: "https://example.com/a" }));
    // send ran the clock, so its events were delivered.
    expect(playerEvents).toHaveLength(2);
    // One wait for both: the session adds mic while the player waits for an answer that never comes.
    const playing = clock.send(player, play({ url: "https://example.com/b", timeoutMs: 500 }));
    await clock.send(session, addProducer({ key: "mic", track: Box.of({ id: "mic" }) }));
    expect(stateVar(player.driver)).toBe(driverState.activating);
    // The timeout runs on the clock: 499 ms keep the play waiting, the 500th ends it.
    await clock.advance(499);
    expect(stateVar(player.driver)).toBe(driverState.activating);
    await clock.advance(1);
    await playing;
    // Scripted: the third answer gives the manifest.
    await clock.send(player, play({ url: "https://example.com/c" }));
    expect(player.driver.manifest).toBe(manifest);
    // The engine disposes cam's stand-in once a commit drops it, and the rest at disposeFlow; no exit handler ran.
    await clock.send(session, removeProducer({ key: "cam" }));
    expect(cam.deref().disposals).toBe(1);
    disposeFlow(session);
    disposeFlow(player);
    expect([socket, mic, cam].map((box) => box.deref().disposals)).toEqual([1, 1, 1]);
    expect(worldCalls).toEqual([]);
    expect(playerEvents.map(([, payload]) => payload)).toEqual([
      "driver.activating(https://example.com/a)",
      "driver.failed(https://example.com/a: no manifest)",
      "driver.activating(https://example.com/b)",
      "driver.failed(https://example.com/b: driver did not reach driver.active within 500 ms [SF035] Make the work answer sooner or raise timeoutMs; release what it acquired on abort.)",
      "driver.activating(https://example.com/c)",
      "driver.active(https://example.com/c)",
    ]);
    expect(sessionEvents.map(([, payload]) => payload)).toEqual([
      { cam: "producer.active", mic: "producer.creating" },
      { cam: "producer.active", mic: "producer.active" },
      { mic: "producer.active" },
    ]);
  });
});
