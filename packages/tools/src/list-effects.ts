/**
 * Writes the list of effects (effects.ts) of the files given, as `node list-effects.ts --world <name>... --out <list>
 * <file>...`: every line, sorted, so neither the order of the files nor of their registrations shows. With `--check` it
 * writes nothing, and exits with 1 and says so when `<list>` differs from what it would write, reading CRLF line ends
 * (a checkout under git's autocrlf) as LF. A path that is no readable file throws, and Node exits with 1 too. Node
 * runs this file as it is from 22.18, not under node_modules.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { listEffects } from "./effects.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    world: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: "" },
    check: { type: "boolean", default: false },
  },
});
const lines = positionals.flatMap((file) => listEffects(file, readFileSync(file, "utf8"), values.world)).sort();
// Each line ends in a newline: "" for no line.
const list = [...lines, ""].join("\n");
if (!values.check) {
  writeFileSync(values.out, list);
} else if (readFileSync(values.out, "utf8").replaceAll("\r\n", "\n") !== list) {
  console.log(`${values.out} is stale: run the command without --check to write it.`);
  process.exitCode = 1;
}
