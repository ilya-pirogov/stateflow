import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addFlowTap,
  applyFlow,
  Box,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  type FlowConfig,
  HandlerResult,
  type InstanceOf,
  lock,
  StateResult,
  watch,
} from "@state-flow/core";
import { describe, expect, it } from "vitest";
import { Player, recordingWorld, Session } from "../../../core/examples/examples";
import { definitions, subject } from "../../../core/examples/flows";
import { dryRun, flowReport, handlersOff, printStates, recordSessions, reportChanges, TestClock } from "..";
import { compareJson } from "../compare";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const checkedIn = path("../../../core/examples/report.txt");
// The examples keep their signals to themselves; a signal made by name reaches the reducers of that name.
const open = defineSignal("open");
const addProducer = defineSignal<{ key: string; track: Box<{ id: string }> }>("addProducer");
const removeProducer = defineSignal<{ key: string }>("removeProducer");
const stop = defineSignal("stop");
const close = defineSignal("close");

/** The calls of handlers on `target` that the tap is told, as "<kind> <node> <name>", until the returned function is called. */
function handledOn(target: object): { told: string[]; remove: () => void } {
  const told: string[] = [];
  const remove = addFlowTap({
    dispatched() {},
    handled(handledTarget, kind, call) {
      if (handledTarget === target) {
        told.push(`${kind} ${call.name}`);
      }
    },
    ended() {},
  });
  return { told, remove };
}

describe("the flow report", () => {
  it("of the engine's examples is checked in and current", () => {
    expect(reportChanges(readFileSync(checkedIn, "utf8"), flowReport(definitions))).toEqual({
      stale: false,
      added: [],
      removed: [],
    });
  });
  it("gives one sorted fact per line, and a change of the model as the lines it adds and removes", () => {
    const toggle = defineSignal("toggle");
    const lamp = defineState<{ watts: number }>()
      .name("lamp")
      .signals({ toggle })
      .variant("on", { results: { dimmed: (data) => data as { watts: number } } })
      .variant("off", { initial: true })
      .build();
    defineFlow(lamp.off, { toggle: (s) => lamp.on(s) });
    defineFlow(lamp.on, { toggle: (s) => lamp.off(s) }, { dimmed: (s, { watts }) => ({ ...s, watts }) });
    const report = flowReport([lamp]);
    expect(report).toBe(
      [
        "lamp.off",
        "lamp.off initial",
        "lamp.off reducer toggle",
        "lamp.on",
        "lamp.on reducer toggle",
        "lamp.on result dimmed",
        "",
      ].join("\n"),
    );
    const older = report.replace("lamp.on result dimmed\n", "lamp.on result bright\n").replaceAll("\n", "\r\n");
    expect(reportChanges(older, report)).toEqual({
      stale: true,
      added: ["lamp.on result dimmed"],
      removed: ["lamp.on result bright"],
    });
  });
});

