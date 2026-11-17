import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { type DispatchFn, dispatch } from "..";
import { HandlerResult, mergeResults, Result, ResultKind, StateResult, Verdict } from "../result";
import { defineSignal } from "../signal";
import { defineState } from "../state";

describe("Result", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const go = defineSignal("go");
  const job = defineState<{ n: number }>()
    .name("job")
    .signals({ go })
    .variant("idle", { initial: true })
    .variant("running")
    .variant("done")
    .variant("failed")
    .build();
  const other = defineState<{ n: number }>().name("other").signals({ go }).variant("a", { initial: true }).build();

  // Each kind a reducer or a handler builds, and the plain factories of both classes.
  const plain = [
    ["StateResult", StateResult],
    ["HandlerResult", HandlerResult],
  ] as const;

  describe("Building results", () => {
    it("Result is abstract: building one directly throws", () => {
      // The constructor is protected and the class abstract, so only a cast reaches it, as plain JavaScript would.
      const Abstract = Result as unknown as new (kind: ResultKind, reason: string) => Result;

      expect(() => new Abstract(ResultKind.OK, "")).toThrow(
        "Result is abstract: a reducer returns a StateResult, a handler a HandlerResult",
      );
    });

    it.each(plain)("%s builds Ignored, Rejected and Error results", (_name, Class) => {
      const ignored = Class.ignored("test message");
      expect(ignored).toBeInstanceOf(Class);
      expect(ignored.kind).toBe(ResultKind.Ignored);
      expect(ignored.message).toBe("test message");
      expect(ignored.error).toBeNull();
      expect(Class.ignored().message).toBeNull();

      const rejected = Class.rejected("rejection reason");
      expect(rejected).toBeInstanceOf(Class);
      expect(rejected.kind).toBe(ResultKind.Rejected);
      expect(rejected.message).toBe("rejection reason");

      const error = new Error("test error");
      const failed = Class.error(error);
      expect(failed).toBeInstanceOf(Class);
      expect(failed.kind).toBe(ResultKind.Error);
      expect(failed.error).toBe(error);
      expect(failed.message).toBeNull();
    });

    it.each(plain)("%s.error makes an Error of a thrown value that is not one, and never throws", (_name, Class) => {
      const fromString = Class.error("string error");
      expect(fromString.error).toBeInstanceOf(Error);
      expect(fromString.error?.message).toBe("string error");

      const thrown = Object.create(null);
      const noStringForm = Class.error(thrown);
      expect(noStringForm.kind).toBe(ResultKind.Error);
      expect(noStringForm.error?.message).toBe("a thrown value with no string form");
      expect(noStringForm.error?.cause).toBe(thrown);
    });

    it("HandlerResult.ok() is an OK with no message", () => {
      const result = HandlerResult.ok();
      expect(result).toBeInstanceOf(HandlerResult);
      expect(result.kind).toBe(ResultKind.OK);
      expect(result.message).toBeNull();
      expect(result.error).toBeNull();
    });

    it("StateResult.ok(instance) is an OK answering with that instance", () => {
      const next = job.done({ n: 1 });
      const result = StateResult.ok(next);

      expect(result).toBeInstanceOf(StateResult);
      expect(result.kind).toBe(ResultKind.OK);
      expect(result.answer).toEqual({ next, transition: null });
    });

    it("StateResult.transition(next, temp, failed, options) is an InTransition carrying next, failed, temp and the timeout", () => {
      const next = job.done({ n: 1 });
      const temp = job.running({ n: 0 });
      const failed = job.failed({ n: 0 });

      const result = StateResult.transition(next, temp, failed, { timeoutMs: 250 });

      expect(result.kind).toBe(ResultKind.InTransition);
      expect(result.answer).toEqual({ next, failed, transition: { temp, timeoutMs: 250 } });
      expect(StateResult.transition(next, temp, failed).answer?.transition?.timeoutMs, "the default timeoutMs").toBe(
        500,
      );
    });

    it("transition takes the options fourth, where they may be left out or hold no timeoutMs", () => {
      const next = job.done({ n: 1 });
      const temp = job.running({ n: 0 });
      const failed = job.failed({ n: 0 });
      const answers: Array<[string, StateResult, number]> = [
        ["no options", StateResult.transition(next, temp, failed), 500],
        ["the options", StateResult.transition(next, temp, failed, { timeoutMs: 40 }), 40],
        ["options without timeoutMs", StateResult.transition(next, temp, failed, {}), 500],
      ];
      for (const [label, result, timeoutMs] of answers) {
        expect(result.answer, label).toEqual({ next, failed, transition: { temp, timeoutMs } });
      }
    });

    it("StateResult's ignored, rejected and error carry no answer", () => {
      for (const result of [StateResult.ignored("x"), StateResult.rejected("x"), StateResult.error("x")]) {
        expect(result.answer, String(result)).toBeNull();
      }
    });

    it("ok takes an instance as next, and failed as an instance of next's state", () => {
      // These break the factory's types on purpose, hence the casts: a reducer answers with props by returning them.
      expect(() => StateResult.ok({ n: 1 } as never)).toThrow(
        "StateResult.ok takes a state instance; a reducer returns props bare",
      );
      const ok = StateResult.ok as (...args: unknown[]) => StateResult;
      const failedMessage = "StateResult.ok: failed must be an instance of next's state";
      expect(() => ok(job.done({ n: 1 }), { n: 0 })).toThrow(failedMessage);
      expect(() => ok(job.done({ n: 1 }), other.a({ n: 0 }))).toThrow(failedMessage);
      expect(() => ok(job.done({ n: 1 }), () => job.failed({ n: 0 }))).toThrow(failedMessage);
    });

    it("transition requires next, temp and failed: one missing, or one that is not an instance, throws", () => {
      // Called as plain JavaScript would call it: these arguments do not compile.
      const transition = StateResult.transition as (...args: unknown[]) => StateResult;
      const next = job.done({ n: 1 });
      const temp = job.running({ n: 0 });
      const failed = job.failed({ n: 0 });
      const nextMessage = "StateResult.transition takes a state instance as next; a reducer returns props bare";
      const tempMessage =
        "StateResult.transition takes a state instance as temp, the instance the node holds while the work runs";
      const failedMessage =
        "StateResult.transition takes failed, an instance of next's state, which the node takes when the work fails";
      const cases: Array<[string, unknown[], string]> = [
        ["nothing", [], nextMessage],
        ["props as next", [{ n: 1 }, temp, failed], nextMessage],
        ["next only", [next], tempMessage],
        ["no temp", [next, undefined, failed], tempMessage],
        ["props as temp", [next, { n: 0 }, failed], tempMessage],
        ["next and temp only", [next, temp], failedMessage],
        ["props as failed", [next, temp, { n: 0 }], failedMessage],
        ["a number as failed", [next, temp, 42], failedMessage],
        ["a function as failed", [next, temp, () => failed], failedMessage],
      ];
      for (const [label, args, message] of cases) {
        expect(() => transition(...args), label).toThrow(message);
      }
    });

    it("transition takes the options fourth only: options where temp or failed goes throw, and so do options that are no object or hold another key", () => {
      const transition = StateResult.transition as (...args: unknown[]) => StateResult;
      const next = job.done({ n: 1 });
      const temp = job.running({ n: 0 });
      const failed = job.failed({ n: 0 });
      expect(() => transition(next, { timeoutMs: 20 })).toThrow(
        "StateResult.transition takes a state instance as temp",
      );
      expect(() => transition(next, temp, { timeoutMs: 30 })).toThrow("StateResult.transition takes failed");
      // A number is no options object: read as one, it would leave the default 500 ms in place without a word.
      for (const options of [1000, null, "x"]) {
        expect(() => transition(next, temp, failed, options), String(options)).toThrow(
          "StateResult.transition: the options are an object { timeoutMs }",
        );
      }
      expect(() => transition(next, temp, failed, { timeout: 5 })).toThrow(
        "StateResult.transition: the options take timeoutMs only, not timeout",
      );
    });

    it("transition refuses next, temp and failed instances of two definitions", () => {
      const transition = StateResult.transition as (...args: unknown[]) => StateResult;
      const next = job.done({ n: 1 });
      const temp = job.running({ n: 0 });
      const failed = job.failed({ n: 0 });
      const notOneDefinition =
        "StateResult.transition: next, temp and failed must be instances of one state definition";
      expect(() => transition(next, other.a({ n: 0 }), failed)).toThrow(notOneDefinition);
      expect(() => transition(next, temp, other.a({ n: 0 }))).toThrow(notOneDefinition);
    });

    it("transition refuses a timeoutMs that is not a positive finite number up to 2_147_483_647", () => {
      const [next, temp, failed] = [job.done({ n: 1 }), job.running({ n: 0 }), job.failed({ n: 0 })];
      for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        expect(() => StateResult.transition(next, temp, failed, { timeoutMs }), String(timeoutMs)).toThrow(
          "StateResult.transition: timeoutMs must be a positive finite number <= 2147483647",
        );
      }
      expect(
        StateResult.transition(next, temp, failed, { timeoutMs: 2_147_483_647 }).answer?.transition?.timeoutMs,
      ).toBe(2_147_483_647);
    });

    it("send() and dispatch() return a Result", () => {
      expectTypeOf(dispatch).returns.toEqualTypeOf<Result>();
      expectTypeOf<DispatchFn>().returns.toEqualTypeOf<Result>();
    });
  });

  describe("Merging", () => {
    // Every kind merge ranks, lowest first: Ignored < OK < Rejected < Error.
    const ranked = (): Result[] => [
      HandlerResult.ignored("ignored"),
      HandlerResult.ok(),
      HandlerResult.rejected("rejected"),
      HandlerResult.error(new Error("error")),
    ];

    it("Error > Rejected > OK > Ignored, whichever side the higher kind is on", () => {
      for (const [i, low] of ranked().entries()) {
        for (const high of ranked().slice(i + 1)) {
          const label = `${String(low)} with ${String(high)}`;
          expect(low.merge(high).kind, label).toBe(high.kind);
          expect(high.merge(low).kind, label).toBe(high.kind);
          expect(String(low.merge(high)), label).toBe(String(high));
          expect(String(high.merge(low)), label).toBe(String(high));
        }
      }
    });

    it("a merge is a new result with no data: two answers merge to an OK that answers nothing", () => {
      const a = StateResult.ok(job.done({ n: 1 }));
      const b = StateResult.ok(job.failed({ n: 2 }));

      const merged = a.merge(b);

      expect(merged.kind).toBe(ResultKind.OK);
      expect(merged).not.toBe(a);
      expect(merged).not.toBe(b);
      expect(merged).not.toBeInstanceOf(StateResult);
      expect(merged).not.toBeInstanceOf(HandlerResult);
      // The receiver of a winning merge is a new result too.
      const rejected = HandlerResult.rejected("no");
      expect(rejected.merge(HandlerResult.ok())).not.toBe(rejected);
    });

    it("of one kind the first wins", () => {
      const first = HandlerResult.rejected("first");
      const second = HandlerResult.rejected("second");
      expect(first.merge(second).message).toBe("first");
      expect(second.merge(first).message).toBe("second");
    });

    it("two Ignored join their messages, leaving out an empty one", () => {
      const first = HandlerResult.ignored("first message");
      vi.advanceTimersByTime(100);
      const second = HandlerResult.ignored("second message");

      const merged = first.merge(second);

      expect(merged.kind).toBe(ResultKind.Ignored);
      expect(merged.message).toBe("first message; second message");
      expect(HandlerResult.ignored().merge(second).message).toBe("second message");
      expect(HandlerResult.ignored().merge(HandlerResult.ignored()).message).toBeNull();
    });

    it('two Errors become one Error whose error is an AggregateError of both, message "a; b", never "null; null"', () => {
      const a = new Error("a");
      const b = new TypeError("b");

      const merged = HandlerResult.error(a).merge(StateResult.error(b));

      expect(merged.kind).toBe(ResultKind.Error);
      expect(merged.error).toBeInstanceOf(AggregateError);
      expect((merged.error as AggregateError).errors).toEqual([a, b]);
      expect(merged.error?.message).toBe("a; b");
      expect(String(merged)).toBe("AggregateError: a; b");
      // A third Error joins in order. Each merge aggregates its two sides, so the first two stay one
      // AggregateError inside the new one.
      const c = new Error("c");
      const three = merged.merge(HandlerResult.error(c));
      expect(three.error?.message).toBe("a; b; c");
      expect((three.error as AggregateError).errors).toEqual([merged.error, c]);
    });

    it("the merged result keeps the winner's handler and state, so its expect() names them", () => {
      const winner = HandlerResult.rejected("not now").withHandlerName("guard").withStateUpdating("exit light");
      const loser = HandlerResult.ok().withHandlerName("other").withStateUpdating("enter light");

      for (const merged of [winner.merge(loser), loser.merge(winner)]) {
        expect(() => merged.expect(ResultKind.OK)).toThrow(
          "[SF] Result in handler 'guard()' was rejected while trying to exit light: Message: not now",
        );
      }
    });

    it("expect() on an Error result says the handler threw, and the state change it was making", () => {
      const thrown = HandlerResult.error(new Error("boom")).withHandlerName("open").withStateUpdating("enter media");

      expect(() => thrown.expect(ResultKind.OK)).toThrow(
        "[SF] Result in handler 'open()' threw an error while trying to enter media: Error: boom",
      );
    });

    it("mergeResults folds left into a new result: Ignored for none, and a copy keeping the handler and state of a single one of any kind", () => {
      expect(String(mergeResults([]))).toBe("Ignored");
      const results = [
        HandlerResult.ignored("x"),
        HandlerResult.ok(),
        HandlerResult.rejected("x"),
        HandlerResult.error(new Error("x")),
      ];
      for (const result of results) {
        const named = result.withHandlerName("h").withStateUpdating("enter s");

        const merged = mergeResults([named]);

        expect(merged, String(result)).not.toBe(named);
        expect(String(merged), String(result)).toBe(String(named));
        // expect() names the handler and the state change of a result whatever its kind.
        expect(() => merged.expect(ResultKind.InTransition), String(result)).toThrow(
          /in handler 'h\(\)' .* while trying to enter s/,
        );
      }
      // Of two Ignored the first keeps its handler.
      const first = HandlerResult.ignored("a").withHandlerName("first");
      expect(() => mergeResults([first, HandlerResult.ignored("b")]).expect(ResultKind.OK)).toThrow(
        "[SF] Result in handler 'first()' was ignored: Message: a; b",
      );
    });

    it("merging InTransition throws, also through mergeResults of it alone: a declared or a pending transition is not a verdict", () => {
      const declared = StateResult.transition(job.done({ n: 1 }), job.running({ n: 0 }), job.failed({ n: 0 }));
      const pending = Verdict.pending(Promise.resolve(Verdict.ok()));
      const refusal = "a pending or declared transition result cannot be merged or copied";
      expect(() => declared.merge(HandlerResult.ok())).toThrow(refusal);
      expect(() => HandlerResult.ignored("x").merge(pending)).toThrow(refusal);
      expect(() => mergeResults([declared])).toThrow(refusal);
      expect(() => mergeResults([pending])).toThrow(refusal);
    });
  });

  describe("Timestamps", () => {
    it("a new result starts and finishes now", () => {
      const now = Date.now();
      const result = HandlerResult.ok();
      expect(result.startedAt).toBe(now);
      expect(result.finishedAt).toBe(now);
    });

    it("a merge spans both results' times, on either side", () => {
      const early = HandlerResult.ok();
      vi.advanceTimersByTime(100);
      const late = HandlerResult.error(new Error("late"));

      for (const merged of [early.merge(late), late.merge(early)]) {
        expect(merged.startedAt).toBe(early.startedAt);
        expect(merged.finishedAt).toBe(late.finishedAt);
      }
    });

    it("a merge of merges spans every result", () => {
      const first = HandlerResult.ok();
      vi.advanceTimersByTime(50);
      const second = HandlerResult.ignored("test");
      vi.advanceTimersByTime(50);
      const third = HandlerResult.rejected("reject");

      const merged = first.merge(second).merge(third);

      expect(merged.startedAt).toBe(first.startedAt);
      expect(merged.finishedAt).toBe(third.finishedAt);
    });
  });

  describe("Expectations", () => {
    it("expect() passes a result of an expected kind and throws for any other", () => {
      expect(() => HandlerResult.ok().expect(ResultKind.OK)).not.toThrow();
      expect(() => HandlerResult.ok().expect(ResultKind.OK, ResultKind.Ignored)).not.toThrow();
      expect(() => HandlerResult.error(new Error("test error")).expect(ResultKind.OK)).toThrow();
    });

    it("a pending result's done() resolves to its outcome, and its expect() applies to that outcome", async () => {
      const ok = await Verdict.pending(Promise.resolve(Verdict.ok())).done();
      expect(ok.kind).toBe(ResultKind.OK);

      const failing = Verdict.pending(Promise.resolve(Verdict.error(new Error("err"))));
      await expect(failing.expect(ResultKind.OK).done()).rejects.toThrow();
    });

    it("done() of any other result resolves to the result itself", async () => {
      const result = HandlerResult.rejected("no");
      expect(await result.done()).toBe(result);
    });
  });

  it("the string form is the kind, with the message of an Ignored or a Rejected, or the error of an Error", () => {
    expect(String(HandlerResult.ok())).toBe("OK");
    expect(String(StateResult.ok(job.done({ n: 1 })))).toBe("OK");
    expect(String(HandlerResult.ignored("test message"))).toBe("Ignored: test message");
    expect(String(StateResult.rejected("rejection reason"))).toBe("Rejected: rejection reason");
    expect(String(HandlerResult.error(new Error("test error")))).toBe("Error: test error");
  });

  it("the string tag is Result.<kind>, a string as every tag of the library is", () => {
    expect(Object.prototype.toString.call(StateResult.rejected("no"))).toBe("[object Result.Rejected]");
    expect(HandlerResult.ok()[Symbol.toStringTag]).toBe("Result.OK");
  });
});
