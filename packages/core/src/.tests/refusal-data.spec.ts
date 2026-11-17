import { afterEach, describe, expect, it } from "vitest";

import {
  addFlowTap,
  addGlobalLogHandler,
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  type FailureData,
  HandlerResult,
  type Result,
  ResultKind,
  type StateFlowLogEntry,
  type StateInstance,
  type StateManager,
  StateResult,
} from "..";

/**
 * A handler's refusal may carry plain data (HandlerResult.rejected(message, data)). The failed end's FAILURE reducer
 * receives it as `data` beside the kind and the reason, and a tap is told it on the handler's result, so a recording
 * of the session can feed it back. A refusal without data is as it was before.
 */
describe("the data of a handler's refusal", () => {
  const load = defineSignal("load");
  const open = defineSignal("open");

  type Props = { tries: number; retry: boolean | null; failure: FailureData | null };
  const job = defineState<Props>()
    .name("job")
    .signals({ load, open })
    .variant("idle", { initial: true })
    .variant("loading", { transitional: true })
    .variant("loaded", { async: true })
    .variant("opened")
    .variant("failed")
    .build();
  defineFlow(job.idle, {
    load: (s) => StateResult.transition(job.loaded(s), job.loading(s), job.failed({ ...s, tries: s.tries + 1 })),
    open: (s) => StateResult.ok(job.opened(s), job.failed({ ...s, tries: s.tries + 1 })),
  });
  // An abort of the load: open sent while it loads.
  defineFlow(job.loading, { open: (s) => job.opened(s) });
  // The failed end decides from the data alone: whether the refusal is for good.
  defineFlow(job.failed, {}, { [FAILURE]: (s, failure) => ({ ...s, retry: failure.data?.final !== true, failure }) });

  type Target = { job: StateInstance<Props> };
  function make(init: (sm: StateManager) => void): Target {
    const target = { job: { tries: 0, retry: null, failure: null } };
    applyFlow(target, [job], init);
    return target as unknown as Target;
  }

  const removals: Array<() => void> = [];
  afterEach(() => {
    for (const remove of removals.splice(0)) {
      remove();
    }
  });

  it("a transition handler's refusal with data reaches the failed end's reducer, which decides from the data alone", async () => {
    const final = make((sm) =>
      sm.addTransitionHandler(job.loaded, async () => HandlerResult.rejected("no", { final: true })),
    );
    const again = make((sm) =>
      sm.addTransitionHandler(job.loaded, async () => HandlerResult.rejected("no", { final: false })),
    );

    await dispatch(final, load()).done();
    await dispatch(again, load()).done();

    expect(final.job.retry).toBe(false);
    expect(again.job.retry).toBe(true);
    expect(final.job.failure).toEqual({ kind: "rejected", reason: "no", error: undefined, data: { final: true } });
  });

  it("an enter handler's refusal of a failed step carries its data the same way, and the dispatch's result holds it", () => {
    const target = make((sm) => sm.addEnterHandler(job.opened, () => HandlerResult.rejected("no", { final: true })));

    const result = dispatch(target, open());

    expect(target.job.retry).toBe(false);
    expect(result.data).toEqual({ final: true });
  });

  it("a refused abort's step carries its data to the aborted transition's failed, as kind aborted", async () => {
    const target = make((sm) => {
      // A load that stops when it is aborted.
      sm.addTransitionHandler(
        job.loaded,
        (_next, _snapshot, _prev, _key, signal) =>
          new Promise<HandlerResult>((resolve) => signal.addEventListener("abort", () => resolve(HandlerResult.ok()))),
      );
      sm.addEnterHandler(job.opened, () => HandlerResult.rejected("no", { final: true }));
    });

    dispatch(target, load());
    await dispatch(target, open(), { abort: true }).done();

    expect(target.job.failure).toEqual({ kind: "aborted", reason: "no", error: undefined, data: { final: true } });
  });

  it("of two refusals that merge, the earlier keeps its data; an Error that wins carries none", () => {
    const twoRejected = make((sm) => {
      sm.addEnterHandler(job.opened, () => HandlerResult.rejected("first", { final: true }));
      sm.addEnterHandler(job.opened, () => HandlerResult.rejected("second", { final: false }));
    });
    const errorWins = make((sm) => {
      sm.addEnterHandler(job.opened, () => HandlerResult.rejected("first", { final: true }));
      sm.addEnterHandler(job.opened, () => HandlerResult.error(new Error("boom")));
    });

    const merged = dispatch(twoRejected, open());
    dispatch(errorWins, open());

    expect(merged.data).toEqual({ final: true });
    expect(twoRejected.job.failure?.data).toEqual({ final: true });
    expect(errorWins.job.failure?.kind).toBe("error");
    expect(errorWins.job.failure).not.toHaveProperty("data");
  });

  it("the failed end gets a frozen copy, as a signal gets its payload, so props that keep it leave the handler's object alone", () => {
    const given = { final: true };
    const target = make((sm) => sm.addEnterHandler(job.opened, () => HandlerResult.rejected("no", given)));

    dispatch(target, open());
    given.final = false;

    expect(target.job.failure?.data).toEqual({ final: true });
    expect(Object.isFrozen(given)).toBe(false);
  });

  it("what the data holds deeper stays the handler's object, neither copied nor frozen, as in a signal's payload", () => {
    const given = { detail: { status: 404 } };
    const target = make((sm) => sm.addEnterHandler(job.opened, () => HandlerResult.rejected("no", given)));

    dispatch(target, open());
    given.detail.status = 410;

    expect(target.job.failure?.data?.detail).toBe(given.detail);
    expect(Object.isFrozen(given.detail)).toBe(false);
    expect(target.job.failure?.data).toEqual({ detail: { status: 410 } });
  });

  it("onCommit keeps the data of the refusal it is called on", () => {
    const target = make((sm) =>
      sm.addEnterHandler(job.opened, () => HandlerResult.rejected("no", { final: true }).onCommit(() => {})),
    );

    dispatch(target, open());

    expect(target.job.failure?.data).toEqual({ final: true });
  });

  it("a refusal without data is as before: no data key for the reducer, the same text, log entry and result", async () => {
    const entries: StateFlowLogEntry[] = [];
    removals.push(addGlobalLogHandler((entry) => entries.push(entry)));
    const target = make((sm) => sm.addEnterHandler(job.opened, () => HandlerResult.rejected("no")));

    const result = dispatch(target, open());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(Object.keys(target.job.failure ?? {})).toEqual(["kind", "reason", "error"]);
    expect(result.data).toBeUndefined();
    expect(String(result)).toBe("Rejected: no");
    expect(entries.map((entry) => [entry.finalResult, entry.finalResultData])).toEqual([
      ["Rejected: no", { kind: "Rejected", message: "no", code: null, errors: [] }],
    ]);
  });

  it("a tap is told the data on the handler's result; an outcome rebuilt from the recorded plain data reaches the same state", async () => {
    // What a recorder keeps of each transition handler's outcome: its kind, message and data, as a file holds them.
    const recorded: string[] = [];
    removals.push(
      addFlowTap({
        dispatched: () => {},
        handled: (_target, kind, _call, result: Result) => {
          if (kind === "transition") {
            recorded.push(JSON.stringify({ kind: result.kind, message: result.message, data: result.data }));
          }
        },
        ended: () => {},
      }),
    );
    const live = make((sm) =>
      sm.addTransitionHandler(job.loaded, async () => HandlerResult.rejected("gone", { final: true, code: 410 })),
    );
    await dispatch(live, load()).done();

    expect(recorded).toEqual([
      JSON.stringify({ kind: ResultKind.Rejected, message: "gone", data: { final: true, code: 410 } }),
    ]);

    const outcome = JSON.parse(recorded[0]);
    const replayed = make((sm) =>
      sm.addTransitionHandler(job.loaded, async () => HandlerResult.rejected(outcome.message, outcome.data)),
    );
    await dispatch(replayed, load()).done();

    expect(String(replayed.job)).toBe(String(live.job));
    expect(replayed.job).toEqual(live.job);
  });
});
