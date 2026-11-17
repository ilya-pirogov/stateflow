import { addFlowTap } from "@state-flow/core";
// index.ts re-exports this module; the cycle is safe, as this module uses what it imports only inside its function.
import { handlersOff } from ".";
import { printValue } from "./print";

/** One step as the tap's `ended` told it: its signal's name, and each node it committed, by path, as its print. */
type Taken = { signal: string; print: string; states: Map<string, string> };
/** How much later the second take's clock reads inside a step. */
const LATER = 90_061_001;
/**
 * Runs `run` twice with every handler off and names the first step whose reducers answered differently the second
 * time: `state` the first node whose committed instance differs, children before their parents, by path as the log
 * names it, and `signal` the name of the step's signal; null when all committed alike. `run` builds its objects anew,
 * so while earlier steps committed alike, the k-th step of each take starts from the same states. Steps are the tap's
 * `ended` tellings on any target, in order; a node commits alike when its instance prints alike (printValue), so a
 * new Box or collection of the same content is no difference.
 * Until it returns it replaces Date.now, performance.now and Math.random. The engine runs a step's reducers in the
 * same synchronous run of code as the tap's `dispatched` (a dispatch) or `handled` (a work's answer, before the end it
 * makes); from such a telling to the step's `ended` or the end of that run of code, the second take reads LATER ms
 * after the check's start and 0.75, and everything else reads the start and 0.25. So a method's read before it sends
 * is alike in both takes; a module counter or a remembered value differs.
 * Not seen: `new Date()`, `Date()`, a `Date.now` kept before the check, `crypto`; a read whose use is equal for both
 * values; a read in the reducers of a timeout's failed end, which no telling precedes; a reducer that changes its
 * payload in place when each take sends a new payload; a difference only in a reason. A read in `run`'s own code
 * right after an accepted abort's dispatch, before it awaits, gets the step's values. A step that differs for a cause
 * outside its reducers is named too; a parent's reducer that puts a child in differently names the child. A node
 * that commits in the second take only is compared after every node of the first take's step, so a parent that
 * commits in both may be named instead of it. A `run` that waits for the clock to move waits forever. One check at a
 * time: two at once leave the replacements in place.
 */
export async function checkPurity(run: () => Promise<unknown>) {
  const first: Taken[] = [];
  const second: Taken[] = [];
  let into = first;
  let inStep = false;
  // A microtask runs once the current run of code ends, before any code waiting on a promise or a timer: there the
  // step's window closes.
  const open = () => {
    inStep = true;
    queueMicrotask(() => {
      inStep = false;
    });
  };
  const start = Date.now();
  const startPerformance = performance.now();
  const real = { now: Date.now, performanceNow: performance.now, random: Math.random };
  const reading = (same: number, other: number) => () => (inStep && into === second ? other : same);
  using scope = new DisposableStack();
  scope.use(handlersOff());
  scope.defer(() => {
    Date.now = real.now;
    performance.now = real.performanceNow;
    Math.random = real.random;
  });
  scope.defer(
    addFlowTap({
      dispatched: open,
      handled: open,
      ended(_target, step) {
        inStep = false;
        // Children first: a parent's print holds its children's, so a child that differs is named before its parent.
        const changes = step.changes.map((change) => [change.stateName, printValue(change.next)] as const).reverse();
        const states = new Map(changes);
        into.push({ signal: step.signal[Symbol.toStringTag], print: JSON.stringify([...states]), states });
      },
    }),
  );
  Date.now = reading(start, start + LATER);
  performance.now = reading(startPerformance, startPerformance + LATER);
  Math.random = reading(0.25, 0.75);
  await run();
  into = second;
  await run();
  // A step the second take lacks counts as alike: only a step both takes made can differ.
  const at = first.findIndex((step, index) => step.print !== (second[index]?.print ?? step.print));
  const ours = first[at];
  if (ours === undefined) {
    return null;
  }
  const theirs = second[at] as Taken; // findIndex compared it
  // Prints that differ differ at a node: both list nodes in the engine's one pre-order, reversed.
  const state = [...ours.states.keys(), ...theirs.states.keys()].find(
    (name) => ours.states.get(name) !== theirs.states.get(name),
  ) as string;
  return { state, signal: ours.signal };
}
