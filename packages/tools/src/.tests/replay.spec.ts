import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFlowTap,
  applyFlow,
  Box,
  DisposableBox,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  type FlowConfig,
  HandlerResult,
  type Items,
  lock,
  ResultKind,
  StateResult,
  type TransitionHandler,
  watch,
} from "@state-flow/core";
import { describe, expect, it } from "vitest";
import {
  driverState,
  media,
  Player,
  producer,
  recordingWorld,
  runPlayerExample,
  runSessionExample,
  Session,
  transport,
} from "../../../core/examples/examples";
import { neverAnswers, recordSessions, replay, standIn, TestClock } from "..";

// A level that rises by `by` per add and is high from `threshold` on; the enter handler of high is the world. Its
// event and its watch fire when the level reaches `fireAt`.
const add = defineSignal("add");
const reset = defineSignal("reset");
let threshold = 2;
let by = 1;
let fireAt = 2;
const level = defineState<{ n: number }>()
  .name("level")
  .signals({ add, reset })
  .variant("low", { initial: true })
  .variant("high")
  .build();
defineFlow(level.low, {
  add: (s) => (s.n + by >= threshold ? level.high({ n: s.n + by }) : { n: s.n + by }),
  reset: () => ({ n: 0 }),
});
defineFlow(level.high, { add: (s) => ({ n: s.n + by }), reset: () => level.low({ n: 0 }) });
/** A target of `level` on the flow config `flow`. */
function meter(flow: FlowConfig): { level: { n: number } } {
  const target = { level: { n: 0 }, emit() {} };
  applyFlow(
    target,
    [level],
    (sm) => {
      sm.addEnterHandler(level.high, () => HandlerResult.ok());
      sm.defineEvent("reached", (cur, prev) => cur.level.n >= fireAt && prev.level.n < fireAt);
    },
    flow,
  );
  watch(
    target,
    (cur, prev) => cur.level.n >= fireAt && prev.level.n < fireAt,
    function reached() {},
  );
  return target;
}
// A shelf of books by key, which is used once a book was put on it, and stays used when they are taken off.
const put = defineSignal<{ key: string }>("put");
const take = defineSignal<{ key: string }>("take");
const book = defineState<{ key: string }>().name("book").variant("in", { initial: true }).build();
const shelf = defineState<{ books: Items<typeof book> }>()
  .name("shelf")
  .signals({ put, take })
  .variant("empty", { initial: true })
  .variant("used")
  .build();
defineFlow(shelf.empty, { put: (s, { key }) => shelf.used({ books: s.books.with(key, book.in({ key })) }) });
defineFlow(shelf.used, {
  put: (s, { key }) => ({ books: s.books.with(key, book.in({ key })) }),
  take: (s, { key }) => ({ books: s.books.without(key) }),
});
/** A target of `shelf` on the flow config `flow`. */
function shelfOf(flow: FlowConfig): object {
  const target = { shelf: { books: book.items() } };
  applyFlow(target, [shelf], () => {}, flow);
  return target;
}
// A toggle whose first add, made by its constructor, is answered by its watch with a flip a timer turn later; each
// of its two variants has an enter handler that counts its calls.
const flip = defineSignal("flip");
const toggle = defineState<{ n: number }>()
  .name("toggle")
  .signals({ add, flip })
  .variant("off", { initial: true })
  .variant("on")
  .build();
defineFlow(toggle.off, { add: (s) => ({ n: s.n + 1 }), flip: (s) => toggle.on(s) });
defineFlow(toggle.on, { add: (s) => ({ n: s.n + 1 }), flip: (s) => toggle.off(s) });
let enterCalls = 0;
/** A target of `toggle` on the flow config `flow`, and dispatches an add while it is built. */
function switchOf(flow: FlowConfig): object {
  const target = { toggle: { n: 0 } };
  const count = () => {
    enterCalls++;
    return HandlerResult.ok();
  };
  applyFlow(
    target,
    [toggle],
    (sm) => {
      sm.addEnterHandler(toggle.on, count);
      sm.addEnterHandler(toggle.off, count);
    },
    flow,
  );
  watch(
    target,
    (cur, prev) => cur.toggle.n === 1 && prev.toggle.n === 0,
    () => {
      dispatch(target, flip());
    },
  );
  dispatch(target, add());
  return target;
}
// A job whose go is a transition with wait as its temp and idle as its failed; slow is one that times out after an hour
// into failed with n + 10. Only done takes poke, so an abort with poke is refused; back aborts to idle; re aborts to a
// new transition like go's whose failed has n + 100.
const go = defineSignal("go");
const slow = defineSignal("slow");
const poke = defineSignal("poke");
const back = defineSignal("back");
const re = defineSignal("re");
const hour = 3_600_000;
const job = defineState<{ n: number }>()
  .name("job")
  .signals({ go, slow, poke, back, re })
  .variant("idle", { initial: true })
  .variant("wait")
  .variant("done", { async: true })
  .build();
