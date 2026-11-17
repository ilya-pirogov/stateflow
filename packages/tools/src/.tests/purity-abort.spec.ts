import {
  applyFlow,
  Box,
  DisposableBox,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  FrozenSet,
  HandlerResult,
  type Items,
  lock,
  mockHandlers,
  ResultKind,
  StateResult,
  type TransitionHandler,
} from "@state-flow/core";
import { expect, it } from "vitest";
import * as examples from "../../../core/examples/examples";
import { checkAbort, checkPurity, neverAnswers } from "..";

const { driverState, producer, recordingWorld, transport } = examples;
const scenarios = [examples.runCounterExample, examples.runPlayerExample, examples.runSessionExample];
// A note is opened, then written twice. Each reducer of `write` sits in a definition of its own; `open` is pure.
const noteSignals = { open: defineSignal("open"), write: defineSignal<{ text: string; at: number }>("write") };
type NoteProps = { text: string; extra: unknown };
function defineNote(write: (s: NoteProps, payload: { text: string; at: number }) => NoteProps) {
  const note = defineState<NoteProps>().name("note").signals(noteSignals).variant("closed", { initial: true });
  const built = note.variant("open").build();
  defineFlow(built.closed, { open: (s) => built.open(s) });
  defineFlow(built.open, { write });
  return built;
}
const now = () => Date.now();
let calls = 0;
let last = ""; // now: the clock through a helper the static rule misses
const notes = {
  clock: defineNote((_s, { text }) => ({ text, extra: now() })),
  random: defineNote((_s, { text }) => ({ text, extra: Math.random() })),
  counter: defineNote((_s, { text }) => ({ text, extra: ++calls })),
  remembered: defineNote((_s, { text }) => {
    const before = last;
    last = text;
    return { text, extra: before };
  }),
  pure: defineNote((s, { text, at }) => ({
    text,
    extra: { box: Box.of({ text }), seen: new FrozenSet([s.text, text]), at },
  })),
};
/** Opens a note and writes it twice, sending the time it read, as a method does. */
async function writeNote(kind: keyof typeof notes): Promise<void> {
  const target = { note: { text: "", extra: null } };
  applyFlow(target, [notes[kind]], () => {});
  await using send = await lock(target);
  const at = Date.now();
  for (const signal of [
    noteSignals.open(),
    noteSignals.write({ text: "a", at }),
    noteSignals.write({ text: "b", at }),
  ]) {
    await send(signal).expect(ResultKind.OK).done();
  }
}
it("names a reducer that reads the clock, a random number, a counter or a remembered value; passes a pure one", async () => {
  for (const kind of ["clock", "random", "counter", "remembered"] as const) {
    expect(await checkPurity(() => writeNote(kind)), kind).toEqual({ state: "note", signal: "write" });
  }
  expect(await checkPurity(() => writeNote("pure"))).toBeNull();
});
// A loader's result reducer and its failed's FAILURE reducer read the clock; both run at the transition's end.
const loadSignals = { go: defineSignal("go"), stop: defineSignal("stop"), mark: defineSignal<{ at: number }>("mark") };
const loader = defineState<{ at: number }>()
  .name("loader")
  .signals(loadSignals)
  .variant("idle", { initial: true })
  .variant("loading", { transitional: true })
  .variant("done", { async: true, results: { got: (data) => data as { v: number } } })
  .variant("failed")
  .build();
