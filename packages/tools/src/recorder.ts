import {
  addFlowTap,
  type FlowTap,
  HandlerResult,
  type Result,
  ResultKind,
  type Signal,
  stateVar,
} from "@state-flow/core";
import { printValue, statesOf } from "./print";

// The print writes a plain object's keys in the object's own order, so each object of a record is made below with its
// keys in ascending order, the order docs/session-record.md gives.

/**
 * One call of a step on one node. Its outcome is null for OK and Ignored, which change nothing, and `unsettled` for a
 * transition's work that had not settled when its transition ended or was dropped.
 */
export type Call = {
  kind: string;
  node: string;
  variant: string;
  outcome:
    | { named: string; data: unknown }
    | { rejected: string; data: unknown }
    | { error: { name: string; message: string } }
    | { unsettled: true }
    | null;
};
/**
 * One dispatch: whether it was sent as an abort of a pending transition, its handler calls, the observers that fired
 * in its steps, its signal's name and payload, and the states at its dispatch.
 */
export type Step = {
  abort: boolean;
  calls: Call[];
  fired: Array<{ node: string; observer: string }>;
  payload: Record<string, unknown>;
  signal: string;
  states: object;
};
/** A record (docs/session-record.md) as JSON.parse gives it. */
export type Recorded = { cannotReplay: string | null; start: object; steps: Step[]; stop: object };

/** The codes of an abort its reducers refused (packages/core/src/error-codes.json): its transition goes on. */
const refusedAbort = new Set(["SF036", "SF037", "SF038", "SF039"]);

/**
 * Starts recording the session of every flow of the page, from the engine's tap, until the returned scope ends
 * (`using recording = recordSessions()`). `record(target)` gives one target's session as the text of
 * docs/session-record.md, which `replay` runs again with every handler off; the tap is told inside each step, so a
 * record holds every step that ended before the call. Values are kept as they are and written at the call, so a
 * payload or a result's data changed after its dispatch is written as changed. It holds every recorded value alive
 * until the scope ends. A record of a target told no step is never marked unreplayable, though it was written while a
 * transition was pending: the tap tells nothing that shows it.
 */
export function recordSessions(): Disposable & { record(target: object): string } {
  // `stepOf` pairs an end with its dispatch: the engine tells both with the same signal object. `pending` says
  // whether a transition is pending after the last end told.
  const sessions = new Map<object, { start: object; steps: Step[]; stepOf: Map<Signal, Step>; pending: boolean }>();
  // the record of each handler call, by the object the tap names the call with
  const calls = new WeakMap<object, Call>();
  const sessionOf = (target: object) => {
    const session = sessions.get(target) ?? {
      start: statesOf(target),
      steps: [] as Step[],
      stepOf: new Map<Signal, Step>(),
      pending: false,
    };
    sessions.set(target, session);
    return session;
  };
  /** Records what `call` gave in `step`; a call already recorded keeps its outcome unless that is null. */
  const note = (
    step: Step | undefined,
    kind: string,
    call: Parameters<FlowTap["handled"]>[2],
    outcome: Call["outcome"],
  ) => {
    const recorded = calls.get(call);
    if (recorded !== undefined) {
      // Of several handlers of one call, the first that gave something is kept: a replay answers one. An unsettled
      // call keeps its mark, so its late answer, told later with the same call, changes nothing.
      recorded.outcome ??= outcome;
      return;
    }
    const made = { kind, node: call.name, outcome, variant: String(stateVar(call.instance)) };
    calls.set(call, made);
    step?.calls.push(made); // a call of a target whose recording has no step yet is left out
  };
  const leaveTap = addFlowTap({
    // A spread copies the own enumerable string-keyed props: the payload, without the signal's symbols.
    dispatched(target, signal) {
      const session = sessionOf(target);
      const step: Step = {
        abort: false,
        calls: [],
        fired: [],
        payload: { ...signal },
        signal: signal[Symbol.toStringTag],
        states: statesOf(target),
      };
      session.steps.push(step);
      session.stepOf.set(signal, step);
    },
    handled(target, kind, call, result) {
      note(sessions.get(target)?.steps.at(-1), kind, call, outcomeOf(result));
    },
    ended(target, step) {
      const paired = sessions.get(target)?.stepOf.get(step.signal);
      // the works of a transition its end listed; noted even with no step, so their late answers are known
      for (const call of step.unsettled) {
        note(paired, "transition", call, { unsettled: true });
      }
      if (paired === undefined) {
        return; // the end of a dispatch made before the recording saw the target
      }
      paired.abort = step.abort;
      paired.fired.push(
        ...step.fired.map(({ stateName, observerName }) => ({ node: stateName, observer: observerName })),
      );
      if (!refusedAbort.has(step.result.code ?? "")) {
        sessionOf(target).pending = step.transition === "temp";
      }
    },
  });
  return {
    record(target) {
      const { start, steps, pending } = sessionOf(target);
      // A first step sent as an abort aborted a transition that started before the recording.
      const cannotReplay =
        pending || steps[0]?.abort === true ? "a transition was pending where the record starts or ends" : null;
      return printValue({ cannotReplay, start, steps, stop: statesOf(target) } satisfies Recorded);
    },
    [Symbol.dispose]: leaveTap,
  };
}
/** What `result` gives the flow, as a record keeps it. */
function outcomeOf(result: Result): Call["outcome"] {
  const named = result instanceof HandlerResult ? result.named : null;
  if (named !== null) {
    return { data: named.data, named: named.name };
  }
  if (result.kind === ResultKind.Rejected) {
    return { data: result.data, rejected: result.message ?? "" };
  }
  if (result.error !== null) {
    return { error: { message: String(result.error.message), name: String(result.error.name) } };
  }
  return null;
}
