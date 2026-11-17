import { addFlowTap, disposeFlow, listHandlers, stateVar } from "@state-flow/core";
// index.ts re-exports this module; the cycle is safe, as this module uses what it imports only inside its functions.
import { TestClock } from ".";

/** One run that holds wait number `wait` and aborts there (see checkAbort): its failure or null, or undefined when the
 * run settled before it made that wait. */
async function abortAt<W extends object>(world: W, run: (world: W) => Promise<unknown>, wait: number) {
  // Each target the run dispatched to, with its handlers read before the dispose, which listHandlers refuses.
  const registered = new Map<object, ReturnType<typeof listHandlers>>();
  const names: string[] = [];
  const used: string[] = []; // names: see checkAbort; used: methods called after the abort
  let waits = 0;
  let waitedOn = "";
  let aborted = false;
  // The held wait: the world's answer, the call that hands it to the handler, the call that tells the check it is
  // held. The wrapper sets the first two and the promise below the third, each before it is called.
  const hold = { answer: Promise.resolve() as Promise<unknown>, open() {}, tell() {} };
  const reached = new Promise<true>((resolve) => {
    hold.tell = () => resolve(true);
  });
  using tap = new DisposableStack();
  tap.defer(
    addFlowTap({
      dispatched(target) {
        registered.set(target, listHandlers(target));
      },
      handled(target, kind, call) {
        if (!aborted || kind !== "transition") {
          return;
        }
        const variant = String(stateVar(call.instance));
        const ofVariant = (registered.get(target) ?? []).filter(
          (entry) => entry.kind === "transition" && entry.variant === variant,
        );
        names.push(...ofVariant.map((entry) => entry.name));
      },
      ended() {},
    }),
  );
  // A Proxy forwards every property read to `world`; a method comes back wrapped, so each call passes through here.
  const wrapper = new Proxy(world, {
    get(target, key) {
      const member: unknown = Reflect.get(target, key);
      if (typeof member !== "function") {
        return member;
      }
      return (...args: unknown[]) => {
        if (aborted) {
          used.push(String(key));
          throw new Error(`checkAbort: ${String(key)} was called after the abort`);
        }
        const answer: unknown = member.apply(target, args);
        if (!(answer instanceof Promise) || ++waits !== wait) {
          return answer;
        }
        waitedOn = String(key);
        hold.answer = answer;
        hold.tell();
        return new Promise((resolve) => {
          hold.open = () => resolve(answer);
        });
      };
    },
  });
  // The race below subscribes to `ran`, so a rejection once `reached` won is handled, and one before it rejects.
  const ran = run(wrapper).then(() => false as const);
  if (!(await Promise.race([reached, ran]))) {
    return undefined;
  }
  // Set after the dispose: what it calls (a box's dispose, the signal's abort listeners) is the release it asks for.
  for (const target of registered.keys()) {
    disposeFlow(target);
  }
  aborted = true;
  hold.open();
  await Promise.allSettled([hold.answer]);
  await new TestClock().idle(); // one macrotask: what the handler does in reply to the answer has run
  const [use] = used;
  return use === undefined ? null : { handler: [...new Set(names)].join(", "), wait, waitedOn, used: use };
}
/**
 * Checks that the transition handlers `run` reaches stop using `world` once their work's signal aborts. `run` builds
 * its objects with the world it is given, handlers on, and drives them; it is called once per wait, each time with a
 * new wrapper of the same `world`, and must not settle before the works it started settled: a wait made after it
 * settled is not reached. A wait is a call of a function member of the wrapper that returns a Promise, numbered from 1.
 * Run n holds back wait n's answer, disposes every target the run dispatched to (disposeFlow: the work's signal aborts,
 * kind disposed, and no other handler runs), hands the answer over once the world settled it, and waits a macrotask.
 * A call of the wrapper's function members after the dispose is going on, and throws instead of calling `world`. A
 * call inside disposeFlow (a box's dispose, the signal's abort listeners) reaches `world` and is not counted: the
 * engine makes the abort the work's notice to release what it holds. A late return does not count, as the engine
 * drops it. The run's rejection after the abort is ignored; one before it is thrown.
 * Returns the first failure, or null once a run settled before its wait: `handler` the names the log shows of the
 * transition handlers on each variant whose work settled after the abort, each once, joined by ", " ("" if none did
 * within the macrotask); `wait`; `waitedOn` the method waited on; `used` the first method called after the abort.
 * The check cannot tell `run`'s own calls from a handler's: `run`'s wait is held as one, and its call after the abort
 * is a failure, with `handler` "" when no work settled; so `run` calls the world only through the objects it builds.
 * Not seen: a use after a timer of the handler's own; a call on what the world returned, or through a member that is
 * not a function of `world` itself (`world.api.use`); a handler acting otherwise on another kind of abort; an abort
 * listener that starts work in the world, whose later call of the wrapper throws outside any handler.
 * Counted though the handler started nothing: a release it makes through the wrapper after the wait, in reply to the
 * abort, which the check cannot tell from a use; and the dispose of a box its late result holds, which the engine
 * disposes as the work settles, when that dispose calls the wrapper. A held wait the world never settles keeps the
 * check waiting.
 */
export async function checkAbort<W extends object>(world: W, run: (world: W) => Promise<unknown>) {
  for (let wait = 1; ; wait++) {
    const failure = await abortAt(world, run, wait);
    if (failure !== null) {
      return failure ?? null;
    }
  }
}
