import { addFlowTap, type StateInstance, stateVar } from "../..";

/**
 * Adds a tap that writes every telling to `lines`, one line each, and returns the function that removes it. A target
 * is named `#1`, `#2`, ..., a signal `s1`, `s2`, ... and a handler call `c1`, `c2`, ..., each in the order this tap is
 * first told of it, so two lines name one signal, or one call, exactly when the engine told the same object: an
 * `ended` belongs to the `dispatched` of its signal's number, and a late answer to the call an `ended` listed as
 * unsettled. The lines, from the string forms the engine has (a signal's, a Result's, a variant's through stateVar,
 * "(none)" for an empty position):
 *
 *   #<n> dispatched s<i> <signal>
 *   #<n> handled <kind> c<j> <call.name> <variant of call.instance>: <result>
 *   #<n> ended s<i> <signal>[ abort][ <transition>]: <result>[ | changes <stateName> <old>-><next>, ...]
 *     [ | fired <stateName> <observerName>, ...][ | unsettled c<j> <name>, ...]
 *
 * An ended line is one line; a section whose list is empty is left out.
 */
export function writeTapLines(lines: string[]): () => void {
  /** Names each object it is given `<prefix>1`, `<prefix>2`, ... in the order it first sees them. */
  const numbered = (prefix: string) => {
    const names = new Map<object, string>();
    return (x: object): string => {
      const name = names.get(x) ?? `${prefix}${names.size + 1}`;
      names.set(x, name);
      return name;
    };
  };
  const [targetOf, signalOf, callOf] = [numbered("#"), numbered("s"), numbered("c")];
  const variantOf = (x: StateInstance | undefined): string => (x === undefined ? "(none)" : String(stateVar(x)));
  return addFlowTap({
    dispatched: (target, signal) => {
      lines.push(`${targetOf(target)} dispatched ${signalOf(signal)} ${String(signal)}`);
    },
    handled: (target, kind, call, result) => {
      lines.push(
        `${targetOf(target)} handled ${kind} ${callOf(call)} ${call.name} ${variantOf(call.instance)}: ${String(result)}`,
      );
    },
    ended: (target, step) => {
      const marks = `${step.abort ? " abort" : ""}${step.transition === undefined ? "" : ` ${step.transition}`}`;
      const sections = [
        [
          "changes",
          step.changes.map(({ stateName, old, next }) => `${stateName} ${variantOf(old)}->${variantOf(next)}`),
        ],
        ["fired", step.fired.map(({ stateName, observerName }) => `${stateName} ${observerName}`)],
        ["unsettled", step.unsettled.map((call) => `${callOf(call)} ${call.name}`)],
      ] as const;
      const listed = sections
        .filter(([, items]) => items.length > 0)
        .map(([title, items]) => ` | ${title} ${items.join(", ")}`);
      lines.push(
        `${targetOf(target)} ended ${signalOf(step.signal)} ${String(step.signal)}${marks}: ${String(step.result)}${listed.join("")}`,
      );
    },
  });
}
