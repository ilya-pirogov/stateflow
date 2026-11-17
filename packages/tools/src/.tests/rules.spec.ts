import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkSources } from "../rules.ts";

/** The rule and line of each finding in `text`, read as a file named a.ts. */
function found(text: string): Array<[rule: string, line: number]> {
  return checkSources([["a.ts", text]]).map((f) => [f.rule, f.line]);
}

describe("unnamed-handler", () => {
  it("finds an arrow and an anonymous function registered as handlers, wrapped or destructured too", () => {
    const text = `
sm.addEnterHandler(state.on, () => world.light(true));
sm.addTransitionHandler(state.loading, async function (next) { return load(next); });
sm.addEnterHandler(state.on, ((x) => x));
sm.addEnterHandler(state.on, (() => go()) as never);
applyFlow(target, [state], ({ addExitHandler }) => addExitHandler(state.on, () => go()));`;
    expect(found(text)).toEqual([
      ["unnamed-handler", 2],
      ["unnamed-handler", 3],
      ["unnamed-handler", 4],
      ["unnamed-handler", 5],
      ["unnamed-handler", 6],
    ]);
  });

  it("passes a declaration, a const, a named function expression and a bound method", () => {
    const text = `
function onEnter() {}
const onExit = () => {};
sm.addEnterHandler(state.on, onEnter);
sm.addExitHandler(state.on, onExit);
sm.addUpdateHandler(state.on, function onUpdate() {});
sm.addCommitHandler(state.on, this.onCommit.bind(this));`;
    expect(found(text)).toEqual([]);
  });
});

describe("catch-around-lock", () => {
  it("finds a lock taken in the statements of a try block that has a catch", () => {
    const text = `
async function play(target) {
  try {
    await using send = await lock(target);
    await send(signals.play()).done();
  } catch (e) {
    console.log(e);
  }
}`;
    expect(found(text)).toEqual([["catch-around-lock", 4]]);
  });

  it("passes a lock under try/finally, in a finally block, in a catch block and in a function defined in a try", () => {
    const text = `
async function play(target) {
  try { const send = await lock(target); } finally { await lock(target); }
  try { work(); } catch { await lock(target); }
  try { register(async () => { await using send = await lock(target); }); } catch (e) { log(e); }
}`;
    expect(found(text)).toEqual([]);
  });

  it("passes a lock in a function called at once or given to then, awaited or not, and in a parenthesised argument", () => {
    const text = `
async function play(target) {
  (async () => { await using send = await lock(target); })().catch(log);
  try { (async () => { await using send = await lock(target); })(); } catch (e) { log(e); }
  try { await (async () => { await using send = await lock(target); })(); } catch (e) { log(e); }
  try { await ready.then(async () => { await using send = await lock(target); }); } catch (e) { log(e); }
  try { register((async () => { await using send = await lock(target); })); } catch (e) { log(e); }
}`;
    expect(found(text)).toEqual([]);
  });
});