describe("dryRun", () => {
  it("tells what a signal would do in three states of the session, with the real object unchanged and no handler run", async () => {
    const { world, calls } = recordingWorld();
    const idle = new Session(world);
    const transition = await dryRun(idle, open(), definitions, subject.build);
    expect(transition).toMatchObject({
      result: { kind: "InTransition", message: null, code: null },
      transition: "temp",
      changes: [{ node: "media" }],
      handlers: [{ variant: "transport.open", kind: "transition", name: "connect" }],
      fired: [],
    });
    expect(JSON.parse(transition.changes[0]?.next ?? "")).toMatchObject({ $state: "media.opening" });
    const session = new Session(world);
    await session.open();
    await session.addProducer("cam", { id: "cam" });
    const [before, callsBefore] = [printStates(session), [...calls]];
    const plain = await dryRun(session, removeProducer({ key: "cam" }), definitions, subject.build);
    expect(plain).toMatchObject({
      result: { kind: "OK", message: null, code: null },
      changes: [{ node: "media" }, { node: "media.producers[cam]", next: '{"$undefined":true}' }],
      handlers: [{ variant: "producer.active", kind: "exit", name: "closeProducer" }],
    });
    expect(plain.transition).toBeUndefined();
    const refused = await dryRun(
      session,
      addProducer({ key: "cam", track: Box.of({ id: "cam" }) }),
      definitions,
      subject.build,
    );
    expect(refused).toMatchObject({
      result: { kind: "Rejected", message: "cam already exists" },
      changes: [],
      handlers: [],
    });
    expect(printStates(session)).toBe(before);
    expect(calls).toEqual(callsBefore);
  });
  it("names what the step would fire as a session record does", async () => {
    // A watch the builder registers on what it builds, asking for its callback at every commit.
    const watched = (flow: Parameters<typeof subject.build>[0]) => {
      const target = subject.build(flow);
      watch(
        target,
        () => true,
        function mediaMoved() {},
      );
      return target;
    };
    const answer = await dryRun(watched({ timers: new TestClock() }), open(), definitions, watched);
    expect(answer.fired).toEqual([{ node: "media", observer: "watch:mediaMoved" }]);
  });
  it("is refused with the reason while a transition is pending", async () => {
    const player = new Player(recordingWorld().world);
    const playing = player.play("https://example.com/slow").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The builder is never called: the refusal comes first.
    await expect(dryRun(player, stop(), definitions, subject.build)).rejects.toThrow(
      "a transition is pending on the target",
    );
    await player.stop();
    await playing;
    await expect(dryRun(player, stop(), definitions, subject.build)).resolves.toMatchObject({
      result: { kind: "Ignored" },
    });
  });
  it("leaves the target's own handlers on while it waits, for the target and for another object", async () => {
    const { world, calls } = recordingWorld();
    const [session, other] = [new Session(world), new Session(world)];
    const opened = (async () => {
      await Promise.resolve();
      await Promise.resolve();
      return other.open();
    })();
    await Promise.all([dryRun(session, open(), definitions, subject.build), session.open(), opened]);
    expect(calls).toEqual(["connect", "connect"]);
    const active = "media.active(transport=transport.open(socket) producers=Items(0){})";
    expect([String(session.media), String(other.media)]).toEqual([active, active]);
  });
  it("lists the handlers the real step calls, in its order: the work's transition handlers and the exits", async () => {
    const session = new Session(recordingWorld().world);
    await session.open();
    const adding = await dryRun(
      session,
      addProducer({ key: "cam", track: Box.of({ id: "cam" }) }),
      definitions,
      subject.build,
    );
    expect(adding.handlers).toEqual([{ variant: "producer.active", kind: "transition", name: "produce" }]);
    await session.addProducer("cam", { id: "cam" });
    await session.addProducer("mic", { id: "mic" });
    const closing = await dryRun(session, close(), definitions, subject.build);
    const { told, remove } = handledOn(session);
    await session.close();
    remove();
    expect(told).toEqual(["exit media.producers[mic]", "exit media.producers[cam]", "exit media.transport"]);
    expect(closing.handlers.map(({ variant, name }) => `${variant} ${name}`)).toEqual([
      "producer.active closeProducer",
      "producer.active closeProducer",
      "transport.open closeSocket",
    ]);
  });
  it("lists no update handler of a node that changed only because a nested state in it changed", async () => {
    const bump = defineSignal("bump");
    const kid = defineState<{ n: number }>().name("kid").signals({ bump }).variant("on", { initial: true }).build();
    const mom = defineState<{ kid: InstanceOf<typeof kid> }>()
      .name("mom")
      .signals({ bump })
      .variant("on", { initial: true })
      .build();
    defineFlow(kid.on, { bump: (s) => kid.on({ n: s.n + 1 }) });
    defineFlow(mom.on, { bump: () => StateResult.ignored() });
    const build = (flow: FlowConfig) => {
      const target = { mom: { kid: kid.on({ n: 0 }) } };
      applyFlow(
        target,
        [mom],
        (sm) => {
          sm.addUpdateHandler(mom.on, function momUpdate() {
            return HandlerResult.ok();
          });
          sm.addUpdateHandler(kid.on, function kidUpdate() {
            return HandlerResult.ok();
          });
        },
        flow,
      );
      return target;
    };
    const target = build({});
    const answer = await dryRun(target, bump(), [mom, kid], build);
    const { told, remove } = handledOn(target);
    {
      await using send = await lock(target);
      await send(bump()).done();
    }
    remove();
    expect(told).toEqual(["update mom.kid"]);
    expect(answer.handlers).toEqual([{ variant: "kid.on", kind: "update", name: "kidUpdate" }]);
  });
  it("answers for the signal alone when the build sends one, a transition included", async () => {
    const go = defineSignal("go");
    const bump = defineSignal("bump");
    const box = defineState<{ n: number }>().name("goBox").signals({ go }).variant("a", { initial: true }).build();
    const aux = defineState<{ k: number }>().name("bumpBox").signals({ bump }).variant("on", { initial: true }).build();
    defineFlow(box.a, { go: (s) => ({ n: s.n + 1 }) });
    defineFlow(aux.on, { bump: (s) => ({ k: s.k + 1 }) });
    const make = (sendInBuild: boolean) => (flow: FlowConfig) => {
      const target = { goBox: { n: 0 }, bumpBox: { k: 0 } };
      applyFlow(
        target,
        [box, aux],
        (sm) => {
          sm.addUpdateHandler(box.a, function goUpdate() {
            return HandlerResult.ok();
          });
          sm.addUpdateHandler(aux.on, function bumpUpdate() {
            return HandlerResult.ok();
          });
        },
        flow,
      );
      if (sendInBuild) {
        dispatch(target, bump());
      }
      return target;
    };
    const target = make(false)({});
    const sending = await dryRun(target, go(), [box, aux], make(true));
    expect(sending.handlers.map(({ name }) => name)).toEqual(["goUpdate"]);
    const opening = (flow: FlowConfig & { timers: TestClock }) => {
      const second = subject.build(flow);
      dispatch(second, open());
      return second;
    };
    const closing = await dryRun(new Session(recordingWorld().world), close(), definitions, opening);
    expect(closing.handlers.map(({ name }) => name)).toEqual(["closeSocket"]);
  });
});