defineFlow(job.idle, {
  go: (s) => StateResult.transition(job.done(s), job.wait(s), job.idle(s)),
  slow: (s) => StateResult.transition(job.done(s), job.wait(s), job.idle({ n: s.n + 10 }), { timeoutMs: hour }),
});
defineFlow(job.wait, {
  back: (s) => job.idle(s),
  re: (s) => StateResult.transition(job.done(s), job.wait(s), job.idle({ n: s.n + 100 })),
});
defineFlow(job.done, { poke: (s) => ({ n: s.n + 1 }) });
/** A target of `job` on the flow config `flow`, whose work is `work`. */
function jobOf(flow: FlowConfig, work: TransitionHandler<typeof job.done>): object {
  const target = { job: { n: 0 } };
  applyFlow(target, [job], (sm) => sm.addTransitionHandler(job.done, work), flow);
  return target;
}
// A pair whose go is a transition of the pair and of its part, each with a work: the pair's answers at once and the
// part's never, so back aborts the go with the pair's work settled and the part's not.
const part = defineState<{ k: number }>()
  .name("part")
  .variant("rest", { initial: true })
  .variant("busy", { async: true })
  .build();
const pair = defineState<{ n: number; part: object }>()
  .name("pair")
  .signals({ go, back })
  .variant("idle", { initial: true })
  .variant("wait")
  .variant("done", { async: true })
  .build();
defineFlow(pair.idle, {
  go: (s) => StateResult.transition(pair.done({ ...s, part: part.busy({ k: 1 }) }), pair.wait(s), pair.idle(s)),
});
defineFlow(pair.wait, { back: (s) => pair.idle({ ...s, n: s.n + 1 }) });
/** A target of `pair` on the flow config `flow`. */
function pairOf(flow: FlowConfig): object {
  const target = { pair: { n: 0, part: part.rest({ k: 0 }) } };
  applyFlow(
    target,
    [pair],
    (sm) => {
      sm.addTransitionHandler(pair.done, async () => HandlerResult.ok());
      sm.addTransitionHandler(part.busy, neverAnswers);
    },
    flow,
  );
  return target;
}
// A load whose work refuses with data, which its failed end's reducer keeps.
const start = defineSignal("start");
const load = defineState<{ code: number }>()
  .name("load")
  .signals({ start })
  .variant("idle", { initial: true })
  .variant("wait")
  .variant("on", { async: true })
  .variant("off")
  .build();
