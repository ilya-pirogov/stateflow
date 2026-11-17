import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  HandlerResult,
  type Items,
  listHandlers,
  listStates,
  mockHandlers,
  StateResult,
  setHandlersDisabled,
} from "..";

describe("listStates and listHandlers", () => {
  const add = defineSignal<{ id: string }>("add");
  const load = defineSignal("load");
  const tick = defineSignal("tick");

  type Track = { id: string; n: number };
  const track = defineState<Track>()
    .name("track")
    .signals({ tick })
    .variant("idle", { initial: true })
    .variant("playing")
    .build();
  defineFlow(track.idle, { tick: (t) => track.playing(t) });
  // track.playing has no reducer.

  type Player = { url: string; tracks: Items<typeof track> };
  const player = defineState<Player>()
    .name("player")
    .signals({ add, load, tick })
    .variant("empty", { initial: true })
    .variant("loading", { transitional: true })
    .variant("ready", { async: true, results: { loaded: (data) => data as { url: string } } })
    .variant("failed")
    .build();
  defineFlow(
    player.empty,
    {
      load: (p) => StateResult.transition(player.ready(p), player.loading(p), player.failed(p)),
      add: (p, { id }) => ({ ...p, tracks: p.tracks.with(id, track.idle({ id, n: 0 })) }),
    },
    { loaded: (p, { url }) => ({ ...p, url }) },
  );
  defineFlow(player.ready, { tick: (p) => p }, { loaded: (p, { url }) => ({ ...p, url }) });

  const make = () => ({ player: { url: "", tracks: track.items() } });

  it("lists a flow with nested states and an Items collection, in the caller's and the declarations' order", () => {
    expect(listStates([player, track])).toStrictEqual([
      {
        name: "player",
        signals: ["add", "load", "tick"],
        variants: [
          { name: "empty", initial: true, transitional: false, async: false, signals: ["load", "add"], results: [] },
          { name: "loading", initial: false, transitional: true, async: false, signals: [], results: [] },
          { name: "ready", initial: false, transitional: false, async: true, signals: ["tick"], results: ["loaded"] },
          { name: "failed", initial: false, transitional: false, async: false, signals: [], results: [] },
        ],
      },
      {
        name: "track",
        signals: ["tick"],
        variants: [
          { name: "idle", initial: true, transitional: false, async: false, signals: ["tick"], results: [] },
          { name: "playing", initial: false, transitional: false, async: false, signals: [], results: [] },
        ],
      },
    ]);
    // A nested definition the caller does not name is not listed.
    expect(listStates([player]).map((s) => s.name)).toStrictEqual(["player"]);
  });

  it("lists variants as the definition's keys go, integer names first, and no signal mapped to undefined", () => {
    const go = defineSignal("go");
    const stop = defineSignal("stop");
    const numbered = defineState()
      .name("numbered")
      .signals({ go, stop })
      .variant("b", { initial: true })
      .variant("2")
      .variant("1")
      .build();
    // defineFlow takes undefined under a signal's name without a cast; dispatching it finds no reducer.
    defineFlow(numbered.b, { go: undefined, stop: (s) => numbered[1](s) });
    const [listed] = listStates([numbered]);
    // The order the engine itself walks a definition's variants in: Object.keys of the definition.
    expect(listed.variants.map((v) => v.name)).toStrictEqual(Object.keys(numbered));
    expect(listed.variants.map((v) => v.name)).toStrictEqual(["1", "2", "b"]);
    expect(listed.variants.find((v) => v.name === "b")?.signals).toStrictEqual(["stop"]);
  });

  it("lists the handlers registered on a target, nested states' included, by variant, then kind", () => {
    const target = make();
    const onLoad = async () => HandlerResult.ok();
    applyFlow(target, [player], (sm) => {
      sm.addEnterHandler(track.playing, function startTrack() {
        return HandlerResult.ok();
      });
      sm.addTransitionHandler(player.ready, onLoad);
      sm.addExitHandler(track.playing, () => HandlerResult.ok());
      sm.addEnterHandler(track.playing, () => HandlerResult.ok(), { [Symbol.toStringTag]: "Deck" });
      sm.addCommitHandler(player.ready, () => {});
    });
    expect(listHandlers(target)).toStrictEqual([
      { variant: "track.playing", kind: "enter", name: "startTrack" },
      { variant: "track.playing", kind: "enter", name: "Deck." },
      { variant: "track.playing", kind: "exit", name: "" },
      { variant: "player.ready", kind: "transition", name: "onLoad" },
      { variant: "player.ready", kind: "commit", name: "" },
    ]);
  });

  it("lists each target's own handlers when one definition is applied to two", () => {
    const a = make();
    const b = make();
    applyFlow(a, [player], (sm) => sm.addCommitHandler(player.empty, function announce() {}));
    applyFlow(b, [player], (sm) => sm.addExitHandler(player.empty, () => HandlerResult.ok()));
    expect(listHandlers(a)).toStrictEqual([{ variant: "player.empty", kind: "commit", name: "announce" }]);
    expect(listHandlers(b)).toStrictEqual([{ variant: "player.empty", kind: "exit", name: "" }]);
  });

  it("lists the registrations, not the mocks, with the handlers-off switch on or off", () => {
    const target = make();
    applyFlow(target, [player], (sm) =>
      sm.addEnterHandler(track.idle, function enterIdle() {
        return HandlerResult.ok();
      }),
    );
    const registered = [{ variant: "track.idle", kind: "enter", name: "enterIdle" }];
    using _mock = mockHandlers(track.idle, {
      enter: function mocked() {
        return HandlerResult.ok();
      },
    });
    expect(listHandlers(target)).toStrictEqual(registered);
    setHandlersDisabled(true);
    try {
      expect(listHandlers(target)).toStrictEqual(registered);
    } finally {
      setHandlersDisabled(false);
    }
  });

  it("throws for a target with no flow, as every other call on one does", () => {
    expect(() => listHandlers({})).toThrow("doesn't contain state flows");
  });

  it("returns data that survives a JSON round trip unchanged", () => {
    const target = make();
    applyFlow(target, [player], (sm) =>
      sm.addEnterHandler(track.idle, function enterIdle() {
        return HandlerResult.ok();
      }),
    );
    const states = listStates([player, track]);
    const handlers = listHandlers(target);
    expect(JSON.parse(JSON.stringify(states))).toStrictEqual(states);
    expect(JSON.parse(JSON.stringify(handlers))).toStrictEqual(handlers);
  });
});
