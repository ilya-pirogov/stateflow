import { EventEmitter } from "node:events";
import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  type Infer,
  mockHandlers,
  ResultKind,
  StateResult,
  stateVar,
} from "@state-flow/core";
import { expect, it } from "vitest";
import { handlersOff, neverAnswers, recordEvents, TestClock } from "..";

it("now reads the clock's time, which only advance moves", async () => {
  const clock = new TestClock();
  await clock.advance(250);
  await clock.idle();
  expect(clock.now).toBe(250);
});
it("send resolves with the end, a refusal included, once the deliveries ran; on a silent world it waits for the clock", async () => {
  const signals = { go: defineSignal("go"), stop: defineSignal("stop") };
  const job = defineState<{ n: number }>()
    .name("job")
    .signals(signals)
    .variant("idle", { initial: true })
    .variant("waiting", { transitional: true })
    .variant("done", { async: true })
    .build();
  defineFlow(job.idle, {
    go: (s) => StateResult.transition(job.done(s), job.waiting(s), job.idle(s), { timeoutMs: 100 }),
    stop: () => StateResult.rejected("nothing to stop"),
  });
  defineFlow(job.waiting, {});
  defineFlow(job.done, {});
  class Target extends EventEmitter {
    readonly job: Infer<typeof job> = { n: 0 };
  }
  using _off = handlersOff();
  using _world = mockHandlers(job.done, { transition: neverAnswers });
  const clock = new TestClock();
  const target = new Target();
  applyFlow(
    target,
    [job],
    (sm) =>
      sm.defineEvent(
        "job",
        (cur, prev) => cur.job !== prev.job,
        (cur) => String(stateVar(cur.job)),
      ),
    { timers: clock },
  );
  const events = recordEvents(target, "job");
  expect((await clock.send(target, signals.stop())).kind).toBe(ResultKind.Rejected);
  let ended = false;
  const going = clock.send(target, signals.go()).then((result) => {
    ended = true;
    return result;
  });
  await clock.idle();
  expect([ended, String(stateVar(target.job))]).toEqual([false, "job.waiting"]);
  await clock.advance(100);
  await going;
  // The timeout's failed end committed, and its event was delivered before send resolved.
  expect(events).toEqual([
    ["job", "job.waiting"],
    ["job", "job.idle"],
  ]);
});
it("recordEvents keeps the order of emissions across the names it records", () => {
  const target = new EventEmitter();
  const records = recordEvents(target, "a", "b");
  target.emit("a", 1);
  target.emit("c", 2);
  target.emit("b", 3);
  target.emit("a", 4);
  expect(records).toEqual([
    ["a", 1],
    ["b", 3],
    ["a", 4],
  ]);
});