defineFlow(load.idle, { start: (s) => StateResult.transition(load.on(s), load.wait(s), load.off(s)) });
defineFlow(load.off, {}, { [FAILURE]: (s, { data }) => ({ code: (data?.code as number | undefined) ?? s.code }) });
/** A target of `load` on the flow config `flow`. */
function loadOf(flow: FlowConfig): { load: { code: number } } {
  const target = { load: { code: 0 } };
  applyFlow(
    target,
    [load],
    (sm) => sm.addTransitionHandler(load.on, async () => HandlerResult.rejected("gone", { code: 410 })),
    flow,
  );
  return target;
}
/** Runs `scenario` and returns the first target the engine was told a dispatch of meanwhile. */
async function firstTarget(scenario: () => Promise<unknown>): Promise<object> {
  const targets: object[] = [];
  const leave = addFlowTap({ dispatched: (target) => targets.push(target), handled() {}, ended() {} });
  await scenario();
  leave();
  return targets[0] as object;
}
// Player and Session take no FlowConfig, so they run on the global timers and ignore the replay's clock: a replay of
// theirs waits out a recorded timeout or abort's wait in real time.
const offPlayer = () => new Player(recordingWorld().world);
/** One timer turn. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Sends `signals` to `target` in order under one lock. */
async function sendAll(target: object, ...signals: Array<ReturnType<typeof add>>): Promise<void> {
  await using send = await lock(target);
  for (const signal of signals) {
    await send(signal).done();
  }
}
// A card whose parser requires its handle in a DisposableBox and its `from` to be a variant, and whose reducer reads the
// key order of the data it is given.
const handOver = defineSignal<{ handle: DisposableBox<Disposable>; fields: Record<string, number> }>("handOver");
type CardProps = { handle: DisposableBox<Disposable> | null; from: unknown; order: string };
const card = defineState<CardProps>()
  .name("card")
  .signals({ handOver })
  .parser((props) => {
    const { handle, from, order } = props as CardProps;
    if (handle !== null && !(handle instanceof DisposableBox)) {
      throw new TypeError("a card's handle is a DisposableBox");
    }
    if (typeof from !== "function") {
      throw new TypeError("a card's from is a variant");
    }
    return { handle, from, order };
  })
  .variant("empty", { initial: true })
  .variant("held")
  .build();
defineFlow(card.empty, {
  handOver: (_s, { handle, fields }) => card.held({ handle, from: card.empty, order: Object.keys(fields).join() }),
});
/** A target of `card` on the flow config `flow`. */
function cardOf(flow: FlowConfig): object {
  const target = { card: { handle: null, from: card.empty, order: "" } };
  applyFlow(target, [card], () => {}, flow);
  return target;
}
// A tally whose owner reacts to its first bump by sending echo under the lock, as an application's watch does.
const bump = defineSignal("bump");
const echo = defineSignal("echo");
const tally = defineState<{ n: number }>()
  .name("tally")
  .signals({ bump, echo })
  .variant("on", { initial: true })
  .build();
