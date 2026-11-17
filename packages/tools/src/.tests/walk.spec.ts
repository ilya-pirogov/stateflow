import {
  applyFlow,
  Box,
  DisposableBox,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  HandlerResult,
  type Infer,
  type Items,
  lock,
  mockHandlers,
  ResultKind,
  SIGNALS,
  StateResult,
  stateVar,
} from "@state-flow/core";
import { expect, it } from "vitest";
import { media, producer, transport } from "../../../core/examples/examples";
import { neverAnswers, standIn, type TestClock, type WalkSubject, walk, walkPath } from "..";

// A feed loads a url, takes the world's parts for it, and holds the world's connection in a DisposableBox. A mistake is
// planted in a feed of its own, as a variant takes one flow: "merge" adds parts where it should replace them, "stale"
// takes the parts of a url it does not hold, "live" reads the connection inside a reducer.
type Mistake = "none" | "merge" | "stale" | "live";
const signals = {
  load: defineSignal<{ url: string }>("load"),
  close: defineSignal("close"),
  answer: defineSignal<{ url: string; parts: string[] }>("answer"),
  connected: defineSignal<{ conn: DisposableBox<object> }>("connected"),
};
type FeedProps = {
  url: string | null;
  parts: readonly string[];
  partsUrl: string | null;
  conn: DisposableBox<object> | null;
};
function defineFeed(mistake: Mistake) {
  const feed = defineState<FeedProps>()
    .name("feed")
    .signals(signals)
    .variant("idle", { initial: true })
    .variant("opening", { transitional: true })
    .variant("open", { async: true })
    .build();
  const empty = { parts: [], partsUrl: null, conn: null };
  const load = (s: FeedProps, { url }: { url: string }) =>
    StateResult.transition(feed.open({ ...empty, url }), feed.opening({ ...s, url }), feed.idle(s));
  defineFlow(feed.idle, { load });
  defineFlow(feed.open, {
    load,
    close: () => feed.idle({ ...empty, url: null }),
    connected: (s, { conn }) => ({ ...s, conn }),
    answer: (s, { url, parts }) => {
      if (mistake === "live") {
        s.conn?.deref();
      }
      if (mistake !== "stale" && url !== s.url) {
        return StateResult.ignored("parts of another url");
      }
      return { ...s, parts: mistake === "merge" ? [...s.parts, ...parts] : parts, partsUrl: url };
    },
  });
  return feed;
}
const feeds = {
  none: defineFeed("none"),
  merge: defineFeed("merge"),
  stale: defineFeed("stale"),
  live: defineFeed("live"),
};

/** The object the walk drives: its methods assert OK, as an application's do. */
class Feed {
  readonly feed: FeedProps = { url: null, parts: [], partsUrl: null, conn: null };
  async load(url: string): Promise<void> {
    await using send = await lock(this);
    await send(signals.load({ url })).expect(ResultKind.OK).done();
  }
  async close(): Promise<void> {
    await using send = await lock(this);
    await send(signals.close()).expect(ResultKind.OK).done();
  }
  /** The url in capitals; a mistake: it throws a TypeError while no url is held. */
  title(): string {
    return (this.feed.url as string).toUpperCase();
  }
  /** A mistake: it sends after releasing its lock, which the engine refuses with a StateFlowError (SF020). */
  async closeAfterRelease(): Promise<void> {
    const send = await lock(this);
    await send[Symbol.asyncDispose]();
    send(signals.close());
  }
  /** The name of the connection's value, in capitals. */
  connName(): string | undefined {
    return (this.feed.conn?.deref() as { name: string } | undefined)?.name.toUpperCase();
  }
}
const ifUrl = <S>(f: Feed, signal: (url: string) => S) => (f.feed.url === null ? null : signal(f.feed.url));
function feedSubject(mistake: Mistake): WalkSubject<Feed> {
  return {
    build(flow) {
      const feed = new Feed();
      // An equal answer is no change, so a fact told again commits nothing unless its reducer gives something new.
      applyFlow(feed, [feeds[mistake]], () => {}, { ...flow, equalAnswers: "value" });
      return feed;
    },
    actions: {
      "load a": { call: (f) => f.load("a") },
      "load b": { call: (f) => f.load("b") },
      close: { call: (f) => f.close() },
      parts: { fact: (f) => ifUrl(f, (url) => signals.answer({ url, parts: ["p1"] })) },
      "stale parts": { fact: (f) => ifUrl(f, () => signals.answer({ url: "old", parts: ["p0"] })) },
      connected: { fact: (f) => ifUrl(f, () => signals.connected({ conn: standIn({}) })) },
    },
    invariants: { "parts are the url's": (f) => f.feed.partsUrl === null || f.feed.partsUrl === f.feed.url },
    stepTime: 0,
  };
}
const bfs = (depth: number) => ({ depth, runs: 0, runLength: 0, seed: 1 });

