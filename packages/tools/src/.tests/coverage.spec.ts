import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  HandlerResult,
  type Items,
  lock,
  StateResult,
} from "@state-flow/core";
import { expect, it } from "vitest";
import {
  driverState,
  media,
  producer,
  recordingWorld,
  runCounterExample,
  runPlayerExample,
  runSessionExample,
  transport,
} from "../../../core/examples/examples";
import { coverageGate, neverAnswers, startCoverage, TestClock } from "..";

const PLAYER = [
  "variant driver.idle",
  "signal driver.idle play",
  "variant driver.activating",
  "signal driver.activating stop",
  "end driver.activating final",
  "end driver.activating failed",
  "end driver.activating timeout",
  "end driver.activating abort",
  "variant driver.active",
  "signal driver.active stop",
  "variant driver.failed",
  "signal driver.failed stop",
];
it("measures the examples' scenarios, lists what they miss, and gates on a level", async () => {
  // The counter's definitions are not exported, so its scenario reaches no item.
  using coverage = startCoverage([driverState, media, producer, transport]);
  await runCounterExample(recordingWorld().world);
  await runPlayerExample(recordingWorld().world);
  // Read in the middle of a run: right for what has ended, the player's items alone.
  expect(coverage.report().reached).toEqual([...PLAYER, "refusal driver.active transition"]);
  await runSessionExample(recordingWorld().world);
  const report = coverage.report();
  // The timeout's late answer and the answer to stop's abort are no refusal of driver.active's work; no manifest is.
  expect(report.missing).toEqual([
    "signal driver.failed play",
    "signal media.opening close",
    "end media.opening failed",
    "end media.opening timeout",
    "end media.opening abort",
    "end producer.creating failed",
    "end producer.creating timeout",
    "signal producer.active resume",
    "variant producer.failed",
    "refusal driver.active enter",
    "refusal driver.active exit",
    "refusal transport.open transition",
    "refusal transport.open exit",
    "refusal producer.active transition",
    "refusal producer.active update",
    "refusal producer.active exit",
  ]);
  expect(report.level).toBe(31 / 47);
  expect(() => coverageGate(report, 32 / 47)).toThrow(
    `coverage ${31 / 47} is below ${32 / 47}; not reached:\n${report.missing.join("\n")}`,
  );
  coverageGate(report, 31 / 47);
});

// A job starts through a declared transition whose work is running's transition handler; back aborts it.
const jobSignals = { start: defineSignal("start"), back: defineSignal("back") };
const job = defineState<{ n: number }>()
  .name("job")
  .signals(jobSignals)
  .variant("idle", { initial: true })
  .variant("starting", { transitional: true })
  .variant("running", { async: true })
  .variant("failed")
  .build();
defineFlow(job.idle, {
  start: (s) => StateResult.transition(job.running(s), job.starting(s), job.failed(s), { timeoutMs: 100 }),
});
defineFlow(job.starting, { back: (s) => job.idle(s) });
type Work = (...args: Parameters<typeof neverAnswers>) => Promise<HandlerResult>;
/**
 * A job on `clock` whose start waits for `work`. Every Job is a flow of one name. Its commit handler is no item: the
 * tap is not told of one.
 */
