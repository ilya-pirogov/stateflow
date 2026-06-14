import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Result, ResultKind } from "../result";
import { defineSignal } from "../signal";

describe("Result", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Basic Result Creation", () => {
    it("should create an ignored result with message", () => {
      const result = Result.ignore("test message");
      expect(result.kind).toBe(ResultKind.Ignored);
      expect(result.message).toBe("test message");
      expect(result.error).toBeNull();
    });

    it("should create an ok result without data", () => {
      const result = Result.ok();
      expect(result.kind).toBe(ResultKind.OK);
      expect(result.message).toBeNull();
      expect(result.error).toBeNull();
    });

    it("should create an ok result with data", () => {
      const data = { test: "value" };
      const result = Result.ok(data);
      expect(result.kind).toBe(ResultKind.OK);
      expect(result.data).toEqual(data);
    });

    it("should create a rejected result with message", () => {
      const result = Result.reject("rejection reason");
      expect(result.kind).toBe(ResultKind.Rejected);
      expect(result.message).toBe("rejection reason");
    });

    it("should create an error result with Error instance", () => {
      const error = new Error("test error");
      const result = Result.error(error);
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error).toBe(error);
    });

    it("should create an error result from non-Error object", () => {
      const result = Result.error("string error");
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe("string error");
    });
  });

  describe("Result Timestamps", () => {
    it("should initialize timestamps to current time", () => {
      const now = Date.now();
      const result = Result.ok();
      expect(result.startedAt).toBe(now);
      expect(result.finishedAt).toBe(now);
    });

    it("should have equal startedAt and finishedAt for new results", () => {
      const result = Result.ignore("test");
      expect(result.startedAt).toBe(result.finishedAt);
    });

    it("should properly merge timestamps keeping min as startedAt and max as finishedAt", () => {
      const result1 = Result.ok();
      vi.advanceTimersByTime(100);
      const result2 = Result.ok();
      vi.advanceTimersByTime(50);

      const merged = result1.merge(result2);
      expect(merged.startedAt).toBe(result1.startedAt); // earlier timestamp
      expect(merged.finishedAt).toBe(result2.finishedAt); // later timestamp
    });

    it("should handle reverse timestamp order in merging", () => {
      const result1 = Result.ok();
      vi.advanceTimersByTime(100);
      const result2 = Result.ok();

      const merged = result2.merge(result1); // merge in reverse order
      expect(merged.startedAt).toBe(result1.startedAt); // still the earlier one
      expect(merged.finishedAt).toBe(result2.finishedAt); // still the later one
    });

    it("should handle equal timestamps correctly", () => {
      const result1 = Result.ok();
      const result2 = Result.ignore("test");

      const merged = result1.merge(result2);
      expect(merged.startedAt).toBe(result1.startedAt);
      expect(merged.finishedAt).toBe(result2.finishedAt);
    });

    it("should preserve timestamps across multiple merges", () => {
      const result1 = Result.ok();
      vi.advanceTimersByTime(50);
      const result2 = Result.ignore("test");
      vi.advanceTimersByTime(50);
      const result3 = Result.reject("reject");

      const merged = result1.merge(result2).merge(result3);
      expect(merged.startedAt).toBe(result1.startedAt); // earliest
      expect(merged.finishedAt).toBe(result3.finishedAt); // latest
    });

    it("should handle timestamp merging with complex scenarios", () => {
      // Create results with intentionally mixed timestamps
      const early = Date.now();
      const result1 = Result.ok();
      vi.advanceTimersByTime(200);
      const _middle = Date.now();
      const result2 = Result.ignore("middle");
      vi.advanceTimersByTime(100);
      const late = Date.now();
      const result3 = Result.error(new Error("late"));

      // Test various merge orders
      const merged1 = result3.merge(result1); // late.merge(early)
      expect(merged1.startedAt).toBe(early);
      expect(merged1.finishedAt).toBe(late);

      const merged2 = result2.merge(result3).merge(result1); // middle.merge(late).merge(early)
      expect(merged2.startedAt).toBe(early);
      expect(merged2.finishedAt).toBe(late);
    });

    it("should handle timestamp merging with identical timestamps", () => {
      const result1 = Result.ok();
      const result2 = Result.ignore("same time");

      const merged = result1.merge(result2);
      expect(merged.startedAt).toBe(result1.startedAt);
      expect(merged.finishedAt).toBe(result2.finishedAt);
      expect(merged.startedAt).toBe(merged.finishedAt); // Should be equal since created at same time
    });

    it("should handle timestamp merging across all result types", () => {
      const okResult = Result.ok({ data: "test" });
      vi.advanceTimersByTime(25);
      const ignoredResult = Result.ignore("ignored");
      vi.advanceTimersByTime(25);
      const rejectedResult = Result.reject("rejected");
      vi.advanceTimersByTime(25);
      const errorResult = Result.error(new Error("error"));

      // Test that all combinations preserve timestamps correctly
      const combinations = [
        [okResult, ignoredResult],
        [ignoredResult, rejectedResult],
        [rejectedResult, errorResult],
        [errorResult, okResult],
      ];

      combinations.forEach(([first, second]) => {
        const merged = first.merge(second);
        expect(merged.startedAt).toBeLessThan(merged.finishedAt);
      });
    });
  });

  describe("Result Merging", () => {
    it("should merge two ignored results combining messages and timestamps", () => {
      const result1 = Result.ignore("first message");
      vi.advanceTimersByTime(100);
      const result2 = Result.ignore("second message");
      const merged = result1.merge(result2);
      expect(merged.kind).toBe(ResultKind.Ignored);
      expect(merged.message).toBe("first message; second message");
      expect(merged.startedAt).toBe(result1.startedAt);
      expect(merged.finishedAt).toBe(result2.finishedAt);
    });

    it("should always prioritize error result when merging with ignored and preserve timestamps", () => {
      const error = new Error("test error");
      const result1 = Result.error(error);
      vi.advanceTimersByTime(50);
      const result2 = Result.ignore("ignored message");
      const merged = result1.merge(result2);
      expect(merged.kind).toBe(ResultKind.Error);
      expect(merged.error).toBe(error);
      expect(merged.startedAt).toBe(result1.startedAt);
      expect(merged.finishedAt).toBe(result2.finishedAt);
    });

    it("should always prioritize rejected result when merging with ignored and preserve timestamps", () => {
      const result1 = Result.reject("rejection reason");
      vi.advanceTimersByTime(75);
      const result2 = Result.ignore("ignored message");
      const merged = result1.merge(result2);
      expect(merged.kind).toBe(ResultKind.Rejected);
      expect(merged.message).toBe("rejection reason");
      expect(merged.startedAt).toBe(result1.startedAt);
      expect(merged.finishedAt).toBe(result2.finishedAt);
    });

    it("should always prioritize error result when merging with ok and preserve timestamps", () => {
      const error = new Error("test error");
      const result1 = Result.error(error);
      vi.advanceTimersByTime(25);
      const result2 = Result.ok();
      const merged = result1.merge(result2);
      expect(merged.kind).toBe(ResultKind.Error);
      expect(merged.error).toBe(error);
      expect(merged.startedAt).toBe(result1.startedAt);
      expect(merged.finishedAt).toBe(result2.finishedAt);
    });

    it("should always prioritize rejected result when merging with ok and preserve timestamps", () => {
      const result1 = Result.reject("rejection reason");
      vi.advanceTimersByTime(60);
      const result2 = Result.ok();
      const merged = result1.merge(result2);
      expect(merged.kind).toBe(ResultKind.Rejected);
      expect(merged.message).toBe("rejection reason");
      expect(merged.startedAt).toBe(result1.startedAt);
      expect(merged.finishedAt).toBe(result2.finishedAt);
    });

    it("should merge two ok results keeping the first data and merging timestamps", () => {
      const result1 = Result.ok({ first: true });
      vi.advanceTimersByTime(40);
      const result2 = Result.ok({ second: true });
      const merged = result1.merge(result2);
      expect(merged.kind).toBe(ResultKind.OK);
      expect(merged.data).toEqual({ first: true });
      expect(merged.startedAt).toBe(result1.startedAt);
      expect(merged.finishedAt).toBe(result2.finishedAt);
    });
  });

  describe("Transitions", () => {
    it("should handle successful transition with proper timestamp tracking", async () => {
      const startTime = Date.now();
      const transitionResult = Result.transition(async () => {
        return Result.ok("success");
      });
      expect(transitionResult.kind).toBe(ResultKind.InTransition);
      expect(transitionResult.startedAt).toBe(startTime);
      expect(transitionResult.finishedAt).toBe(startTime);

      const finalResult = await transitionResult.done();
      expect(finalResult.kind).toBe(ResultKind.OK);
      expect(finalResult.data).toBe("success");
      expect(finalResult.startedAt).toBe(startTime);
      expect(finalResult.finishedAt).toBe(startTime);
    });

    it("should handle failed transition with timestamp preservation", async () => {
      const error = new Error("transition failed");
      const startTime = Date.now();
      const transitionResult = Result.transition(async () => {
        throw error;
      });

      const finalResult = await transitionResult.done();
      expect(finalResult.kind).toBe(ResultKind.Error);
      expect(finalResult.error?.message).toBe("transition failed");
      expect(finalResult.startedAt).toBe(startTime);
      expect(finalResult.finishedAt).toBe(startTime);
    });

    it("should timeout transition after specified duration with correct timestamps", async () => {
      const startTime = Date.now();
      const transitionResult = Result.transition(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return Result.ok();
      }, 500);

      vi.advanceTimersByTime(600);
      const finalResult = await transitionResult.done();
      expect(finalResult.kind).toBe(ResultKind.Error);
      expect(finalResult.error?.message).toBe("timeout");
      expect(finalResult.startedAt).toBe(startTime);
      expect(finalResult.finishedAt).toBe(startTime + 600);
    });

    it("should track timestamps during async transition execution", async () => {
      const startTime = Date.now();
      const transitionResult = Result.transition(async () => {
        // Simulate some async work
        vi.advanceTimersByTime(100);
        return Result.ok("delayed");
      });

      const finalResult = await transitionResult.done();
      expect(finalResult.startedAt).toBe(startTime);
      expect(finalResult.finishedAt).toBeGreaterThanOrEqual(startTime + 100);
    });
  });

  describe("Result Expectations", () => {
    it("should not throw when result matches expected kind", () => {
      const result = Result.ok();
      expect(() => result.expect(ResultKind.OK)).not.toThrow();
    });

    it("should throw when result does not match expected kind", () => {
      const result = Result.error(new Error("test error"));
      expect(() => result.expect(ResultKind.OK)).toThrow();
    });

    it("should accept multiple expected kinds", () => {
      const result = Result.ok();
      expect(() => result.expect(ResultKind.OK, ResultKind.Ignored)).not.toThrow();
    });

    it("should check transition result after completion", async () => {
      const transition = Result.transition(async () => Result.ok());

      const final = await transition.done();
      expect(() => final.expect(ResultKind.OK)).not.toThrow();
    });

    it("should check transition result after completion and throw an error", async () => {
      const transition = Result.transition(async () => Result.error(new Error("err")));
      await expect(transition.expect(ResultKind.OK).done()).rejects.toThrow();
    });
  });

  describe("Result String Representation", () => {
    it("should convert ok result to string", () => {
      const result = Result.ok();
      expect(String(result)).toBe("OK");
    });

    it("should convert ignored result with message to string", () => {
      const result = Result.ignore("test message");
      expect(String(result)).toBe("Ignored: test message");
    });

    it("should convert error result to string", () => {
      const result = Result.error(new Error("test error"));
      expect(String(result)).toBe("Error: test error");
    });

    it("should convert rejected result to string", () => {
      const result = Result.reject("rejection reason");
      expect(String(result)).toBe("Rejected: rejection reason");
    });
  });

  describe("Result.enqueue", () => {
    const testSignal = defineSignal<{ value: number }>("test");

    it("should create OK result with enqueued signal", () => {
      const signal = testSignal({ value: 42 });
      const result = Result.enqueue(signal);

      expect(result.kind).toBe(ResultKind.OK);
      expect(result.enqueuedSignals).toHaveLength(1);
      expect(result.enqueuedSignals[0]).toBe(signal);
    });

    it("should show enqueue in string representation", () => {
      const signal = testSignal({ value: 42 });
      const result = Result.enqueue(signal);

      expect(String(result)).toContain("Enqueue(");
    });

    it("should propagate enqueued signals through OK merge", () => {
      const signal = testSignal({ value: 1 });
      const r1 = Result.enqueue(signal);
      const r2 = Result.ok();

      const merged = r1.merge(r2);
      expect(merged.enqueuedSignals).toHaveLength(1);
      expect(merged.enqueuedSignals[0]).toBe(signal);
    });

    it("should combine enqueued signals from both sides during merge", () => {
      const s1 = testSignal({ value: 1 });
      const s2 = testSignal({ value: 2 });
      const r1 = Result.enqueue(s1);
      const r2 = Result.enqueue(s2);

      const merged = r1.merge(r2);
      expect(merged.enqueuedSignals).toHaveLength(2);
      expect(merged.enqueuedSignals[0]).toBe(s1);
      expect(merged.enqueuedSignals[1]).toBe(s2);
    });

    it("should propagate enqueued signals through Error merge", () => {
      const signal = testSignal({ value: 1 });
      const r1 = Result.enqueue(signal);
      const r2 = Result.error(new Error("fail"));

      const merged = r1.merge(r2);
      expect(merged.kind).toBe(ResultKind.Error);
      expect(merged.enqueuedSignals).toHaveLength(1);
    });

    it("should propagate enqueued signals through Ignored merge", () => {
      const signal = testSignal({ value: 1 });
      const r1 = Result.ignore("msg");
      const r2 = Result.enqueue(signal);

      const merged = r1.merge(r2);
      expect(merged.kind).toBe(ResultKind.OK);
      expect(merged.enqueuedSignals).toHaveLength(1);
      expect(merged.enqueuedSignals[0]).toBe(signal);
    });
  });
});