defineFlow(tally.on, { bump: (s) => ({ n: s.n + 1 }), echo: (s) => ({ n: s.n + 10 }) });
describe("recordSessions and replay", () => {
  it("replays a DisposableBox as one, a variant held as data, and an object of data in its own key order", async () => {
    using recording = recordSessions();
    const target = cardOf({});
    {
      await using send = await lock(target);
      await send(handOver({ handle: standIn({}), fields: { $b: 1, a: 2 } })).done();
    }
    const record = recording.record(target);
    // a key of data that starts with "$" is written with one more, and read back with one less
    expect(record).toContain('"fields":{"$$b":1,"a":2}');
    const { differences, replayed } = await replay(record, [card], cardOf);
    expect(differences).toEqual([]);
    // The replay's own record says what the object reached this time, once the object is disposed.
    expect(JSON.parse(replayed).stop.card.props).toEqual({
      from: { $variant: "card.empty" },
      handle: { $disposableBox: 0 },
      order: "$b,a",
    });
  });
  it("replays an object whose own code reads a boxed value, once its build gives the stand-in what that code reads", async () => {
    // A desk whose owner writes with the pen it keeps boxed whenever a note is taken, as an application's watch reads
    // an option outside a reducer.
    type Pen = { write(text: string): void };
    const note = defineSignal("note");
    const desk = defineState<{ pen: Box<Pen>; notes: number }>()
      .name("desk")
      .signals({ note })
      .variant("open", { initial: true })
      .build();
    defineFlow(desk.open, { note: (s) => ({ ...s, notes: s.notes + 1 }) });
    const written: string[] = [];
    const pen: Pen = { write: (text) => written.push(text) };
    const deskOf = (flow: FlowConfig) => {
      const target = { desk: { pen: Box.of(pen), notes: 0 } };
      applyFlow(target, [desk], () => {}, flow);
      watch(
        target,
        (cur, prev) => cur.desk.notes !== prev.desk.notes,
        (cur) => cur.desk.pen.deref().write(`note ${cur.desk.notes}`),
      );
      return target;
    };
    using recording = recordSessions();
    const target = deskOf({});
    {
      await using send = await lock(target);
      await send(note()).done();
    }
    await turn(); // the watch's callback
    const record = recording.record(target);
    expect(written).toEqual(["note 1"]);
    written.length = 0;
    const { differences } = await replay(record, [desk], (flow) => {
      // The record's start holds the pen as a stand-in; the build gives it the pen's members before the desk is built.
      Object.assign(flow.start?.desk?.pen.deref(), pen);
      return deskOf(flow);
    });
    expect(differences).toEqual([]);
    expect(written).toEqual(["note 1"]);
  });
  it("lets a send of the object's own that waited for the replay's lock run before the object is disposed", async () => {
    const refused: unknown[] = [];
    const tallyOf = (flow: FlowConfig) => {
      const target = { tally: { n: 0 } };
      applyFlow(target, [tally], () => {}, flow);
      watch(
        target,
        (cur, prev) => cur.tally.n === 1 && prev.tally.n === 0,
        () => {
          const reaction = async () => {
            await using send = await lock(target);
            await send(echo()).expect(ResultKind.OK).done();
          };
          void reaction().catch((error: unknown) => refused.push(error));
        },
      );
      return target;
    };
    using recording = recordSessions();
    const target = tallyOf({});
    {
      await using send = await lock(target);
      await send(bump()).done();
    }
    await turn(); // the reaction's echo
    const record = recording.record(target);
    expect(JSON.parse(record).steps).toHaveLength(2);
    refused.length = 0;
    // The replay sends both steps itself; the echo the replayed object sends on its own waits for the replay's lock.
    expect(await replay(record, [tally], tallyOf)).toMatchObject({ differences: [] });
    await turn();
    expect(refused).toEqual([]);
  });
  it("lets a transition such a send declares end before the dispose, on an object changed since the recording", async () => {
    // stir waited for the world in the session and commits at once since; follow always waits, 50 ms at most.
    let stirWaits = true;
    const stir = defineSignal("stir");
    const follow = defineSignal("follow");
    const pond = defineState<{ n: number }>()
      .name("pond")
      .signals({ stir, follow })
      .variant("still", { initial: true })
      .variant("moving")
      .variant("calm", { async: true })
      .build();
    const wait = (s: { n: number }, by: number) =>
      StateResult.transition(pond.calm(s), pond.moving(s), pond.still({ n: s.n + by }), { timeoutMs: 50 });
    defineFlow(pond.still, { stir: (s) => (stirWaits ? wait(s, 10) : { n: s.n + 10 }), follow: (s) => wait(s, 1) });
    const ends: Array<string | null> = [];
    const pondOf = (flow: FlowConfig) => {
      const target = { pond: { n: 0 } };
      applyFlow(target, [pond], (sm) => sm.addTransitionHandler(pond.calm, neverAnswers), flow);
      // the object's own reaction to a stir that committed at once
      watch(
        target,
        (cur, prev) => !stirWaits && cur.pond.n === 10 && prev.pond.n === 0,
        () => {
          const reaction = async () => {
            await using send = await lock(target);
            ends.push((await send(follow()).done()).code);
          };
          void reaction();
        },
      );
      return target;
    };
    using recording = recordSessions();
    const clock = new TestClock();
    const target = pondOf({ timers: clock });
    {
      await using send = await lock(target);
      const stirred = send(stir()).done();
      await clock.advance(50);
      await stirred;
    }
    const record = recording.record(target);
    stirWaits = false;
    // The replayed stir takes no work, so the session's unsettled answer is left for the reaction's follow, which
    // pends until its timeout: the replay's last wait moves the clock to it, and only then disposes the object.
    await replay(record, [pond], pondOf);
    expect(ends).toEqual(["SF035"]);
  });
  it("replays the player example, a timeout with its late answer and an abort its work answered, from a file", async () => {
    const recording = recordSessions();
    const player = await firstTarget(() => runPlayerExample(recordingWorld().world));
    const record = recording.record(player);
    recording[Symbol.dispose]();
    expect(record).toContain('{"data":{"$undefined":true},"rejected":"no manifest"}');
    expect(record).toContain('{"abort":true,'); // stop during play
    expect(record).toContain('"outcome":{"unsettled":true}'); // the timeout's work, whose late answer came after
    const file = join(mkdtempSync(join(tmpdir(), "record-")), "player.json");
    writeFileSync(file, record);
    const { world, calls } = recordingWorld();
    expect(await replay(readFileSync(file, "utf8"), [driverState], () => new Player(world))).toMatchObject({
      differences: [],
    });
    expect(calls).toEqual([]);
  });
  it("replays the session example, nested states, boxes and an abort its work answered", async () => {
    const recording = recordSessions();
    const session = await firstTarget(() => runSessionExample(recordingWorld().world));
    const record = recording.record(session);
    recording[Symbol.dispose]();
    expect(record).toContain('{"$box":');
    expect(record).toContain('{"abort":true,');
    const { world, calls } = recordingWorld();
    expect(await replay(record, [media, transport, producer], () => new Session(world))).toMatchObject({
      differences: [],
    });
    expect(calls).toEqual([]);
  });
  it("replays an accepted abort whose work never settles: the abort waits out the timeout", async () => {
    const recording = recordSessions();
    const player = new Player({ ...recordingWorld().world, fetchManifest: () => new Promise<never>(() => {}) });
    const playing = player.play("https://example.com/x", 50).catch(() => {});
    await turn(); // play holds the lock and its transition is pending
    await player.stop();
    await playing;
    const record = recording.record(player);
    recording[Symbol.dispose]();
    const [, stop] = JSON.parse(record).steps;
    expect(stop.abort).toBe(true);
    expect(stop.calls[0].outcome).toEqual({ unsettled: true });
    expect(await replay(record, [driverState], offPlayer)).toMatchObject({ differences: [] });
  });
  it("replays a refused abort, after which the transition times out", async () => {
    const recording = recordSessions();
    const player = new Player(recordingWorld().world);
    const playing = player.play("https://example.com/slow", 50).catch(() => {});
    await turn();
    // activating takes no play: the abort is refused and the transition goes on to its timeout
    dispatch(player, defineSignal<{ url: string }>("play")({ url: "https://example.com/ok" }), { abort: true });
    await playing;
    const record = recording.record(player);
    recording[Symbol.dispose]();
    expect(JSON.parse(record).steps.map((step: { abort: boolean }) => step.abort)).toEqual([false, true]);
    expect(await replay(record, [driverState], offPlayer)).toMatchObject({ differences: [] });
  });
  it("tells two targets of one flow name apart: each replays with no difference", async () => {
    const recording = recordSessions();
    const [late, quick] = [new Player(recordingWorld().world), new Player(recordingWorld().world)];
    await Promise.all([
      late.play("https://example.com/slow", 50).catch(() => {}),
      quick.play("https://example.com/ok"),
    ]);
    const records = [recording.record(late), recording.record(quick)];
    recording[Symbol.dispose]();
    expect(records[1]).not.toContain("unsettled");
    for (const record of records) {
      expect(await replay(record, [driverState], offPlayer)).toMatchObject({ differences: [] });
    }
  });
  it("records a muted dispatch that times out on a TestClock, and the replay moves its own clock to the timeout at once", async () => {
    const clock = new TestClock();
    const recording = recordSessions();
    const target = jobOf({ timers: clock }, neverAnswers);
    dispatch(target, slow(), { mute: true });
    await clock.advance(hour);
    const record = recording.record(target);
    recording[Symbol.dispose]();
    expect(record).toContain('"stop":{"job":{"$state":"job.idle","props":{"n":10}}}');
    const began = performance.now();
    expect(await replay(record, [job], (flow) => jobOf(flow, neverAnswers))).toMatchObject({ differences: [] });
    expect(performance.now() - began).toBeLessThan(1000);
  });
  it("replays on a TestClock an accepted abort whose work never settles, waiting out the hour at once", async () => {
    const clock = new TestClock();
    const recording = recordSessions();
    const target = jobOf({ timers: clock }, () => new Promise<never>(() => {}));
    dispatch(target, slow());
    dispatch(target, back(), { abort: true });
    await clock.advance(hour);
    const record = recording.record(target);
    recording[Symbol.dispose]();
    expect(record).toContain('"outcome":{"unsettled":true}');
    expect(record).toContain('"stop":{"job":{"$state":"job.idle","props":{"n":0}}}');
    const began = performance.now();
    expect(await replay(record, [job], (flow) => jobOf(flow, neverAnswers))).toMatchObject({ differences: [] });
    expect(performance.now() - began).toBeLessThan(1000);
  });
  it("replays an abort that declares a new transition, an abort of that one, and a second abort sent during its wait", async () => {
    const clock = new TestClock();
    const recording = recordSessions();
    const target = jobOf({ timers: clock }, neverAnswers);
    dispatch(target, go());
    dispatch(target, re(), { abort: true }); // go's work answers this abort
    await clock.idle(); // re's transition is pending
    dispatch(target, back(), { abort: true }); // re's work answers this abort, after the next one
    dispatch(target, back(), { abort: true }); // refused: back's abort is in progress
    await clock.idle();
    const record = recording.record(target);
    recording[Symbol.dispose]();
    const calls = JSON.parse(record).steps.map((step: { calls: unknown[] }) => step.calls.length);
    expect(calls).toEqual([0, 1, 0, 1]);
    expect(record).toContain('"stop":{"job":{"$state":"job.idle","props":{"n":0}}}');
    expect(await replay(record, [job], (flow) => jobOf(flow, neverAnswers))).toMatchObject({ differences: [] });
  });
  it("puts the answer of a work that settles after a refused abort in the abort's step, and replays it", async () => {
    const clock = new TestClock();
    const recording = recordSessions();
    const answersLater = () =>
      new Promise<HandlerResult>((resolve) => clock.setTimeout(() => resolve(HandlerResult.ok()), 10));
    const target = jobOf({ timers: clock }, answersLater);
    dispatch(target, go());
    dispatch(target, poke(), { abort: true }); // refused: the go goes on
    await clock.advance(20);
    const record = recording.record(target);
    recording[Symbol.dispose]();
    const steps = JSON.parse(record).steps.map((step: { abort: boolean; calls: unknown[] }) => [
      step.abort,
      step.calls.length,
    ]);
    expect(steps).toEqual([
      [false, 0],
      [true, 1],
    ]);
    expect(await replay(record, [job], (flow) => jobOf(flow, neverAnswers))).toMatchObject({ differences: [] });
  });
  it("replays an accepted abort of a transition one of whose works settled before it and one did not", async () => {
    const clock = new TestClock();
    const recording = recordSessions();
    const target = pairOf({ timers: clock });
    dispatch(target, go());
    await clock.idle(); // the pair's work settled
    dispatch(target, back(), { abort: true });
    await clock.idle();
    const record = recording.record(target);
    recording[Symbol.dispose]();
    expect(JSON.parse(record).steps.map((step: { calls: Array<{ node: string }> }) => step.calls[0]?.node)).toEqual([
      "pair",
      "pair.part",
    ]);
    expect(await replay(record, [pair, part], pairOf)).toMatchObject({ differences: [] });
  });
  it("replays a transition the build itself starts, which ends at its timeout", async () => {
    // The build sends slow and the work never answers, so the replay moves its clock before it has the lock.
    const starting = (flow: FlowConfig) => {
      const target = jobOf(flow, neverAnswers);
      dispatch(target, slow());
      return target;
    };
    using recording = recordSessions();
    const clock = new TestClock();
    const target = starting({ timers: clock });
    await clock.advance(hour);
    expect(await replay(recording.record(target), [job], starting)).toMatchObject({ differences: [] });
  });
  it("keeps the data a handler gave with its refusal, which the failed end reads", async () => {
    using recording = recordSessions();
    const target = loadOf({});
    await sendAll(target, start());
    expect(target.load.code).toBe(410);
    expect(await replay(recording.record(target), [load], loadOf)).toMatchObject({ differences: [] });
  });
  it("refuses a record written while a transition is pending, a refused abort after it included, and one that starts while a transition is pending", async () => {
    const clock = new TestClock();
    const recording = recordSessions();
    const target = jobOf({ timers: clock }, neverAnswers);
    dispatch(target, slow());
    dispatch(target, poke(), { abort: true }); // refused: the slow goes on
    const atEnd = recording.record(target);
    recording[Symbol.dispose]();
    const later = recordSessions();
    dispatch(target, back(), { abort: true }); // the abort of the slow sent before this recording
    await clock.idle();
    const atStart = later.record(target);
    later[Symbol.dispose]();
    for (const record of [atEnd, atStart]) {
      await expect(replay(record, [job], (flow) => jobOf(flow, neverAnswers))).rejects.toThrow(
        "cannot replay this record: a transition was pending where the record starts or ends",
      );
    }
  });
  it("replays from the middle of a session and reports the first difference once the reducer changed", async () => {
    threshold = 2;
    const target = meter({});
    await sendAll(target, add()); // before the recording: low at 1
    const recording = recordSessions();
    await sendAll(target, add(), add()); // high at 2, its enter handler runs, then 3
    const record = recording.record(target);
    recording[Symbol.dispose]();
    expect(await replay(record, [level], meter)).toMatchObject({ differences: [] });
    threshold = 3; // the first add now stays low, and the second enters high
    const { differences: found } = await replay(record, [level], meter);
    threshold = 2;
    expect(found[0]).toMatch(/^step 0:/);
    expect(found).toHaveLength(2); // steps 0 and 1 make their enter call apart; both runs end high at 3
  });
  it("reports a changed commit when the states at the end agree", async () => {
    threshold = 10;
    const recording = recordSessions();
    const target = meter({});
    await sendAll(target, add(), reset());
    const record = recording.record(target);
    recording[Symbol.dispose]();
    by = 2; // add now commits 2, which also fires the event and the watch in step 0, and reset still ends at 0
    const { differences: found } = await replay(record, [level], meter);
    [threshold, by] = [2, 1];
    expect(found.map((difference) => difference.split(":")[0])).toEqual(["step 0", "step 1"]);
    expect(found[1]).toMatch(/"n":1.*\n.*"n":2/);
  });
  it("reports an event and a watch that no longer fire, in the step whose commit fired them", async () => {
    const recording = recordSessions();
    const target = meter({});
    await sendAll(target, add(), add());
    const record = recording.record(target);
    recording[Symbol.dispose]();
    expect(record).toContain(
      '"fired":[{"node":"level","observer":"event:reached"},{"node":"level","observer":"watch:reached"}]',
    );
    expect(await replay(record, [level], meter)).toMatchObject({ differences: [] });
    fireAt = 100;
    const { differences: found } = await replay(record, [level], meter);
    fireAt = 2;
    expect(found).toEqual([
      expect.stringMatching(/^step 1:\n {2}recorded .*watch:reached.*\n {2}replayed .*"fired":\[\]/),
    ]);
  });
  it("starts a replay in the middle of a session from states that hold an empty Items", async () => {
    const target = shelfOf({});
    await sendAll(target, put({ key: "a" }), take({ key: "a" })); // used, with no book
    const recording = recordSessions();
    await sendAll(target, put({ key: "b" }));
    const record = recording.record(target);
    recording[Symbol.dispose]();
    expect(record).toContain('"start":{"shelf":{"$state":"shelf.used","props":{"books":{"$items":[],"of":"book"}}}}');
    expect(await replay(record, [shelf, book], shelfOf)).toMatchObject({ differences: [] });
  });
  it("refuses a record that names a variant the definitions given do not hold", async () => {
    const recording = recordSessions();
    const target = shelfOf({});
    await sendAll(target, put({ key: "a" }));
    const record = recording.record(target);
    recording[Symbol.dispose]();
    await expect(replay(record, [shelf], shelfOf)).rejects.toThrow(
      "book is named, which the definitions given do not hold",
    );
  });
  it("runs no handler of the object it built once it returns", async () => {
    const recording = recordSessions();
    const target = switchOf({});
    await turn();
    const record = recording.record(target);
    recording[Symbol.dispose]();
    expect(record).toContain('"signal":"flip"');
    enterCalls = 0;
    expect(await replay(record, [toggle], switchOf)).toMatchObject({ differences: [] });
    await turn();
    await turn();
    expect(enterCalls).toBe(0);
  });
});