describe("bare-dispatch", () => {
  it("finds a dispatch outside setup, in a handler or a timer written in setup, to another object in a constructor, and without abort: true of its own", () => {
    const text = `
dispatch(target, signals.play());
dispatch(target, signals.stop(), { abort: false });
applyFlow(target, [state], (sm) => {
  sm.addEnterHandler(state.on, function redispatch() { dispatch(target, signals.next()); });
  setTimeout(() => dispatch(target, signals.tick()), 10);
});
class Driver { constructor(player) { dispatch(player, signals.driverReady()); } }
dispatch(target, signals.stop(), { meta: { abort: true } });
dispatch(target, signals.stop(), { mute: true /* abort: true later */ });`;
    expect(found(text)).toEqual([
      ["bare-dispatch", 2],
      ["bare-dispatch", 3],
      ["bare-dispatch", 5],
      ["bare-dispatch", 6],
      ["bare-dispatch", 8],
      ["bare-dispatch", 9],
      ["bare-dispatch", 10],
    ]);
  });

  it("tells the reader to send under the lock unless the place is one of the four dispatch's doc allows", () => {
    const text = `window.addEventListener("pagehide", function onHide() { dispatch(player, signals.dispose()); });`;
    const [finding] = checkSources([["a.ts", text]]);
    expect(finding?.rule).toBe("bare-dispatch");
    expect(finding?.fix).toMatch(
      /^Send under the lock .* unless .*applyFlow's setup.*constructor's dispatch to this.*abort: true.*synchronous teardown/,
    );
  });

  it("passes a dispatch in applyFlow's setup, inline or by name, or a constructor, an abort with a plain or quoted key, a method and a one-argument dispatch", () => {
    const text = `
applyFlow(target, [state], (sm) => {
  dispatch(target, signals.reset());
});
function init(sm) { dispatch(target, signals.reset()); }
applyFlow(target, [state], init);
class Tape { constructor() { applyFlow(this, [state], this.setup); } setup(sm) { dispatch(this, signals.reset()); } }
class Player { constructor() { applyFlow(this, [state], init); dispatch(this, signals.boot()); } }
dispatch(target, signals.stop(), { mute: true, abort: true });
dispatch(target, signals.stop(), { "abort": true });
store.dispatch(action);
const [count, dispatch] = useReducer(reduce, 0);
dispatch({ type: "inc" });`;
    expect(found(text)).toEqual([]);
  });
});

describe("clock-in-reducer", () => {
  it("finds Date.now, performance.now, globalThis.Date.now and new Date() in a reducer written in defineFlow", () => {
    const text = `
defineFlow(state.idle, {
  seen: (s) => state.ready({ ...s, at: Date.now() }),
  timed: (s) => state.ready({ ...s, at: performance.now(), day: new Date() }),
  global: (s) => state.ready({ ...s, at: globalThis.Date.now() }),
  optional: (s) => state.ready({ ...s, at: performance?.now(), day: Date . now() }),
  window: (s) => state.ready({ ...s, at: window.Date.now(), day: self.performance.now() }),
});`;
    expect(found(text)).toEqual([
      ["clock-in-reducer", 3],
      ["clock-in-reducer", 4],
      ["clock-in-reducer", 4],
      ["clock-in-reducer", 5],
      ["clock-in-reducer", 6],
      ["clock-in-reducer", 6],
      ["clock-in-reducer", 7],
      ["clock-in-reducer", 7],
    ]);
  });

  it("passes a clock read outside defineFlow and a new Date of a given time in a reducer", () => {
    const text = `
const sent = signals.seen({ at: Date.now() });
defineFlow(state.idle, { seen: (s, sig) => state.ready({ ...s, day: new Date(sig.at) }) });`;
    expect(found(text)).toEqual([]);
  });
});

