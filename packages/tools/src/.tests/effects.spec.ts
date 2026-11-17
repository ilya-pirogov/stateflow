import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listHandlers } from "@state-flow/core";
import { describe, expect, it } from "vitest";
import { Player, recordingWorld, Session } from "../../../core/examples/examples";
import { listEffects } from "../effects.ts";

const examples = fileURLToPath(new URL("../../../core/examples/examples.ts", import.meta.url));
const source = readFileSync(examples, "utf8");
const listed = (text: string) => listEffects(examples, text, ["world"]);
/** The lines in `after` that are not in `before`. */
const added = (before: string[], after: string[]) => after.filter((line) => !before.includes(line));

describe("the list of effects", () => {
  it("lists each handler of the engine's examples with its calls on the world, and the checked-in list is current", () => {
    const checkedIn = fileURLToPath(new URL("../../../core/examples/effects.txt", import.meta.url));
    // A checkout under git's autocrlf has CRLF line ends.
    expect(readFileSync(checkedIn, "utf8").replaceAll("\r\n", "\n")).toBe(`${listed(source).sort().join("\n")}\n`);
  });

  it("lists the handlers listHandlers gives for the examples' objects, by kind and name", () => {
    const { world } = recordingWorld();
    const registered = [new Player(world), new Session(world)]
      .flatMap((target) => listHandlers(target))
      .map(({ kind, name }) => `${kind} ${name}`);
    const statics = listed(source)
      // The counter registers its handlers inside its run function, on a target no caller reaches.
      .filter((line) => !line.startsWith("second."))
      // "<variant> <kind> <name>: <uses>": the variant is the registration's text, which the engine does not know.
      .map((line) => line.slice(line.indexOf(" ") + 1, line.indexOf(":")));
    expect(statics.sort()).toEqual(registered.sort());
  });

  it("changes exactly one line for a new call on the world in a handler, and for a new handler", () => {
    const before = listed(source);
    const call = listed(source.replace("world.detach();", 'world.detach();\n        world.notify("detached");'));
    const handler = listed(
      source.replace(
        "sm.addExitHandler(driverState.active,",
        "sm.addCommitHandler(driverState.failed, function announceFailure() {});\n      sm.addExitHandler(driverState.active,",
      ),
    );
    expect([added(before, call), added(call, before)]).toEqual([
      ["driverState.active exit detach: world.detach world.notify"],
      ["driverState.active exit detach: world.detach"],
    ]);
    expect([added(before, handler), added(handler, before)]).toEqual([
      ["driverState.failed commit announceFailure:"],
      [],
    ]);
  });

  it("names a world kept in a field as the caller writes it, and follows a name to its declaration among the file's statements", () => {
    const text = `function other() { const onEnter = () => world.wrong(); }
{ const onEnter = () => world.wrong(); }
for (const onEnter of []) world.wrong();
function onEnter(): void;
function onEnter() { world.right(); this.world.light(); }
sm.addEnterHandler(s.a, onEnter);`;
    expect(listEffects("a.ts", text, ["world", "this.world"])).toEqual([
      "s.a enter onEnter: world.right this.world.light",
    ]);
  });

  it("follows a handler given by name, lists every world named, and writes each variant as its registration does", () => {
    const text = `
import { playerState } from "./states";
const track = defineState<{ url: string }>().name("track").variant("on", { initial: true }).build();
function onEnter() { device.start(); }
const onExit = () => device?.stop();
applyFlow(this, [track], (sm) => {
  sm.addEnterHandler(track.on, onEnter);
  sm.addExitHandler(track.on, onExit);
  sm.addUpdateHandler(playerState.ready, () => HandlerResult.ok().onCommit(() => world.light(false)));
  sm.addCommitHandler(track.on, this.onCommit.bind(this));
  sm.addTransitionHandler(track.on, async function load(next) { await device.load(next.url); world.notify(device.name); return other.load(); });
});`;
    expect(listEffects("a.ts", text, ["world", "device"])).toEqual([
      "track.on enter onEnter: device.start",
      "track.on exit onExit: device.stop",
      "playerState.ready update : world.light",
      "track.on commit this.onCommit.bind(this):",
      "track.on transition load: device.load world.notify device.name",
    ]);
  });
});

describe("the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "effects-"));
  const [out, a, b] = [join(dir, "effects.txt"), join(dir, "a.ts"), join(dir, "b.ts")];
  writeFileSync(a, "sm.addEnterHandler(track.on, function on() { world.light(true); });\n");
  writeFileSync(b, "sm.addExitHandler(track.on, function off() { device.stop(); });\n");
  const command = fileURLToPath(new URL("../list-effects.ts", import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, [command, ...args], { encoding: "utf8" });

  // Node runs a TypeScript file as it is from 22.18; the gate also runs on Node versions that cannot.
  it.runIf(process.features.typescript)(
    "writes every file's lines sorted, and with --check fails on a stale list",
    () => {
      run("--world", "world", "--world", "device", "--out", out, b, a);
      expect(readFileSync(out, "utf8")).toBe("track.on enter on: world.light\ntrack.on exit off: device.stop\n");
      expect(run("--check", "--world", "world", "--world", "device", "--out", out, a, b)).toBe("");
      expect(() => run("--check", "--world", "world", "--out", out, a, b)).toThrow(
        expect.objectContaining({
          status: 1,
          stdout: `${out} is stale: run the command without --check to write it.\n`,
        }),
      );
      // A checkout that turned line ends into CRLF holds the same list.
      writeFileSync(out, readFileSync(out, "utf8").replaceAll("\n", "\r\n"));
      expect(run("--check", "--world", "world", "--world", "device", "--out", out, a, b)).toBe("");
    },
  );
});
