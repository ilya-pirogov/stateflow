import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const command = fileURLToPath(new URL("../mutate.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const engine = join(repo, "packages/core/src/index.ts");

// A small flow: dim is written in place and its spec tests both of its branches; boost is given by name and untested.
const flow = `import { defineFlow, defineSignal, defineState } from "${engine}";
export const signals = { dim: defineSignal<{ by: number }>("dim"), boost: defineSignal<{ by: number }>("boost") };
export const light = defineState<{ level: number }>().name("light").signals(signals).variant("on", { initial: true }).build();
function boost(s: { level: number }, { by }: { by: number }) { return { level: s.level + by > 10 ? 10 : s.level + by }; }
defineFlow(light.on, { dim: (s, { by }) => ({ level: s.level > by ? s.level - by : 0 }), boost });
`;
const spec = `import { applyFlow, dispatch } from "${engine}";
import { expect, it } from "vitest";
import { light, signals } from "./light.ts";
it("dims to the level less the step, and to 0 below it", () => {
  const target = { light: light.on({ level: 5 }) };
  applyFlow(target, [light], () => {});
  dispatch(target, signals.dim({ by: 2 })); expect(target.light.level).toBe(3);
  dispatch(target, signals.dim({ by: 9 })); expect(target.light.level).toBe(0);
});
`;

/** A new directory holding the flow as light.ts and its spec, which resolves "vitest" through a linked node_modules. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "mutate-"));
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "light.ts"), flow);
  writeFileSync(join(dir, "light.spec.ts"), spec);
  return dir;
}

/** Runs the command in `dir` on `file` with the test command `test` and the arguments after it. */
function mutate(dir: string, file: string, test: string, ...rest: string[]) {
  return spawnSync(process.execPath, [command, file, test, ...rest], { cwd: dir, encoding: "utf8" });
}

// A test command that passes at once while dim's condition is in the file and hangs while it is not.
const hangsOnDim = 'grep -q "s.level > by ?" light.ts || sleep 30';

/** Resolves once the command has written its first mutant over light.ts in `dir`. */
async function firstMutant(dir: string): Promise<void> {
  while (readFileSync(join(dir, "light.ts"), "utf8").includes("s.level > by ?")) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Node runs a TypeScript file as it is from 22.18; the gate also runs on Node versions that cannot.
describe.runIf(process.features.typescript)("the mutation command", () => {
  it("kills the mutants of a tested branch and names the survivors of an untested one", () => {
    const dir = fixture();
    const run = mutate(dir, "light.ts", `npx vitest run --root ${dir}`);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      baselineMs: expect.any(Number),
      limitMs: expect.any(Number),
      mutants: [
        { line: 4, column: 80, original: "s.level + by > 10", replacement: "true", exitCode: 0, outcome: "survived" },
        { line: 4, column: 80, original: "s.level + by > 10", replacement: "false", exitCode: 0, outcome: "survived" },
        { line: 5, column: 54, original: "s.level > by", replacement: "true", exitCode: 1, outcome: "killed" },
        { line: 5, column: 54, original: "s.level > by", replacement: "false", exitCode: 1, outcome: "killed" },
      ],
    });
    expect(readFileSync(join(dir, "light.ts"), "utf8")).toBe(flow);
    expect(existsSync(join(dir, "light.ts.unmutated"))).toBe(false);
  }, 60_000);
  it("stops a mutant's run at the time limit given and reports it killed with no exit code", () => {
    const dir = fixture();
    const run = JSON.parse(mutate(dir, "light.ts", hangsOnDim, "500").stdout);
    expect(run.limitMs).toBe(500);
    expect(run.mutants.map((m: { exitCode: number | null; outcome: string }) => [m.exitCode, m.outcome])).toEqual([
      [0, "survived"],
      [0, "survived"],
      [null, "killed"],
      [null, "killed"],
    ]);
  }, 60_000);
  it("tries no mutant when the tests fail on the unchanged file", () => {
    const dir = fixture();
    expect(mutate(dir, "light.ts", "false")).toMatchObject({
      status: 1,
      stdout: "",
      stderr: expect.stringContaining("The tests fail on the unchanged light.ts: false exited with 1."),
    });
    expect(readFileSync(join(dir, "light.ts"), "utf8")).toBe(flow);
    expect(existsSync(join(dir, "light.ts.unmutated"))).toBe(false);
  });
  it.each([
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
  ] as const)("puts the file back and exits with 130 on %s during a mutant's run", async (signal) => {
    const dir = fixture();
    const child = spawn(process.execPath, [command, "light.ts", hangsOnDim], { cwd: dir, stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    await firstMutant(dir);
    child.kill(signal);
    expect(await exited).toBe(130);
    expect(readFileSync(join(dir, "light.ts"), "utf8")).toBe(flow);
    expect(existsSync(join(dir, "light.ts.unmutated"))).toBe(false);
  }, 60_000);
  it("refuses a second run on a file while a first one has a mutant in it", async () => {
    const dir = fixture();
    const first = spawn(process.execPath, [command, "light.ts", hangsOnDim], { cwd: dir, stdio: "ignore" });
    const exited = new Promise((resolve) => first.on("exit", resolve));
    await firstMutant(dir);
    const second = mutate(dir, "light.ts", "true");
    expect(second).toMatchObject({ status: 1, stdout: "", stderr: expect.stringContaining("EEXIST") });
    first.kill("SIGINT");
    await exited;
    expect(readFileSync(join(dir, "light.ts"), "utf8")).toBe(flow);
  }, 60_000);
  it("puts back a file that is not valid UTF-8 byte for byte", () => {
    const dir = fixture();
    // 0xE9 alone is é in Latin-1 and no character in UTF-8.
    const bytes = Buffer.concat([Buffer.from(flow), Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a])]);
    writeFileSync(join(dir, "light.ts"), bytes);
    mutate(dir, "light.ts", "true");
    expect(readFileSync(join(dir, "light.ts")).equals(bytes)).toBe(true);
  }, 60_000);
  it("forces each condition of the file, the left operand of &&, || and ?? included, in and out of a reducer", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutate-"));
    // Plain JavaScript, so that node --check, a test command that only parses, kills a mutant that does not parse.
    writeFileSync(
      join(dir, "branches.mjs"),
      `import { defineFlow } from "x";
defineFlow(a.on, {
  go(s, p) { if (p.flag ?? true) { return { n: 1 }; } return { n: 2 }; },
  add: (s, p) => p.ok && { ...s, n: 1 },
  pick: (s, p) => (p.ok ? (p.ok ? 1 : 2) : 3),
  ...shared,
});
const shared = { dim: (s, { by }) => ({ ...s, level: levelOf(by) }) };
function levelOf(raw) { return typeof raw === "number" ? raw : 0; }
`,
    );
    const run = JSON.parse(mutate(dir, "branches.mjs", "node --check branches.mjs").stdout);
    expect(run.mutants).toEqual([
      { line: 3, column: 18, original: "p.flag ?? true", replacement: "true", exitCode: 0, outcome: "survived" },
      { line: 3, column: 18, original: "p.flag ?? true", replacement: "false", exitCode: 0, outcome: "survived" },
      { line: 3, column: 18, original: "p.flag", replacement: "true", exitCode: 0, outcome: "survived" },
      { line: 3, column: 18, original: "p.flag", replacement: "undefined", exitCode: 0, outcome: "survived" },
      { line: 4, column: 18, original: "p.ok", replacement: "true", exitCode: 0, outcome: "survived" },
      { line: 4, column: 18, original: "p.ok", replacement: "undefined", exitCode: 0, outcome: "survived" },
      { line: 5, column: 20, original: "p.ok", replacement: "true", exitCode: 0, outcome: "survived" },
      { line: 5, column: 20, original: "p.ok", replacement: "false", exitCode: 0, outcome: "survived" },
      { line: 5, column: 28, original: "p.ok", replacement: "true", exitCode: 0, outcome: "survived" },
      { line: 5, column: 28, original: "p.ok", replacement: "false", exitCode: 0, outcome: "survived" },
      // a function a reducer held in a spread object calls
      {
        line: 9,
        column: 32,
        original: 'typeof raw === "number"',
        replacement: "true",
        exitCode: 0,
        outcome: "survived",
      },
      {
        line: 9,
        column: 32,
        original: 'typeof raw === "number"',
        replacement: "false",
        exitCode: 0,
        outcome: "survived",
      },
    ]);
  });
  it("makes two mutants of every condition of the engine's examples", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutate-"));
    copyFileSync(join(repo, "packages/core/examples/examples.ts"), join(dir, "examples.ts"));
    // A test command that always passes, so every mutant survives and the report lists all of them.
    const { mutants } = JSON.parse(mutate(dir, "examples.ts", "true").stdout);
    expect(mutants.map((m: { line: number }) => m.line)).toEqual([
      81, 81, 84, 84, 98, 98, 140, 140, 160, 160, 169, 169, 179, 179, 179, 179, 182, 182, 196, 196, 197, 197, 200, 200,
      203, 203, 293, 293, 293, 293, 293, 293, 311, 311, 355, 355, 361, 361, 438, 438, 447, 447, 480, 480, 480, 480, 480,
      480, 490, 490, 535, 535, 562, 562, 563, 563, 601, 601, 603, 603,
    ]);
  }, 60_000);
});
