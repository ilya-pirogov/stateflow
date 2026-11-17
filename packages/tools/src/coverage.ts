import {
  addFlowTap,
  Items,
  isState,
  listHandlers,
  listStates,
  ResultKind,
  type StateInstance,
  stateVar,
  TransitionAborted,
} from "@state-flow/core";

/** "<state>.<variant>" of `x`, as the log names a variant; "(none)" for an empty position. */
function variantOf(x: StateInstance | undefined): string {
  return x === undefined ? "(none)" : String(stateVar(x));
}

/**
 * The variants of every node `holder` (a target or an instance) holds at any depth, where core src/tree.ts
 * childPositions finds nodes.
 */
function heldVariants(holder: object): string[] {
  return Object.values(Object.getOwnPropertyDescriptors(holder)).flatMap(({ value }) => variantsIn(value));
}

/** The variants of the nodes `x` is or holds: none for a value that is neither a state nor an Items. */
function variantsIn(x: unknown): string[] {
  if (x instanceof Items) {
    return [...x.values()].flatMap(variantsIn);
  }
  return isState(x) ? [variantOf(x), ...heldVariants(x)] : [];
}

/** What a change of a collection's item is: it entered, left, changed variant, or updated in its variant (no item). */
function phaseOf(from: string, to: string): string {
  if (from === to) {
    return "updated";
  }
  if (from === "(none)") {
    return "entered";
  }
  return to === "(none)" ? "left" : "changed";
}

/**
 * Measures, until the scope ends (`using coverage = startCoverage(states)`), what the tests reach of the definitions
 * `states` (a nested one only when named), as the tap of every flow of the page tells it. Each item is a string that
 * says what a test must do to reach it:
 * - `variant <state>.<variant>`: a node is in it when a signal is dispatched to its target, or enters it in a commit;
 * - `signal <state>.<variant> <signal>`, each signal the variant has a reducer for: it is dispatched while a node of
 *   its target is in the variant;
 * - `end <state>.<variant> final|failed|timeout|abort`, each transitional variant: a node left it in the end of its
 *   transition at its next, at its failed end, at its failed end by the timeout, or in an accepted abort; a step
 *   with no transition mark is no end;
 * - `refusal <state>.<variant> <kind>`, each kind but commit with a handler on that variant on a target the tap told
 *   of: such a handler gave Rejected, or an Error that is no TransitionAborted. A TransitionAborted is the reason a
 *   signal aborted with (an accepted abort, the timeout, a failed end, disposeFlow), and a work that gives it back
 *   refused nothing; one that refuses for a reason of its own counts, even when it answers an abort or answers late;
 * - `phase <collection>[] entered|changed|left`, each collection of items of a named definition, named by its path
 *   with the keys left out: an item entered it, changed variant in it, or left it.
 * Refusals appear when their target is dispatched to and phases when a collection's item first commits a change (an
 * update in its variant too), so the level can fall as a run goes on. `report()` is right for every step ended by the
 * call: `level`, the share of items reached (0 to 1, and 0 when there is no item); `reached` and `missing` in the
 * order the items came to exist (each variant, its signals and ends, in listStates' order; then the others as they
 * appear).
 *
 * Not seen: a reducer's branches; a dispatch refused before its reducers run; what a dispatch that throws did after
 * the last telling the tap got; commit handlers; named results; a handler registered after its target's last
 * dispatch; a collection no item of which commits a change. Counted wrongly: a state the target holds outside its
 * flow counts; so does a definition not named that shares a named one's name, since items are named by text as
 * listHandlers names variants; a work that passes on another transition's TransitionAborted refused, and is not
 * counted; a key whose text holds "]" misnames its collection; a collection of a one-variant definition has a changed
 * phase no run reaches.
 */
export function startCoverage(states: Parameters<typeof listStates>[0]) {
  const exists = new Set<string>();
  const reached = new Set<string>();
  const variants = listStates(states).flatMap((state) =>
    state.variants.map((variant) => ({ ...variant, name: `${state.name}.${variant.name}` })),
  );
  for (const { name, signals, transitional } of variants) {
    exists.add(`variant ${name}`);
    for (const signal of signals) {
      exists.add(`signal ${name} ${signal}`);
    }
    if (transitional) {
      exists.add(`end ${name} final`);
      exists.add(`end ${name} failed`);
      exists.add(`end ${name} timeout`);
      exists.add(`end ${name} abort`);
    }
  }
  const removeTap = addFlowTap({
    dispatched(target, signal) {
      // Every node runs its reducer for the signal when its variant has one; a pair with no reducer is no item.
      for (const variant of heldVariants(target)) {
        reached.add(`variant ${variant}`);
        reached.add(`signal ${variant} ${signal[Symbol.toStringTag]}`);
      }
      // The tap is never told of a commit handler (core src/flow.ts FlowTap.handled).
      for (const { variant, kind } of listHandlers(target)) {
        if (kind !== "commit" && exists.has(`variant ${variant}`)) {
          exists.add(`refusal ${variant} ${kind}`);
        }
      }
    },
    handled(_target, kind, call, result) {
      // A work that gives back its signal's abort reason, a TransitionAborted, refused nothing.
      if (result.in(ResultKind.Rejected, ResultKind.Error) && !(result.error instanceof TransitionAborted)) {
        reached.add(`refusal ${variantOf(call.instance)} ${kind}`);
      }
    },
    ended(target, step) {
      // SF035 is the code of a timeout's Error. A temp step and a plain one name an end no item has.
      const end = step.abort ? "abort" : step.result.code === "SF035" ? "timeout" : step.transition;
      for (const { stateName, old, next } of step.changes) {
        const [from, to] = [variantOf(old), variantOf(next)];
        reached.add(`variant ${to}`);
        reached.add(`end ${from} ${end}`);
        // A collection's item is named by its key in brackets (core src/tree.ts pathName); one side is always there.
        if (stateName.endsWith("]") && exists.has(`variant ${variantOf(next ?? old)}`)) {
          const collection = stateName.replaceAll(/\[[^\]]*\]/g, "[]");
          exists.add(`phase ${collection} entered`);
          exists.add(`phase ${collection} changed`);
          exists.add(`phase ${collection} left`);
          reached.add(`phase ${collection} ${phaseOf(from, to)}`);
        }
      }
    },
  });
  return {
    report() {
      const items = [...exists];
      const missing = items.filter((item) => !reached.has(item));
      return {
        // With no item nothing is reached: level 0, not the NaN of 0 / 0 that every comparison takes as false.
        level: (items.length - missing.length) / Math.max(items.length, 1),
        reached: items.filter((item) => reached.has(item)),
        missing,
      };
    },
    [Symbol.dispose]: removeTap,
  };
}

/** Throws when `report.level` is below `level`, listing the items not reached, one per line. */
export function coverageGate(report: { level: number; missing: string[] }, level: number): void {
  if (report.level < level) {
    throw new Error(`coverage ${report.level} is below ${level}; not reached:\n${report.missing.join("\n")}`);
  }
}