defineFlow(loader.idle, {
  go: (s) => StateResult.transition(loader.done(s), loader.loading(s), loader.failed(s)),
  mark: (s, { at }) => ({ ...s, at }),
});
defineFlow(loader.loading, { stop: (s) => loader.idle(s) });
defineFlow(loader.done, {}, { got: (s) => ({ ...s, at: now() }) });
defineFlow(loader.failed, {}, { [FAILURE]: (s) => ({ ...s, at: now() }) });
async function load(): Promise<void> {
  const target = { loader: { at: 0 } };
  applyFlow(target, [loader], () => {});
  await using send = await lock(target);
  await send(loadSignals.go()).done();
}
it("names a result or FAILURE reducer that reads the clock at a transition's end", async () => {
  const answers = {
    afterTurn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return loader.done.results.got({ v: 1 });
    },
    atOnce: async () => loader.done.results.got({ v: 1 }),
    rejects: async () => HandlerResult.rejected("no"),
  };
  for (const [name, transition] of Object.entries(answers)) {
    using _mock = mockHandlers(loader.done, { transition });
    expect(await checkPurity(load), name).toEqual({ state: "loader", signal: "go" });
  }
});
it("passes a pure reducer whose caller reads the clock while an abort waits for its work", async () => {
  // The work answers its abort 5 ms late; meanwhile the run reads the clock and later sends what it read.
  using _mock = mockHandlers(loader.done, {
    transition: (_n, _s, _p, _k, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => setTimeout(() => reject(signal.reason), 5));
      }),
  });
  const run = async () => {
    const target = { loader: { at: 0 } };
    applyFlow(target, [loader], () => {});
    const loading = (async () => {
      await using send = await lock(target);
      await send(loadSignals.go()).done();
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopping = dispatch(target, loadSignals.stop(), { abort: true }).done();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const at = Date.now();
    await stopping;
    await loading.catch(() => {});
    await using send = await lock(target);
    await send(loadSignals.mark({ at })).done();
  };
  expect(await checkPurity(run)).toBeNull();
});
it("passes a pure reducer whose caller reads the clock between two dispatches of one run of code", async () => {
  const run = async () => {
    const target = { note: { text: "", extra: null } };
    applyFlow(target, [notes.pure], () => {});
    dispatch(target, noteSignals.open());
    dispatch(target, noteSignals.write({ text: "a", at: Date.now() }));
  };
  expect(await checkPurity(run)).toBeNull();
});
// Every item takes tick; only item b's reducer reads the clock, and the holder has no reducer for it.
const itemSignals = { tick: defineSignal("tick") };
const item = defineState<{ n: number }>().name("item").signals(itemSignals).variant("on").build();
defineFlow(item.on, { tick: (p, _payload, context) => item.on({ n: context.key === "b" ? now() : p.n + 1 }) });
const holder = defineState<{ items: Items<typeof item> }>()
  .name("holder")
  .signals(itemSignals)
  .variant("idle", { initial: true })
  .build();
it("names the nested node whose reducer answered differently, not its parent", async () => {
  const run = async () => {
    const target = {
      holder: {
        items: item
          .items()
          .with("a", item.on({ n: 0 }))
          .with("b", item.on({ n: 0 })),
      },
    };
    applyFlow(target, [holder], () => {});
    await using send = await lock(target);
    await send(itemSignals.tick()).done();
  };
  expect(await checkPurity(run)).toEqual({ state: "holder.items[b]", signal: "tick" });
});
it("passes every reducer the examples' scenarios reach, with handlers off and with mocks for the world", async () => {
  for (const run of scenarios) {
    expect(await checkPurity(() => run(recordingWorld().world))).toBeNull();
  }
  // With mocks the transitions have work, so the scenarios also reach loaded, opened, created, driver.failed's FAILURE
  // reducer (a missing manifest, a timeout), driver.activating's stop and media.active's close as abort reducers. The
  // clock is varied in the FAILURE reducer on the missing manifest's end, not on the timeout's. No scenario reaches driver.failed's play, producer.active's resume, producer.failed's FAILURE, media.opening's close.
  using _driver = mockHandlers(driverState.active, {
    transition: async (next, _snapshot, _prev, _key, signal) =>
      next.url.endsWith("/ok")
        ? driverState.active.results.loaded({ manifest: { url: next.url, tracks: ["video"] } })
        : next.url.endsWith("/missing")
          ? HandlerResult.rejected("no manifest")
          : neverAnswers(0, 0, 0, 0, signal),
  });
  using _transport = mockHandlers(transport.open, {
    transition: async () => transport.open.results.opened({ socket: Box.of({ close() {} }) }),
  });
  using _producer = mockHandlers(producer.active, {
    transition: async (p, _snapshot, _prev, _key, signal) =>
      p.track.deref().id === "slow"
        ? neverAnswers(0, 0, 0, 0, signal)
        : producer.active.results.created({ producer: Box.of({ close() {}, pause() {}, resume() {} }) }),
  });
  for (const run of scenarios.slice(1)) {
    expect(await checkPurity(() => run(recordingWorld().world))).toBeNull();
  }
});
// A job's transition handler loads from a world that answers on a timer and rejects once its signal aborts, as fetch.
type JobWorld = {
  load(name: string, init?: { signal: AbortSignal }): Promise<string>;
  use(value: string): void;
  release(): void;
};
const jobWorld: JobWorld = {
  load: (name, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(name), 0);
      init?.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    }),
  use() {},
  release() {},
};
const jobSignals = { start: defineSignal("start") };
const job = defineState<{ conn: DisposableBox<Disposable> }>()
  .name("job")
  .signals(jobSignals)
  .variant("idle", { initial: true });