it("reaches a fixed point of a correct feed, or stops at its bound, and reports states and steps", async () => {
  // Without boxes of its own per start, a sibling step after "close" from a state with a connection ends in SF028. States:
  // idle, then for each of two urls with or without parts and a connection. Steps: the first, 9 states times 6
  // actions, and 4 runs of 12.
  const report = await walk(feedSubject("none"), { depth: 8, runs: 4, runLength: 12, seed: 1 });
  expect(report).toMatchObject({ failure: null, fixedPoint: true, states: 9, steps: 103, depth: 12 });
  // The first state, then six actions on it; the three facts need a url, so on an idle feed they do nothing.
  expect(await walk(feedSubject("none"), bfs(1))).toMatchObject({
    failure: null,
    fixedPoint: false,
    states: 3,
    steps: 7,
    depth: 1,
  });
});
it("finds a planted merge by a shortest path, which reproduces it alone", async () => {
  const { failure } = await walk(feedSubject("merge"), bfs(4));
  expect(failure).toEqual({ check: "a repeated or stale fact changes nothing", path: ["load a", "parts"] });
  expect(await walkPath(feedSubject("merge"), failure?.path ?? [])).toEqual(failure);
});
it("finds a stale fact through an invariant, a live read as an engine Error, and throws that are no refusal", async () => {
  expect((await walk(feedSubject("stale"), bfs(4))).failure).toEqual({
    check: "parts are the url's",
    path: ["load a", "stale parts"],
  });
  expect((await walk(feedSubject("live"), bfs(4))).failure).toEqual({
    check: "no engine Error",
    path: ["load a", "connected", "parts"],
  });
  // "close" on an idle feed is refused (Ignored, which its expect turns into the refusal SF066) and passes. A
  // TypeError fails, and so does a StateFlowError that is no refusal.
  for (const [name, call] of [
    ["title", (f: Feed) => f.title()],
    ["close after release", (f: Feed) => f.closeAfterRelease()],
  ] as const) {
    const subject = feedSubject("none");
    subject.actions = { ...subject.actions, [name]: { call } };
    expect((await walk(subject, bfs(2))).failure).toEqual({ check: "throws only a refusal", path: [name] });
  }
});
it("fails a fact marked stale that commits when told once, and passes one the reducer ignores", async () => {
  const marked = (mistake: Mistake) => {
    const subject = feedSubject(mistake);
    subject.actions = {
      ...subject.actions,
      "stale parts": { stale: true, fact: (f) => ifUrl(f, () => signals.answer({ url: "old", parts: ["p0"] })) },
    };
    return subject;
  };
  // Unmarked, the same mistake passes this check, as its second telling gives an equal answer: an invariant finds it.
  expect((await walk(marked("stale"), bfs(4))).failure).toEqual({
    check: "a repeated or stale fact changes nothing",
    path: ["load a", "stale parts"],
  });
  expect((await walk(marked("none"), bfs(4))).failure).toBeNull();
});
it("fails a fact whose second telling commits an equal instance, in a flow that counts no equal answer", async () => {
  const subject = feedSubject("none");
  // The flow's default: only the instance a reducer was given is no change, so "parts" told again commits.
  subject.build = (flow) => {
    const feed = new Feed();
    applyFlow(feed, [feeds.none], () => {}, flow);
    return feed;
  };
  expect((await walk(subject, bfs(4))).failure).toEqual({
    check: "a repeated or stale fact changes nothing",
    path: ["load a", "parts"],
  });
});
it("finds a step that does not settle: a transition whose mocked world never answers", async () => {
  using _silent = mockHandlers(feeds.none.open, { transition: neverAnswers });
  expect((await walk(feedSubject("none"), bfs(2))).failure).toEqual({ check: "settles", path: ["load a"] });
});
it("moves the clock stepTime after each action, so a world that answers within it is heard", async () => {
  const subject = feedSubject("none");
  // The timers each feed's flow runs on, kept by the builder for the action's own timer.
  const timers = new WeakMap<Feed, TestClock>();
  const build = subject.build;
  subject.build = (flow) => {
    const feed = build(flow);
    timers.set(feed, flow.timers);
    return feed;
  };
  subject.actions = {
    "load later": {
      call: async (f) => {
        await new Promise<void>((resolve) => timers.get(f)?.setTimeout(resolve, 100));
        await f.load("a");
      },
    },
  };
  expect(await walk({ ...subject, stepTime: 100 }, bfs(2))).toMatchObject({ failure: null, states: 2 });
  expect((await walk({ ...subject, stepTime: 99 }, bfs(2))).failure).toEqual({
    check: "settles",
    path: ["load later"],
  });
});
it("takes the same steps for the same seed, and reports a random run's failure by the path it took", async () => {
  const options = { depth: 0, runs: 20, runLength: 6, seed: 3 };
  const report = await walk(feedSubject("stale"), options);
  expect(await walk(feedSubject("stale"), options)).toEqual(report);
  // The seed is taken as ToUint32 takes it, and the report gives it so.
  expect(await walk(feedSubject("stale"), { ...options, seed: 3.5 + 2 ** 32 })).toEqual(report);
  expect(report.failure?.check).toBe("parts are the url's");
  expect(report.failure?.path.at(-1)).toBe("stale parts");
  expect(await walkPath(feedSubject("stale"), report.failure?.path ?? [])).toEqual(report.failure);
});
it("walks the examples' session, whose producers are an Items of nested states, to a fixed point", async () => {
  const { open, addProducer, removeProducer, close } = media[SIGNALS];
  const subject: WalkSubject<{ media: Infer<typeof media> }> = {
    build(flow) {
      const session = { media: { transport: transport.closed({ socket: null }), producers: producer.items() } };
      applyFlow(session, [media], () => {}, flow);
      return session;
    },
    actions: {
      open: { fact: () => open() },
      "add cam": { fact: () => addProducer({ key: "cam", track: Box.of({ id: "cam" }) }) },
      // told again, a removal commits a new collection: a command, sent once from a call
      "remove cam": {
        call: async (s) => {
          await using send = await lock(s);
          await send(removeProducer({ key: "cam" })).done();
        },
      },
      close: { fact: () => close() },
    },
    invariants: { "no producer while idle": (s) => stateVar(s.media) === media.active || s.media.producers.size === 0 },
    stepTime: 0,
  };
  // idle, active with no producer, active with cam
  expect(await walk(subject, bfs(6))).toMatchObject({ failure: null, fixedPoint: true, states: 3 });
});