it("compareJson lists the paths where two JSON values differ, with each side", () => {
  expect(compareJson({ a: [1, 2], b: { c: "x" } }, { a: [1, 3], b: {}, d: null })).toEqual([
    { path: ["a", "1"], left: 2, right: 3 },
    { path: ["b", "c"], left: "x", right: undefined },
    { path: ["d"], left: undefined, right: null },
  ]);
  expect(compareJson([], {})).toEqual([{ path: [], left: [], right: {} }]);
  expect(compareJson({ a: [1] }, { a: [1] })).toEqual([]);
});

describe("the command, from a shell, on the engine's examples", { timeout: 60_000 }, () => {
  const viteNode = path("../../../../node_modules/vite-node/vite-node.mjs");
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [viteNode, "--config", path("../../vitest.config.ts"), path("../flow-command.ts"), ...args],
      {
        encoding: "utf8",
      },
    );
  const module = path("../../../core/examples/flows.ts");
  const dir = mkdtempSync(join(tmpdir(), "flow-command-"));
  it("describe writes the report, and with --check fails on a stale one", () => {
    const report = join(dir, "report.txt");
    expect(run("describe", module, report).status).toBe(0);
    expect(readFileSync(report, "utf8")).toBe(readFileSync(checkedIn, "utf8"));
    writeFileSync(report, readFileSync(checkedIn, "utf8").replace("media.idle reducer open\n", ""));
    const stale = run("describe", module, report, "--check");
    expect([stale.status, JSON.parse(stale.stdout)]).toEqual([
      1,
      { stale: true, added: ["media.idle reducer open"], removed: [] },
    ]);
  });
  it("dry-run answers for states given as a print, and fails on states that hold a transitional variant", async () => {
    const session = new Session(recordingWorld().world);
    await session.open();
    await session.addProducer("cam", { id: "cam" });
    const states = join(dir, "states.json");
    writeFileSync(states, printStates(session));
    const answer = run("dry-run", module, states, "removeProducer", '{"key":"cam"}');
    expect(answer.status).toBe(0);
    expect(JSON.parse(answer.stdout)).toMatchObject({
      result: { kind: "OK" },
      changes: [{ node: "media" }, { node: "media.producers[cam]" }],
      handlers: [],
    });
    writeFileSync(states, printStates(session).replace('"$state":"media.active"', '"$state":"media.opening"'));
    const refused = run("dry-run", module, states, "close", "{}");
    expect([refused.status, refused.stdout]).toEqual([1, ""]);
  });
  it("prints its answer alone on stdout when the module it loads writes to the console", () => {
    const loud = join(dir, "loud.ts");
    writeFileSync(loud, `export { definitions, subject } from ${JSON.stringify(module)};\nconsole.log("loaded");\n`);
    const checked = run("describe", loud, checkedIn, "--check");
    expect([checked.status, JSON.parse(checked.stdout)]).toEqual([0, { stale: false, added: [], removed: [] }]);
    expect(checked.stderr).toContain("loaded");
  });
  it("walk prints the walk's report", () => {
    const walked = run("walk", module, '{"depth":3,"runs":1,"runLength":4,"seed":1}');
    expect(walked.status).toBe(0);
    expect(JSON.parse(walked.stdout)).toMatchObject({ seed: 1, failure: null });
  });
  it("replay prints a record's differences, and compare those of two prints", async () => {
    const record = join(dir, "record.json");
    const [first, second] = [join(dir, "first.json"), join(dir, "second.json")];
    {
      using _off = handlersOff();
      using recording = recordSessions();
      const clock = new TestClock();
      const target = subject.build({ timers: clock });
      await clock.send(target, open());
      writeFileSync(first, printStates(target));
      await clock.send(target, addProducer({ key: "cam", track: Box.of({ id: "cam" }) }));
      writeFileSync(second, printStates(target));
      writeFileSync(record, recording.record(target));
    }
    const replayed = run("replay", module, record);
    expect([replayed.status, JSON.parse(replayed.stdout)]).toEqual([0, []]);
    const same = run("compare", first, first);
    expect([same.status, JSON.parse(same.stdout)]).toEqual([0, []]);
    const differ = run("compare", first, second);
    expect(differ.status).toBe(1);
    expect(JSON.parse(differ.stdout)).toEqual(
      compareJson(JSON.parse(readFileSync(first, "utf8")), JSON.parse(readFileSync(second, "utf8"))),
    );
    expect(JSON.parse(differ.stdout).length).toBeGreaterThan(0);
  });
});
