/**
 * Runs every rule of rules.ts over the files it is given, as `node check-rules.ts <file>...`: prints each finding as
 * `file:line rule: fix` and exits with 1 when there is one, with 0 otherwise. A CI step passes the files, for example
 * `node <tools>/src/check-rules.ts $(git ls-files '*.ts' '*.tsx')`: import-in-state-file judges a relative import by
 * the files given, so give them all. A file given twice is checked twice. A path that is no readable file throws, and
 * Node then prints the error on stderr and exits with 1 too. Node runs this file as it is from 22.18, and refuses to
 * for a file under node_modules, so a consumer runs it from a linked copy of the package.
 */
import { readFileSync } from "node:fs";
import { checkSources } from "./rules.ts";

const findings = checkSources(process.argv.slice(2).map((file) => [file, readFileSync(file, "utf8")]));
for (const f of findings) {
  console.log(`${f.file}:${f.line} ${f.rule}: ${f.fix}`);
}
process.exitCode = Number(findings.length > 0);
