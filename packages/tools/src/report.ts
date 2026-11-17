import { listStates } from "@state-flow/core";

/**
 * The flow report of the definitions `states`: one fact per line, every line ending in a newline, sorted by UTF-16 code
 * units, so neither the order of the definitions nor of their variants shows and a change of the model adds or removes
 * only its own lines. For each variant `<state>.<variant>` of each definition, as listStates gives them:
 * - `<state>.<variant>`, that the variant exists;
 * - `<state>.<variant> initial`, `... transitional`, `... async`, one line per mark it has;
 * - `<state>.<variant> reducer <signal>` for each signal it has a reducer for;
 * - `<state>.<variant> result <name>` for each named result it declares.
 * Not in it: the definition's signals that no variant has a reducer for (signalTable lists them), handlers
 * (listHandlers, and the effect list of list-effects.ts) and transitions, which exist only as what a reducer returns.
 */
export function flowReport(states: Parameters<typeof listStates>[0]): string {
  const variants = listStates(states).flatMap((state) =>
    state.variants.map((variant) => ({ ...variant, id: `${state.name}.${variant.name}` })),
  );
  const lines = variants.flatMap((variant) => [
    variant.id,
    ...(["initial", "transitional", "async"] as const)
      .filter((mark) => variant[mark])
      .map((mark) => `${variant.id} ${mark}`),
    ...variant.signals.map((signal) => `${variant.id} reducer ${signal}`),
    ...variant.results.map((result) => `${variant.id} result ${result}`),
  ]);
  return [...lines.sort(), ""].join("\n");
}

/**
 * What differs between `checkedIn`, a report flowReport wrote earlier, and `report`, one it writes now: `added` the
 * lines only `report` has, `removed` those only `checkedIn` has, each in its text's order, and `stale` whether either
 * holds one. Lines compare as text, read with CRLF line ends (a checkout under git's autocrlf) as LF.
 */
export function reportChanges(checkedIn: string, report: string) {
  const was = checkedIn.split(/\r?\n/);
  const is = report.split("\n");
  const added = is.filter((line) => !was.includes(line));
  const removed = was.filter((line) => !is.includes(line));
  return { stale: added.length + removed.length > 0, added, removed };
}