describe("import-in-state-file", () => {
  it("finds a value imported from a package other than the engine into a file that defines states", () => {
    const text = `import { applyFlow, defineState } from "@state-flow/core";\nimport { Device } from "device-sdk";\nimport * as media from "media-lib";\nimport { type Track, open } from "media-lib";\nimport "polyfill";\nconst s = defineState<{}>().name("s").variant("a", { initial: true }).build();`;
    expect(found(text)).toEqual([2, 3, 4, 5].map((line) => ["import-in-state-file", line]));
  });

  it("finds a relative import of a file given that defines no states, and passes one that defines states or signals", () => {
    const state = `import { defineState } from "@state-flow/core";\nimport { signals } from "./signals";\nimport { device } from "./device.js";\nimport { track } from "../track/state";\nimport { other } from "./not-given";\nconst s = defineState<{}>().name("s").build();`;
    const findings = checkSources([
      ["src/player/state.ts", state],
      ["src/player/signals.ts", `export const signals = { play: defineSignal("play") };`],
      ["src/player/device.ts", `export const device = navigator.mediaDevices;`],
      ["./src/track/state.ts", `export const track = defineFlow(t.on, {});`],
    ]);
    expect(findings.map((f) => [f.file, f.line])).toEqual([["src/player/state.ts", 3]]);
  });

  it("passes the engine, a relative path and a type-only import, and a file that defines no states", () => {
    const states = `import { defineFlow, defineState } from "@state-flow/core";\nimport { signals } from "./signals";\nimport { track } from "../track/state";\nimport type { Device } from "device-sdk";\ndefineFlow(state.idle, { play: (s) => s });`;
    const world = `import { Device } from "device-sdk";\napplyFlow(this, [state], (sm) => sm.addEnterHandler(state.on, function on() { new Device(); }));`;
    expect([found(states), found(world)]).toEqual([[], []]);
  });

  it("passes a file of handlers that declares its own signals, and a state file that imports them from it", () => {
    const handlers = `import { applyFlow, defineSignal } from "@state-flow/core";\nimport { Device } from "device-sdk";\nexport const signals = { play: defineSignal("play") };\napplyFlow(this, [state], (sm) => sm.addEnterHandler(state.on, function on() { new Device(); }));`;
    const state = `import { signals } from "./handlers";\nexport const s = defineFlow(t.on, { play: (x) => x });`;
    expect(
      checkSources([
        ["handlers.ts", handlers],
        ["state.ts", state],
      ]),
    ).toEqual([]);
  });

  it("names each finding's file as it was given", () => {
    const text = "sm.addEnterHandler(state.on, () => {});\n";
    const files = checkSources([
      ["./a/../b.ts", text],
      ["a\\b.ts", text],
    ]).map((f) => f.file);
    expect(files).toEqual(["./a/../b.ts", "a\\b.ts"]);
  });
});

describe("the package's entry", () => {
  // A consumer's specs compile the entry under their own options, which may have no Node types and no .ts imports.
  // The engine's own source needs Node's types under these options, so only this package's files are asked about.
  it("compiles with no Node types and without allowImportingTsExtensions", () => {
    const tools = fileURLToPath(new URL("..", import.meta.url));
    const entry = join(tools, "index.ts");
    const program = ts.createProgram([entry], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.esnext.disposable.d.ts", "lib.dom.d.ts"],
      paths: { "@state-flow/core": [fileURLToPath(new URL("../../../core/src/index.ts", import.meta.url))] },
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName.startsWith(tools))
      .map((d) => `${d.file?.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    expect(errors).toEqual([]);
  });
});

describe("the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "rules-"));
  const a = join(dir, "a.ts");
  const b = join(dir, "b.tsx");
  const clean = join(dir, "clean.ts");
  writeFileSync(a, "sm.addEnterHandler(state.on, () => {});\n");
  writeFileSync(b, "dispatch(target, signals.play());\n");
  writeFileSync(clean, "const x = 1;\n");

  // Node runs a TypeScript file as it is from 22.18; the gate also runs on Node versions that cannot.
  const command = fileURLToPath(new URL("../check-rules.ts", import.meta.url));
  it.runIf(process.features.typescript)("prints each finding of the files given and exits with 1, 0 on none", () => {
    const [first] = checkSources([[a, "sm.addEnterHandler(state.on, () => {});\n"]]);
    const [second] = checkSources([[b, "dispatch(target, signals.play());\n"]]);
    expect(() => execFileSync(process.execPath, [command, a, b], { encoding: "utf8" })).toThrow(
      expect.objectContaining({
        status: 1,
        stdout: `${a}:1 unnamed-handler: ${first?.fix}\n${b}:1 bare-dispatch: ${second?.fix}\n`,
      }),
    );
    expect(execFileSync(process.execPath, [command, clean], { encoding: "utf8" })).toBe("");
  });
});

describe("the engine's examples", () => {
  it("break no rule", () => {
    const examples = fileURLToPath(new URL("../../../core/examples/examples.ts", import.meta.url));
    expect(checkSources([[examples, readFileSync(examples, "utf8")]])).toEqual([]);
  });
});
