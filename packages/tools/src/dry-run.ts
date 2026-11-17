import {
  addFlowTap,
  dispatch,
  type FlowTapStep,
  HandlerResult,
  listHandlers,
  mockHandlers,
  ResultKind,
  type Signal,
  sync,
} from "@state-flow/core";
// index.ts re-exports this module; the cycle is safe, as this module uses what it imports only inside its functions.
import { handlersOff, TestClock } from "./index";
import { printValue, statesOf } from "./print";
import { namesOf } from "./replay";
import { inertStates, type WalkSubject } from "./walk";

/**
 * What `signal` would do to `target` now, without touching it: the first step of its dispatch, as the engine's reducers
 * decide it. The signal is dispatched to a second object that `build` returns from `target`'s committed states as they
 * are at the call (each DisposableBox holding a stand-in, see inertStates) and a TestClock that never moves, so it
 * costs one build per question. `definitions` holds every definition of `target`'s flow, nested ones included.
 * The answer is plain data:
 * - `result`: the step's kind (ResultKind's name), its message (an Error's message for an Error) and its code, as the
 *   tap's FlowTapStep.result gives them; for a declared transition, the temp step's, "InTransition";
 * - `transition`: "temp" when the step is a declared transition's first, absent otherwise;
 * - `changes`: each node the step would commit, in the engine's pre-order: `node` its path as the log names it, `old`
 *   and `next` the canonical print (docs/canonical-print.md) of each side;
 * - `handlers`: the registrations of listHandlers(target) the step would call, in the engine's order: its exit, update,
 *   enter and commit handlers, then the transition handlers its work starts. Which node a call is on is not given;
 * - `fired`: `{ node, observer }` for each observer, event and watch of the second object whose callback the step
 *   would ask for, named as the log names them (a session record's `fired` has the same form), so those the
 *   builder registers. One added to `target` after it was built (observe, watch) is not seen: the engine lists none.
 * Not in it: anything a handler would answer (a refusal, a named result, the failed step it would bring), and anything
 * after the first step (a transition's end, a queued send, what an observer's callback would send), and what the build
 * sends: the build runs with every handler off and no mock, so its sends call nothing and a transition it declares
 * ends inside its send.
 * How: while the build and the dispatch run, synchronously, every handler is off (handlersOff); after the build, each
 * variant and kind registered on `target` is mocked (mockHandlers) by one that records its call. Both switches act on
 * the whole page, so they are on only while nothing else can run. A transition's mock gives a promise that never
 * settles, so its
 * end never runs. Every tap of the page (addFlowTap: a recorder, coverage) is told that dispatch, the mocks' results
 * included.
 * @throws Error "dryRun: a transition is pending on the target; ask again once sync(target) resolved" when one is:
 *   its committed states hold the temp, and its next step is the transition's end, which no reducer decides.
 * @throws Error when a variant registered on `target` is not in `definitions` (namesOf)
 * @throws StateFlowError when `target` is no flow or its flow is disposed (listHandlers'); when a mock of the
 *   caller's is in force on a variant and kind registered on `target` (mockHandlers'); or when a transition the build
 *   declares stays pending, as under a transition mock of the caller's that does not answer (dispatch's)
 */
export async function dryRun(
  target: object,
  signal: Signal,
  definitions: readonly object[],
  build: WalkSubject<object>["build"],
) {
  const registered = listHandlers(target);
  const start = inertStates(statesOf(target));
  // The engine says a transition is pending only through sync's promise. With none pending that promise is fulfilled
  // when sync returns, so its reaction, queued first, runs before this function resumes from the await below.
  let pending = true;
  void sync(target).then(() => {
    pending = false;
  });
  await Promise.resolve();
  if (pending) {
    throw new Error("dryRun: a transition is pending on the target; ask again once sync(target) resolved");
  }
  // The registrations by "<variant> <kind>", each a call's handlers in their order, and the mocks by variant.
  const byCall = new Map<string, typeof registered>();
  const mocks = new Map<string, Record<string, () => unknown>>();
  // The calls, as "<variant> <kind>", in the engine's order: of exit, update, enter and commit handlers, of which the
  // answer takes those made by the first step's end; and of transition handlers.
  const stepCalls: string[] = [];
  const workCalls: string[] = [];
  for (const handler of registered) {
    const call = `${handler.variant} ${handler.kind}`;
    const handlers = byCall.get(call) ?? [];
    handlers.push(handler);
    byCall.set(call, handlers);
    mocks.set(handler.variant, {
      ...mocks.get(handler.variant),
      [handler.kind]:
        handler.kind === "transition"
          ? () => {
              workCalls.push(call);
              return new Promise(() => {});
            }
          : () => {
              stepCalls.push(call);
              return HandlerResult.ok();
            },
    });
  }
  let first: FlowTapStep | undefined;
  let firstCalls: string[] | undefined;
  {
    using scope = new DisposableStack();
    scope.use(handlersOff());
    // Built before the mocks are in force, so what the build sends runs with no handler, records no call, and leaves
    // no transition pending: with handlers off a declared transition has no work and ends inside its send.
    const second = build({ start, timers: new TestClock() });
    const variant = namesOf(definitions);
    for (const [id, kinds] of mocks) {
      scope.use(mockHandlers(variant(id), kinds));
    }
    scope.defer(
      addFlowTap({
        dispatched() {},
        handled() {},
        ended(stepTarget, step) {
          if (stepTarget === second) {
            first ??= step;
            firstCalls ??= [...stepCalls];
          }
        },
      }),
    );
    // A new object holds no lock and has no transition pending, so a bare dispatch runs at once, and the tap is told
    // the first step's end inside it.
    dispatch(second, signal);
  }
  const { result, transition, changes, fired } = first as FlowTapStep;
  return {
    result: {
      kind: ResultKind[result.kind],
      message: result.message ?? result.error?.message ?? null,
      code: result.code,
    },
    transition,
    changes: changes.map(({ stateName, old, next }) => ({
      node: stateName,
      old: printValue(old),
      next: printValue(next),
    })),
    handlers: [...(firstCalls as string[]), ...workCalls].flatMap((call) => byCall.get(call) ?? []),
    fired: fired.map(({ stateName, observerName }) => ({ node: stateName, observer: observerName })),
  };
}
