/**
 * Mutation testing of a state file: `node mutate.ts <state file> "<test command>" [<limit in ms>]` changes one branch
 * of the file at a time, runs the test command (in a shell, from the current directory, output discarded) on each
 * changed file and prints one JSON document on stdout, `{ baselineMs, limitMs, mutants: [{ line, column, original,
 * replacement, exitCode, outcome }] }`, line and column (from 1) being where `original` starts. A mutant is "killed"
 * when the command exits with anything but 0, "survived" when it exits with 0: a survivor is a branch no test can
 * fail on. The exit code is 1 when a mutant survived, 0 otherwise.
 *
 * - Every branch of the file is changed, wherever it stands: a state file holds reducers and the functions they call,
 *   in whatever form it gives them to defineFlow, and a branch of either that no test can fail on is the finding. In a
 *   file that also holds handlers or the world, their branches are changed too. Not read: another file a reducer
 *   calls into.
 * - A branch is an if's or a ternary's condition, replaced by `true` and by `false`, or the left operand of `&&`, `||`
 *   or `??`, replaced by `true` and by `undefined`, which is falsy and nullish, so each operator takes its other
 *   result. A literal in place of an expression always parses. Not changed: a switch's cases, an early return.
 * - The tests run first on the unchanged file; when they fail the command throws (stderr, exit 1) and tries no mutant.
 *   A file with no branch gives `mutants: []` and the exit code 0.
 * - A mutant's run is stopped at the limit and counts as killed with `exitCode: null`, as a mutant that does not
 *   compile counts as killed. The limit is 3 times the unchanged run's time plus a second unless the third argument
 *   gives it; on a loaded machine the unchanged run may be slow or fast by more than that, so rerun with a limit when
 *   a mutant ends with `exitCode: null`.
 * - Each mutant is written over the file. Before anything else the file is copied to `<file>.unmutated`, with the
 *   flag that fails when the copy exists: a second run on the file while a first one holds it throws EEXIST and writes
 *   nothing. However the command ends, short of a kill -9, the copy is put back over the file and removed: at the end,
 *   on a throw, and on SIGINT, SIGTERM or SIGHUP, which also stop the running test command and exit with 130. A
 *   kill -9 leaves the mutant in the file, the unchanged bytes in the copy (move it back over the file) and the test
 *   command running in its own process group.
 * - A mutant equal to the original by construction (a condition forced to the value it always has) survives like an
 *   untested branch: this tool cannot tell them apart.
 *
 * Node runs this file as it is from 22.18, and refuses to for a file under node_modules, so a consumer runs it from a
 * linked copy of the package.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { constants, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import ts from "typescript";

const [file = "", command = "", limit = ""] = process.argv.slice(2);
// The lock, and the bytes to put back: throws EEXIST while another run of this command holds the file. The file is
// read from the copy, so that no run reads another's mutant as the unchanged file.
const unmutated = `${file}.unmutated`;
copyFileSync(file, unmutated, constants.COPYFILE_EXCL);
// Runs however the process ends, short of a kill -9: at the end, on a throw, on the process.exit() of a signal below.
process.on("exit", () => {
  copyFileSync(unmutated, file);
  rmSync(unmutated);
});
const unchanged = readFileSync(unmutated, "utf8");
const source = ts.createSourceFile(file, unchanged, ts.ScriptTarget.Latest, true);

// Each mutant: the condition replaced and its replacement, in source order.
const branches: Array<[node: ts.Node, replacement: string]> = [];
const visit = (node: ts.Node): void => {
  if (ts.isIfStatement(node)) {
    branches.push([node.expression, "true"], [node.expression, "false"]);
  }
  if (ts.isConditionalExpression(node)) {
    branches.push([node.condition, "true"], [node.condition, "false"]);
  }
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
      node.operatorToken.kind,
    )
  ) {
    branches.push([node.left, "true"], [node.left, "undefined"]);
  }
  ts.forEachChild(node, visit);
};
visit(source);

const mutants = branches.map(([node, replacement]) => ({
  line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
  column: source.getLineAndCharacterOfPosition(node.getStart()).character + 1,
  original: node.getText(),
  replacement,
  text: unchanged.slice(0, node.getStart()) + replacement + unchanged.slice(node.getEnd()),
}));

// The command running now, which a signal stops. It runs in a process group of its own (detached), so the whole
// group is killed: a shell's children, a test runner's workers among them, outlive a kill of the shell alone.
let running: ChildProcess | undefined;

/** Runs the command, killing it after `limitMs`; resolves with its exit code, null when a signal ended it. */
function run(limitMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "ignore", detached: true });
    running = child;
    const timer = setTimeout(() => process.kill(-(child.pid as number), "SIGKILL"), limitMs);
    child.on("exit", (code) => {
      // Once the group has exited the system may give its id to another process group, which must not be killed.
      running = undefined;
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// SIGHUP is what a closed terminal sends; SIGTERM what a harness's timeout sends.
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(name, () => {
    if (running !== undefined) {
      process.kill(-(running.pid as number), "SIGKILL");
    }
    process.exit(130);
  });
}

const start = performance.now();
// The longest delay setTimeout takes (2^31 - 1 ms, about 24 days); a longer one fires at once.
const baseline = await run(2 ** 31 - 1);
const baselineMs = Math.round(performance.now() - start);
if (baseline !== 0) {
  throw new Error(`The tests fail on the unchanged ${file}: ${command} exited with ${baseline}.`);
}
// On the engine's examples a mutant's run took at most 2.2 times the unchanged run's (5,884 ms against 2,685 ms); the
// second absorbs the start of a process, which varies by more than a command of a few milliseconds takes.
// A limit that is no number, as when none is given, is this default.
const limitMs = Number(limit) || 3 * baselineMs + 1000;
const outcomes = [];
for (const { text, ...mutant } of mutants) {
  writeFileSync(file, text);
  const exitCode = await run(limitMs);
  outcomes.push({ ...mutant, exitCode, outcome: exitCode === 0 ? "survived" : "killed" });
}
console.log(JSON.stringify({ baselineMs, limitMs, mutants: outcomes }, null, 2));
process.exitCode = Number(outcomes.some((m) => m.outcome === "survived"));