// A list of tracks: a keyed set of nested states, each holding the world's source in a DisposableBox, which its parser
// requires.
const listSignals = {
  add: defineSignal<{ id: string; source: DisposableBox<object> }>("add"),
  remove: defineSignal<{ id: string }>("remove"),
};
const track = defineState<{ id: string; source: DisposableBox<object> }>()
  .name("track")
  .parser((props) => {
    const { id, source } = props as { id: string; source: unknown };
    if (!(source instanceof DisposableBox)) {
      throw new TypeError("a track's source is a DisposableBox");
    }
    return { id, source };
  })
  .signals({})
  .variant("on", { initial: true })
  .build();
const list = defineState<{ tracks: Items<typeof track> }>()
  .name("list")
  .signals(listSignals)
  .variant("on", { initial: true })
  .build();
// A track that is there, or one that is gone, is a fact: told again, its reducer ignores it.
defineFlow(list.on, {
  add: (s, { id, source }) =>
    s.tracks.has(id) ? StateResult.ignored("held") : { ...s, tracks: s.tracks.with(track.on({ id, source })) },
  remove: (s, { id }) => (s.tracks.has(id) ? { ...s, tracks: s.tracks.without(id) } : StateResult.ignored("not held")),
});
it("walks a keyed set of nested states that hold DisposableBoxes", async () => {
  const subject: WalkSubject<{ list: Infer<typeof list> }> = {
    build(flow) {
      const target = { list: { tracks: track.items({ key: (t) => t.id }) } };
      applyFlow(target, [list], () => {}, flow);
      return target;
    },
    actions: {
      "add a": { fact: () => listSignals.add({ id: "a", source: standIn({}) }) },
      "add b": { fact: () => listSignals.add({ id: "b", source: standIn({}) }) },
      "remove a": { fact: () => listSignals.remove({ id: "a" }) },
    },
    invariants: {},
    stepTime: 0,
  };
  // none, a, b, a then b, b then a: an Items keeps its order
  expect(await walk(subject, bfs(3))).toMatchObject({ failure: null, fixedPoint: true, states: 5 });
});
it("gives a method that reads a box's value what the fact put in it, in every object started from it", async () => {
  const subject = feedSubject("none");
  subject.actions = {
    "load a": subject.actions["load a"],
    "connected x": { fact: (f) => ifUrl(f, () => signals.connected({ conn: standIn({ name: "x" }) })) },
    "conn name": { call: (f) => f.connName() },
  };
  expect(await walk(subject, bfs(3))).toMatchObject({ failure: null, states: 3 });
});
it("never disposes a value a step started with, when the step's object drops it", async () => {
  const conn = standIn({});
  const subject = feedSubject("none");
  subject.actions = {
    "load a": subject.actions["load a"],
    connected: { fact: (f) => ifUrl(f, () => signals.connected({ conn })) },
    close: subject.actions.close,
  };
  // "close" drops the connection its step started with, and the engine disposes what a state drops.
  expect(await walk(subject, bfs(3))).toMatchObject({ failure: null, states: 3 });
  expect(conn.deref().disposals).toBe(0);
});
it("sees only its own objects' steps while another walk runs", async () => {
  const [none, live] = await Promise.all([walk(feedSubject("none"), bfs(4)), walk(feedSubject("live"), bfs(4))]);
  expect(none.failure).toBeNull();
  expect(live.failure?.check).toBe("no engine Error");
});
it("reports a throw of a fact's function or of an invariant as a failure with its path", async () => {
  const subject = feedSubject("none");
  subject.actions = { ...subject.actions, "bad fact": { fact: (f) => ifUrl(f, () => JSON.parse("{")) } };
  const check = "nothing throws outside the action";
  const fact = await walk(subject, bfs(3));
  expect(fact.failure).toEqual({ check, path: ["load a", "bad fact"] });
  expect(await walkPath(subject, fact.failure?.path ?? [])).toEqual(fact.failure);
  const invariant = feedSubject("none");
  invariant.invariants = { "url in capitals": (f) => f.title() !== "" };
  expect((await walk(invariant, bfs(2))).failure).toEqual({ check, path: [] });
});
it("walks a subject with no actions, random runs included", async () => {
  const subject = { ...feedSubject("none"), actions: {} };
  expect(await walk(subject, { depth: 3, runs: 2, runLength: 2, seed: 1 })).toMatchObject({
    failure: null,
    fixedPoint: true,
    states: 1,
    steps: 1,
  });
});
it("gives a boxed value's own keys and array-ness to a method that reads them", async () => {
  const subject = feedSubject("none");
  subject.actions = {
    "load a": subject.actions["load a"],
    "connected list": { fact: (f) => ifUrl(f, () => signals.connected({ conn: standIn(["a", "b"]) })) },
    "read list": {
      call: (f) => {
        const list = f.feed.conn?.deref();
        if (list !== undefined && !(Array.isArray(list) && JSON.stringify(list) === '["a","b"]')) {
          throw new TypeError("the list lost its elements");
        }
      },
    },
  };
  expect(await walk(subject, bfs(3))).toMatchObject({ failure: null, states: 3 });
});
it("takes a world's failure, a timeout included, as the application's path, not an engine Error", async () => {
  for (const transition of [
    neverAnswers,
    async () => {
      throw new Error("network down");
    },
    async () => HandlerResult.error(new Error("network down")),
  ]) {
    using _world = mockHandlers(feeds.none.open, { transition });
    // The feed's default timeout is 500 ms.
    expect((await walk({ ...feedSubject("none"), stepTime: 500 }, bfs(2))).failure).toBeNull();
  }
});