const jobs = job.variant("starting", { transitional: true }).variant("done", { async: true }).variant("failed").build();
defineFlow(jobs.idle, { start: (s) => StateResult.transition(jobs.done(s), jobs.starting(s), jobs.failed(s)) });
type JobHandler = TransitionHandler<typeof jobs.done>;
/** A run that starts a job whose transition handler is the one `handler` makes for the run's world. The job holds a
 * box whose dispose releases through the world, as a socket's close does. */
const startJob = (handler: (world: JobWorld) => JobHandler) => async (world: JobWorld) => {
  const target = { job: { conn: DisposableBox.of({ [Symbol.dispose]: () => world.release() }) } };
  applyFlow(target, [jobs], (sm) => sm.addTransitionHandler(jobs.done, handler(world)));
  await using send = await lock(target);
  await send(jobSignals.start()).done();
};
// Each factory's const has another name than its handler: a bundler renames a function that shadows its const.
const onAfterFirst = (world: JobWorld): JobHandler =>
  async function goesOnAfterFirst() {
    world.use(await world.load("a"));
    return HandlerResult.ok();
  };
const onAfterSecond = (world: JobWorld): JobHandler =>
  async function goesOnAfterSecond(_n, _s, _p, _k, signal) {
    world.use("start"); // no wait: it returns no Promise
    await world.load("a");
    signal.throwIfAborted();
    world.use(await world.load("b"));
    return HandlerResult.ok();
  };
const checking = (world: JobWorld): JobHandler =>
  async function checksAfterEachWait(_n, _s, _p, _k, signal) {
    const a = await world.load("a");
    signal.throwIfAborted();
    const b = await world.load("b");
    signal.throwIfAborted();
    world.use(a + b);
    return HandlerResult.ok();
  };
const passing = (world: JobWorld): JobHandler =>
  async function passesTheSignal(_n, _s, _p, _k, signal) {
    world.use((await world.load("a", { signal })) + (await world.load("b", { signal })));
    return HandlerResult.ok();
  };
const releasing = (world: JobWorld): JobHandler =>
  async function releasesOnAbort(_n, _s, _p, _k, signal) {
    signal.addEventListener("abort", () => world.release());
    await world.load("a", { signal });
    return HandlerResult.ok();
  };
it("does not count a release in the signal's abort listener or in the dispose of a box the flow holds", async () => {
  expect(await checkAbort(jobWorld, startJob(releasing))).toBeNull();
});
it("names a handler that goes on after its first or second wait; passes one that checks or passes its signal", async () => {
  const failure = (handler: string, wait: number) => ({ handler, wait, waitedOn: "load", used: "use" });
  expect(await checkAbort(jobWorld, startJob(onAfterFirst))).toEqual(failure("goesOnAfterFirst", 1));
  expect(await checkAbort(jobWorld, startJob(onAfterSecond))).toEqual(failure("goesOnAfterSecond", 2));
  expect(await checkAbort(jobWorld, startJob(checking))).toBeNull();
  expect(await checkAbort(jobWorld, startJob(passing))).toBeNull();
});
it("passes every transition handler of the examples: fetchManifest, connect and produce", async () => {
  // The counter has none; the player waits four times on fetchManifest, the session once on connect, three on produce.
  for (const run of scenarios) {
    expect(await checkAbort(recordingWorld().world, run)).toBeNull();
  }
});