class Job {
  readonly job = { n: 0 };
  constructor(clock: TestClock, work: Work) {
    applyFlow(
      this,
      [job],
      (sm) => {
        sm.addTransitionHandler(job.running, work);
        sm.addCommitHandler(job.running, () => {});
      },
      { timers: clock },
    );
  }
}
it("takes no work that gives back its abort's reason, on an abort, a timeout or disposeFlow, as a refusal", async () => {
  const clock = new TestClock();
  using coverage = startCoverage([job]);
  const aborted = new Job(clock, neverAnswers);
  const starting = clock.send(aborted, jobSignals.start());
  await clock.idle();
  await dispatch(aborted, jobSignals.back(), { abort: true }).done();
  await starting;
  const timing = clock.send(new Job(clock, neverAnswers), jobSignals.start());
  await clock.advance(100);
  await timing;
  const disposed = new Job(clock, neverAnswers);
  const pending = clock.send(disposed, jobSignals.start());
  await clock.idle();
  disposeFlow(disposed);
  await pending;
  await clock.idle();
  expect(coverage.report().missing).toEqual([
    "end job.starting final",
    "end job.starting failed",
    "variant job.running",
    "refusal job.running transition",
  ]);
});
it("counts one target's refusal while another target of its flow name waits for an abort", async () => {
  const clock = new TestClock();
  using coverage = startCoverage([job]);
  let refuse = () => {};
  const refusing = new Job(
    clock,
    () =>
      new Promise((resolve) => {
        refuse = () => resolve(HandlerResult.rejected("no"));
      }),
  );
  // A work that never answers, not even its abort: the abort waits for the transition's deadline.
  const waiting = new Job(clock, () => new Promise(() => {}));
  const sends = [clock.send(refusing, jobSignals.start()), clock.send(waiting, jobSignals.start())];
  await clock.idle();
  const back = dispatch(waiting, jobSignals.back(), { abort: true }).done();
  refuse();
  await clock.idle();
  expect(coverage.report().reached).toEqual(
    expect.arrayContaining(["refusal job.running transition", "end job.starting failed"]),
  );
  expect(coverage.report().reached).not.toContain("end job.starting abort");
  await clock.advance(100);
  await Promise.all([...sends, back]);
  expect(coverage.report().reached).toContain("end job.starting abort");
});
it("lets a loop run scenarios until the level is reached", async () => {
  const clock = new TestClock();
  using coverage = startCoverage([job]);
  const scenarios = [
    () => clock.send(new Job(clock, async () => HandlerResult.ok()), jobSignals.start()),
    () => clock.send(new Job(clock, async () => HandlerResult.rejected("no")), jobSignals.start()),
    async () => {
      const timing = clock.send(new Job(clock, neverAnswers), jobSignals.start());
      await clock.advance(100);
      await timing;
    },
    async () => {
      const aborted = new Job(clock, neverAnswers);
      const starting = clock.send(aborted, jobSignals.start());
      await clock.idle();
      await dispatch(aborted, jobSignals.back(), { abort: true }).done();
      await starting;
    },
  ];
  let ran = 0;
  while (coverage.report().level < 1) {
    await scenarios[ran]();
    ran += 1;
  }
  expect(ran).toBe(4);
});
it("counts a refusal of a work's own reason, given to its abort, as a refusal", async () => {
  const clock = new TestClock();
  using coverage = startCoverage([job]);
  const aborted = new Job(
    clock,
    (_next, _snapshot, _prev, _key, signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(HandlerResult.rejected("cancelled")))),
  );
  const starting = clock.send(aborted, jobSignals.start());
  await clock.idle();
  await dispatch(aborted, jobSignals.back(), { abort: true }).done();
  await starting;
  expect(coverage.report().reached).toContain("refusal job.running transition");
});
it("gives level 0 when no definition is named, and the gate fails above it", () => {
  using coverage = startCoverage([]);
  expect(coverage.report().level).toBe(0);
  expect(() => coverageGate(coverage.report(), 1)).toThrow("coverage 0 is below 1");
});
it("makes a collection's phases items when an item held from the start only updates in its variant", async () => {
  const leaf = defineState<{ v: number }>().name("leaf").variant("a", { initial: true }).variant("b").build();
  const bump = { bump: defineSignal<{ key: string }>("bump") };
  const tree = defineState<{ leaves: Items<typeof leaf> }>()
    .name("tree")
    .signals(bump)
    .variant("t", { initial: true })
    .build();
  defineFlow(tree.t, { bump: (s, { key }) => tree.t({ leaves: s.leaves.with(key, leaf.a({ v: 1 })) }) });
  using coverage = startCoverage([tree, leaf]);
  // A collection of a definition that is not named has no phases.
  using treeAlone = startCoverage([tree]);
  const target = { tree: { leaves: leaf.items() } };
  applyFlow(target, [tree], () => {}, {
    start: { tree: tree.t({ leaves: leaf.items().with("k", leaf.a({ v: 0 })) }) },
  });
  {
    await using send = await lock(target);
    await send(bump.bump({ key: "k" })).done();
  }
  expect(coverage.report().missing).toEqual([
    "variant leaf.b",
    "phase tree.leaves[] entered",
    "phase tree.leaves[] changed",
    "phase tree.leaves[] left",
  ]);
  expect(treeAlone.report().missing).toEqual([]);
});