// A task whose failed end reads the refusal's data, which a refusal with no data lacks, and whose poke is a muted
// dispatch of a signal the reducer throws on.
const taskSignals = { run: defineSignal("run"), poke: defineSignal("poke") };
const task = defineState<{ why: string | null }>()
  .name("task")
  .signals(taskSignals)
  .variant("idle", { initial: true })
  .variant("busy", { transitional: true })
  .variant("done", { async: true })
  .variant("failed")
  .build();
defineFlow(task.idle, {
  run: (s) => StateResult.transition(task.done(s), task.busy(s), task.failed(s)),
  poke: () => {
    throw new Error("poked");
  },
});
defineFlow(
  task.failed,
  {},
  { [FAILURE]: (s, { data }) => ({ ...s, why: (data as { why: string }).why.toUpperCase() }) },
);
it("sees a reducer that throws on a mock's refusal, and a muted dispatch whose reducer throws", async () => {
  using _world = mockHandlers(task.done, { transition: async () => HandlerResult.rejected("no") });
  const subject: WalkSubject<{ task: Infer<typeof task> }> = {
    build(flow) {
      const target = { task: { why: null } };
      applyFlow(target, [task], () => {}, flow);
      return target;
    },
    actions: {
      run: {
        call: async (t) => {
          await using send = await lock(t);
          await send(taskSignals.run()).done();
        },
      },
    },
    invariants: {},
    stepTime: 0,
  };
  // The world refused and gave no Error: the step's Error is the failed end's reducer's own.
  expect((await walk(subject, bfs(1))).failure).toEqual({ check: "no engine Error", path: ["run"] });
  // A muted dispatch writes no log entry; its step's end is told all the same.
  subject.actions = { poke: { call: (t) => dispatch(t, taskSignals.poke(), { mute: true }) } };
  expect((await walk(subject, bfs(1))).failure).toEqual({ check: "no engine Error", path: ["poke"] });
});
