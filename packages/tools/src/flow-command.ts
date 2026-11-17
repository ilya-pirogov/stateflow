/**
 * The tools as one command for an agent: `<runner> flow-command.ts <subcommand> ...` prints one JSON document on stdout
 * and exits with 1 when its answer is a failure, with 0 otherwise. A throw (a missing file, JSON that does not parse, a
 * dry run refused while a transition is pending) prints the error on stderr, prints nothing on stdout, and exits with 1
 * too. Whatever else writes to the console, `<module>` and the engine's log included, goes to stderr.
 * - `describe <module> <report>` writes the flow report (report.ts) of the module's definitions to `<report>` and
 *   prints `{ "written": "<report>" }`; with `--check` it writes nothing, prints reportChanges of the file against the
 *   report now, `{ stale, added, removed }`, and fails when it is stale.
 * - `dry-run <module> <states> <signal> <payload>` builds an object with the module's builder from `<states>`, a file
 *   holding a canonical print of states (printStates writes one), and prints dryRun of the signal named `<signal>` with
 *   `<payload>`, a print given inline (plain JSON is one), on it. That object holds only the handlers the builder
 *   registers. States that hold a transitional variant are refused by the engine as a start; a temp without that mark
 *   is taken as an ordinary state. A state the builder's flow does not have is dropped, as FlowConfig.start drops a
 *   name that matches no state, and the answer is for the object built without it.
 * - `walk <module> <options>` prints the walk's report of the module's subject, `<options>` being walk's options as
 *   JSON (`{"depth":3,"runs":0,"runLength":0,"seed":1}`), and fails when it found a failure. The options are passed as
 *   parsed: a field left out is undefined, which walks less (no depth: the first state alone) and is no error.
 * - `replay <module> <record>` prints the differences replay lists for the record in the file `<record>`, built with
 *   the module's builder, and fails when there is one.
 * - `compare <left> <right>` prints compareJson of the two JSON files (two prints, two records, two walk reports) and
 *   fails when they differ. Two flow reports are compared by describe --check.
 * `<module>` is a path to a module that exports `definitions`, every definition its flows hold, nested ones included,
 * and `subject`, a WalkSubject whose `build` is the builder the dry run and the replay use too.
 * Node's own TypeScript support cannot run this file: it needs a file extension on every relative import and takes no
 * directory import, and the engine's source, this package and a consumer's modules import without them. Run it with
 * vite-node, which resolves them as the tests do, given the config that maps @state-flow/core to one module: `npx
 * vite-node --config packages/tools/vitest.config.ts packages/tools/src/flow-command.ts walk <module> '{...}'`.
 */
import { Console } from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defineSignal } from "@state-flow/core";
import { compareJson } from "./compare";
import { dryRun } from "./dry-run";
import { TestClock } from "./index";
import { parsePrint, replay } from "./replay";
import { flowReport, reportChanges } from "./report";
import { walk } from "./walk";

// stdout holds the answer alone: the console of every module, the one loaded included, writes to stderr.
globalThis.console = new Console(process.stderr);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { check: { type: "boolean" } } });
const [command, first = "", second = "", third = "", fourth = ""] = positionals;
let answer: unknown;
switch (command) {
  case "describe": {
    const { definitions } = await import(resolve(first));
    if (values.check) {
      const changes = reportChanges(readFileSync(second, "utf8"), flowReport(definitions));
      answer = changes;
      process.exitCode = Number(changes.stale);
    } else {
      writeFileSync(second, flowReport(definitions));
      answer = { written: second };
    }
    break;
  }
  case "dry-run": {
    const { definitions, subject } = await import(resolve(first));
    const target = subject.build({
      start: parsePrint(readFileSync(second, "utf8"), definitions),
      timers: new TestClock(),
    });
    // a factory made here gives the signal its name, by which its reducers are found
    const signal = defineSignal<Record<string, unknown>>(third)(parsePrint(fourth, definitions));
    answer = await dryRun(target, signal, definitions, subject.build);
    break;
  }
  case "walk": {
    const { subject } = await import(resolve(first));
    const report = await walk(subject, JSON.parse(second));
    answer = report;
    process.exitCode = Number(report.failure !== null);
    break;
  }
  case "replay": {
    const { definitions, subject } = await import(resolve(first));
    const { differences } = await replay(readFileSync(second, "utf8"), definitions, subject.build);
    answer = differences;
    process.exitCode = Number(differences.length > 0);
    break;
  }
  case "compare": {
    const differences = compareJson(JSON.parse(readFileSync(first, "utf8")), JSON.parse(readFileSync(second, "utf8")));
    answer = differences;
    process.exitCode = Number(differences.length > 0);
    break;
  }
  default:
    throw new Error(`flow-command: no subcommand ${command}: describe, dry-run, walk, replay or compare`);
}
process.stdout.write(`${JSON.stringify(answer)}\n`);
