import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  HandlerResult,
  type InstanceOf,
  type Items,
  lock,
  observe,
  ResultKind,
  type StateFlowLogEntry,
  StateResult,
} from "..";

/**
 * A named result is a fact of the flow. When a handler returns one, the node whose handler returned it folds it; then,
 * in the same step, every node of another state whose variant has a result reducer of that name answers it, on the
 * snapshot the step started from, and the answers commit with the step as a signal's answers do. Definitions are made
 * inside each test, because defineFlow binds once per variant.
 */
describe("a named result reaches every state with a reducer of its name", () => {
  const load = defineSignal("load");
  const push = defineSignal("push");

  // Log entries are delivered after the dispatch returns; observers on a 0 ms timer.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  type Manifest = { url: string; tracks: string[] };
  type Loaded = { manifest: Manifest };
  const manifest: Manifest = { url: "u", tracks: ["video", "audio"] };

  /** A driver whose load waits for a manifest: active is asynchronous and declares the result loaded. */
  function defineDriver() {
    const driver = defineState<{ manifest: Manifest | null }>()
      .name("driver")
      .signals({ load })
      .variant("idle", { initial: true })
      .variant("loading", { transitional: true })
      .variant("active", { async: true, results: { loaded: (data) => data as Loaded } })
      .variant("failed")
      .build();
    defineFlow(driver.idle, {
      load: (d) => StateResult.transition(driver.active(d), driver.loading(d), driver.failed(d)),
    });
    defineFlow(driver.active, {}, { loaded: (d, data) => ({ ...d, manifest: data.manifest }) });
    return driver;
  }

  /** A state of the track list, which takes load too, so its result reducers come second. */
  function defineTracks() {
    return defineState<{ list: string[] }>()
      .name("tracks")
      .signals({ load })
      .variant("none", { initial: true })
      .variant("listed")
      .variant("fetching", { async: true })
      .variant("pending", { transitional: true })
      .build();
  }

  describe("in a transition's end", () => {
    it("the work's result folds into its node and, in the same end step, into another state, whose reducer reads the snapshot the step started from", async () => {
      const driver = defineDriver();
      const tracks = defineTracks();
      const read: string[] = [];
      defineFlow(
        tracks.none,
        {},
        {
          loaded: (t, data: Loaded, ctx) => {
            read.push(`${String(t)} sees ${String(driver(ctx))}`);
            return tracks.listed({ list: data.manifest.tracks });
          },
        },
      );
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = { driver: { manifest: null }, tracks: { list: [] } };
      applyFlow(
        target,
        [driver, tracks],
        (sm) => {
          sm.addTransitionHandler(driver.active, async () => driver.active.results.loaded({ manifest }));
          sm.addEnterHandler(driver.active, () => {
            calls.push("enter driver.active");
            return HandlerResult.ok();
          });
          sm.addExitHandler(tracks.none, () => {
            calls.push("exit tracks.none");
            return HandlerResult.ok();
          });
          sm.addEnterHandler(tracks.listed, (t) => {
            calls.push(`enter tracks.listed with ${t.list.join(",")}`);
            return HandlerResult.ok();
          });
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const typed = target as unknown as { driver: InstanceOf<typeof driver>; tracks: InstanceOf<typeof tracks> };

      expect((await dispatch(target, load()).done()).kind).toBe(ResultKind.OK);
      await tick();

      expect(typed.driver.manifest).toBe(manifest);
      expect(String(typed.tracks)).toBe("tracks.listed(list=[video audio])");
      // The reducer ran on tracks as it stood before the end step, and its ctx read the driver there: the temp.
      expect(read).toEqual(["tracks.none(list=[]) sees driver.loading(manifest=N)"]);
      // The end step runs the handlers of both changes, in the order of a step: exits, then enters.
      expect(calls).toEqual(["exit tracks.none", "enter driver.active", "enter tracks.listed with video,audio"]);
      // The temp's entry, then the end's, which lists both changes.
      expect(entries.map((entry) => entry.transition)).toEqual(["temp", "final"]);
      expect(entries[1].stateChanges).toEqual([
        {
          stateName: "driver",
          oldState: "driver.loading(manifest=N)",
          newState: "driver.active(manifest={url=u tracks=[video audio]})",
        },
        { stateName: "tracks", oldState: "tracks.none(list=[])", newState: "tracks.listed(list=[video audio])" },
      ]);
      expect(entries[1].finalResult).toBe("OK");
    });

    it("a node of another state with no reducer of that name is left as it was, and none of its handlers runs", async () => {
      const driver = defineDriver();
      const tracks = defineTracks();
      defineFlow(tracks.none, {}, { loaded: (_t, data: Loaded) => tracks.listed({ list: data.manifest.tracks }) });
      // A third state: its variant has result reducers, though none named loaded.
      const volume = defineState<{ level: number }>()
        .name("volume")
        .variant("set", { initial: true, results: { measured: (data) => Number(data) } })
        .build();
      defineFlow(volume.set, { measured: (v, level) => ({ ...v, level }) });
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = { driver: { manifest: null }, tracks: { list: [] }, volume: { level: 3 } };
      applyFlow(
        target,
        [driver, tracks, volume],
        (sm) => {
          sm.addTransitionHandler(driver.active, async () => driver.active.results.loaded({ manifest }));
          sm.addUpdateHandler(volume.set, () => {
            calls.push("update volume.set");
            return HandlerResult.ok();
          });
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const before = target.volume;

      await dispatch(target, load()).done();
      await tick();

      expect(target.volume).toBe(before);
      expect(calls).toEqual([]);
      expect(entries[1].stateChanges.map((change) => change.stateName)).toEqual(["driver", "tracks"]);
    });

    it("a state above the transition's node takes the work's result too: its answer keeps that node, and the end's change lands in it", async () => {
      const go = defineSignal("go");
      const job = defineState<{ n: number }>()
        .name("job")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("running", { transitional: true })
        .variant("done", { async: true, results: { counted: (data) => Number(data) } })
        .variant("failed")
        .build();
      defineFlow(job.idle, { go: (j) => StateResult.transition(job.done(j), job.running(j), job.failed(j)) });
      defineFlow(job.done, {}, { counted: (j, n) => ({ ...j, n }) });
      const house = defineState<{ job: InstanceOf<typeof job>; jobs: number }>()
        .name("house")
        .signals({ go })
        .variant("quiet", { initial: true })
        .variant("busy")
        .build();
      defineFlow(house.quiet, {}, { counted: (h, n: number) => house.busy({ ...h, jobs: n }) });
      const target = { house: { job: job.idle({ n: 0 }), jobs: 0 } };
      applyFlow(target, [house], (sm) => {
        sm.addTransitionHandler(job.done, async () => job.done.results.counted(3));
      });
      const typed = target as unknown as { house: InstanceOf<typeof house> };

      expect((await dispatch(target, go()).done()).kind).toBe(ResultKind.OK);

      // The house answered on the snapshot the end started from, where its job is the transitional temp, and kept the
      // job: that is no decision of the house's, so the end's done, with the result folded, stands in its answer.
      expect(String(typed.house)).toBe("house.busy(job=job.done(n=3) jobs=3)");
    });

    it("an answer that refuses refuses the end: the driver goes to its failed, and another state is left as it was", async () => {
      const driver = defineDriver();
      const tracks = defineTracks();
      defineFlow(tracks.none, {}, { loaded: () => StateResult.rejected("no tracks wanted") });
      const target = { driver: { manifest: null }, tracks: { list: [] } };
      applyFlow(target, [driver, tracks], (sm) => {
        sm.addTransitionHandler(driver.active, async () => driver.active.results.loaded({ manifest }));
      });
      const before = target.tracks;
      const typed = target as unknown as { driver: InstanceOf<typeof driver> };

      const outcome = await dispatch(target, load()).done();

      expect(outcome.kind).toBe(ResultKind.Rejected);
      expect(outcome.message).toBe("no tracks wanted");
      expect(String(typed.driver)).toBe("driver.failed(manifest=N)");
      expect(target.tracks).toBe(before);
    });
  });

  describe("from an enter handler", () => {
    /** A door that opens on push; its open variant declares the result opened, which its enter handler returns. */
    function defineDoor() {
      const door = defineState<{ at: number }>()
        .name("door")
        .signals({ push })
        .variant("closed", { initial: true })
        .variant("open", { results: { opened: (data) => Number(data) } })
        .variant("jammed", { results: { noted: (data) => String(data) } })
        .build();
      defineFlow(door.open, {}, { opened: (d, at) => ({ ...d, at }) });
      return door;
    }

    /** A light that takes push too, so its result reducers come second. */
    function defineLight() {
      return defineState<{ since: number }>()
        .name("light")
        .signals({ push })
        .variant("off", { initial: true })
        .variant("on", { results: { lit: (data) => Number(data) } })
        .variant("dim")
        .build();
    }

    it("the other state's handlers run in a further round of the same step, after the enter phase, and one commit holds both changes", async () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => door.open(d) });
      const light = defineLight();
      defineFlow(light.off, {}, { opened: (_l, at: number) => light.on({ since: at }) });
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(
        target,
        [door, light],
        (sm) => {
          sm.addEnterHandler(door.open, (d, snapshot) => {
            calls.push(`enter door.open at ${d.at}, light ${String(snapshot.light)}`);
            return door.open.results.opened(5);
          });
          sm.addExitHandler(light.off, () => {
            calls.push("exit light.off");
            return HandlerResult.ok();
          });
          // A later round's handlers get the target with the results folded.
          sm.addEnterHandler(light.on, (l, snapshot) => {
            calls.push(`enter light.on since ${l.since}, door ${String(snapshot.door)}`);
            return HandlerResult.ok();
          });
          sm.addCommitHandler(door.open, (d) => {
            calls.push(`commit door.open at ${d.at}`);
          });
          sm.addCommitHandler(light.on, (l) => {
            calls.push(`commit light.on since ${l.since}`);
          });
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const observed: string[] = [];
      using _observer = observe(
        target as unknown as { door: InstanceOf<typeof door>; light: InstanceOf<typeof light> },
        [door.open, light.on],
        (x, path) => {
          observed.push(`${path}: ${String(x)}`);
        },
      );

      expect(dispatch(target, push()).kind).toBe(ResultKind.OK);
      await tick();

      expect(calls).toEqual([
        "enter door.open at 0, light light.off(since=0)",
        "exit light.off",
        "enter light.on since 5, door door.open(at=5)",
        "commit door.open at 5",
        "commit light.on since 5",
      ]);
      expect(String(target.door)).toBe("door.open(at=5)");
      expect(String(target.light)).toBe("light.on(since=5)");
      expect(observed).toEqual(["door: door.open(at=5)", "light: light.on(since=5)"]);
      expect(entries).toHaveLength(1);
      expect(entries[0].stateChanges).toEqual([
        { stateName: "door", oldState: "door.closed(at=0)", newState: "door.open(at=5)" },
        { stateName: "light", oldState: "light.off(since=0)", newState: "light.on(since=5)" },
      ]);
    });

    it("a result a later round's handler returns reaches the other states in turn, until nothing more takes one", async () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => door.open(d) });
      const light = defineLight();
      defineFlow(light.off, {}, { opened: (_l, at: number) => light.on({ since: at }) });
      defineFlow(light.on, {}, { lit: (l) => l });
      const fan = defineState<{ speed: number }>()
        .name("fan")
        .signals({ push })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      defineFlow(fan.off, {}, { lit: (_f, since: number) => fan.on({ speed: since * 2 }) });
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = { door: { at: 0 }, light: { since: 0 }, fan: { speed: 0 } };
      applyFlow(
        target,
        [door, light, fan],
        (sm) => {
          sm.addEnterHandler(door.open, () => {
            calls.push("enter door.open");
            return door.open.results.opened(5);
          });
          sm.addEnterHandler(light.on, (l) => {
            calls.push("enter light.on");
            return light.on.results.lit(l.since);
          });
          sm.addEnterHandler(fan.on, () => {
            calls.push("enter fan.on");
            return HandlerResult.ok();
          });
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );

      expect(dispatch(target, push()).kind).toBe(ResultKind.OK);
      await tick();

      expect(calls).toEqual(["enter door.open", "enter light.on", "enter fan.on"]);
      expect(String(target.fan)).toBe("fan.on(speed=10)");
      expect(entries).toHaveLength(1);
      expect(entries[0].stateChanges.map((change) => change.stateName)).toEqual(["door", "light", "fan"]);
    });

    it("an answer for a node a round already changed is an Error, so the rounds end", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => door.open(d) }, { lit: (d) => d });
      const light = defineLight();
      defineFlow(light.off, {}, { opened: (_l, at: number) => light.on({ since: at }) });
      defineFlow(light.on, {}, { lit: (l) => l });
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => door.open.results.opened(5));
        sm.addEnterHandler(light.on, (l) => light.on.results.lit(l.since));
      });
      const before = { door: target.door, light: target.light };

      const result = dispatch(target, push());

      // light's lit reaches door, which this step opened: door.closed, as it stood before the step, has a reducer for it.
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "door: the result reducer lit of door.closed answered for door, which this step changes already; two answers would decide one state [SF030] Let one of the two decide that node: drop the result reducer's change or the step's.",
      );
      expect({ door: target.door, light: target.light }).toEqual(before);
    });

    it.each([
      ["Rejected", () => StateResult.rejected("not now"), ResultKind.Rejected, "not now"],
      [
        "Error",
        () => {
          throw new Error("light broke");
        },
        ResultKind.Error,
        "light broke",
      ],
    ])("an answer that is %s refuses the step as a signal's would: nothing commits, and the entry shows the attempt", async (_kind, answer, kind, message) => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => door.open(d) });
      const light = defineLight();
      defineFlow(light.off, {}, { opened: answer });
      const entries: StateFlowLogEntry[] = [];
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(
        target,
        [door, light],
        (sm) => {
          sm.addEnterHandler(door.open, () => door.open.results.opened(5));
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const before = { door: target.door, light: target.light };

      const result = dispatch(target, push());
      await tick();

      expect(result.kind).toBe(kind);
      expect(result.message ?? result.error?.message).toBe(message);
      expect({ door: target.door, light: target.light }).toEqual(before);
      expect(entries[0].stateChanges).toEqual([
        { stateName: "door", oldState: "door.closed(at=0)", newState: "door.open(at=0)" },
      ]);
    });

    it("a refusing answer takes a node whose reducer declared a failed there, as a handler's refusal does", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => StateResult.ok(door.open(d), door.jammed(d)) });
      defineFlow(
        door.jammed,
        {},
        { noted: (d) => d, [FAILURE]: (d, { reason }) => ({ ...d, at: reason?.length ?? -1 }) },
      );
      const light = defineLight();
      defineFlow(light.off, {}, { opened: () => StateResult.rejected("busy") });
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => door.open.results.opened(5));
      });
      const before = target.light;

      const result = dispatch(target, push());

      expect(result.kind).toBe(ResultKind.Rejected);
      expect(String(target.door)).toBe("door.jammed(at=4)");
      expect(target.light).toBe(before);
    });

    it("a later round's handler that refuses refuses the step: nothing commits, the entry shows the attempt of that round, and a declared failed follows", async () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => StateResult.ok(door.open(d), door.jammed(d)) });
      defineFlow(door.jammed, {}, { noted: (d) => d });
      const light = defineLight();
      defineFlow(light.off, {}, { opened: (_l, at: number) => light.on({ since: at }) });
      defineFlow(light.on, {}, { lit: (l) => l });
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(
        target,
        [door, light],
        (sm) => {
          sm.addEnterHandler(door.open, () => door.open.results.opened(5));
          sm.addExitHandler(light.off, () => {
            calls.push("exit light.off");
            return HandlerResult.ok();
          });
          sm.addEnterHandler(light.on, () => HandlerResult.rejected("no power"));
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const before = target.light;

      const result = dispatch(target, push());
      await tick();

      expect(result.kind).toBe(ResultKind.Rejected);
      expect(result.message).toBe("no power");
      // The door goes to the failed its reducer declared; the light stays as it was, and what its exit did stays done.
      expect(String(target.door)).toBe("door.jammed(at=0)");
      expect(target.light).toBe(before);
      expect(calls).toEqual(["exit light.off"]);
      // One entry: the attempt of the round that was refused, with the door's result folded, then the step into failed.
      expect(entries).toHaveLength(1);
      expect(entries[0].stateChanges).toEqual([
        { stateName: "door", oldState: "door.closed(at=0)", newState: "door.open(at=5)" },
        { stateName: "light", oldState: "light.off(since=0)", newState: "light.on(since=5)" },
        { stateName: "door", oldState: "door.closed(at=0)", newState: "door.jammed(at=0)" },
      ]);
    });

    it("an Ignored answers nothing: the step commits, and the node is left as it was", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => door.open(d) });
      const light = defineLight();
      defineFlow(light.off, {}, { opened: () => StateResult.ignored("light stays off") });
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => door.open.results.opened(5));
      });
      const before = target.light;

      expect(dispatch(target, push()).kind).toBe(ResultKind.OK);

      expect(String(target.door)).toBe("door.open(at=5)");
      expect(target.light).toBe(before);
    });

    it.each([
      [
        "a transition",
        (light: ReturnType<typeof defineLight>) => () =>
          StateResult.transition(light.on({ since: 1 }), light.dim({ since: 1 }), light.off({ since: 1 })),
      ],
      [
        "a failed",
        (light: ReturnType<typeof defineLight>) => () =>
          StateResult.ok(light.on({ since: 1 }), light.dim({ since: 1 })),
      ],
    ])("%s in an answer is an Error: a result reducer answers with next only", (_what, answerOf) => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => door.open(d) });
      const light = defineLight();
      defineFlow(light.off, {}, { opened: answerOf(light) });
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => door.open.results.opened(5));
      });
      const before = target.door;

      const result = dispatch(target, push());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "light: the result reducer opened of light.off returned a transition or a failed; it answers with next only [SF056] Return the next instance or props only from a result reducer.",
      );
      expect(target.door).toBe(before);
    });

    it("a node the step changes cannot answer too: two answers would decide one state", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => door.open(d) });
      const light = defineLight();
      // push dims the light, and the door's result would turn it on: two answers for one node.
      defineFlow(light.off, { push: (l) => light.dim(l) }, { opened: (_l, at: number) => light.on({ since: at }) });
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => door.open.results.opened(5));
      });
      const before = { door: target.door, light: target.light };

      const result = dispatch(target, push());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "light: the result reducer opened of light.off answered for light, which this step changes already; two answers would decide one state [SF030] Let one of the two decide that node: drop the result reducer's change or the step's.",
      );
      expect({ door: target.door, light: target.light }).toEqual(before);
    });

    it("an answer that would enter an asynchronous variant, or leave a node in a transitional one, is an Error", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => door.open(d) });
      const tracks = defineTracks();
      const fetching = defineTracks();
      defineFlow(tracks.none, {}, { opened: (t) => tracks.pending(t) });
      defineFlow(fetching.none, {}, { opened: (t) => fetching.fetching(t) });
      const pendingTarget = { door: { at: 0 }, tracks: { list: [] } };
      applyFlow(pendingTarget, [door, tracks], (sm) => {
        sm.addEnterHandler(door.open, () => door.open.results.opened(5));
      });
      const fetchingTarget = { door: { at: 0 }, tracks: { list: [] } };
      applyFlow(fetchingTarget, [door, fetching], (sm) => {
        sm.addEnterHandler(door.open, () => door.open.results.opened(5));
      });

      expect(dispatch(pendingTarget, push()).error?.message).toBe(
        "tracks: the result reducer opened of tracks.none would leave tracks in a transitional variant, which commits only as the temp of a declared transition [SF032] Return a variant that is not transitional from the result reducer.",
      );
      expect(dispatch(fetchingTarget, push()).error?.message).toBe(
        "tracks: the result reducer opened of tracks.none: tracks enters tracks.fetching, whose entry is asynchronous; declare a transition [SF033] Enter that variant through a signal reducer that returns StateResult.transition.",
      );
    });

    it("the other nodes of the state whose handler returned a result do not take it", () => {
      const fill = defineSignal<{ key: string }>("fill");
      const cell = defineState<{ n: number }>()
        .name("cell")
        .variant("empty", { initial: true })
        .variant("full", { results: { filled: (data) => Number(data) } })
        .build();
      const counts: string[] = [];
      defineFlow(cell.full, {
        filled: (c, n, ctx) => {
          counts.push(`${String(ctx.key)} folds ${n}`);
          return { ...c, n };
        },
      });
      const grid = defineState<{ cells: Items<typeof cell> }>()
        .name("grid")
        .signals({ fill })
        .variant("open", { initial: true })
        .build();
      defineFlow(grid.open, { fill: (g, { key }) => ({ cells: g.cells.with(key, cell.full({ n: 0 })) }) });
      const target = { grid: { cells: cell.items().with("a", cell.full({ n: 1 })) } };
      applyFlow(target, [grid], (sm) => {
        sm.addEnterHandler(cell.full, () => cell.full.results.filled(7));
      });
      const typed = target as unknown as { grid: InstanceOf<typeof grid> };
      const a = typed.grid.cells.get("a");

      expect(dispatch(target, fill({ key: "b" })).kind).toBe(ResultKind.OK);

      // a is full, and full has a reducer for filled, but a is of the state whose handler returned it.
      expect(counts).toEqual(["b folds 7"]);
      expect(typed.grid.cells.get("a")).toBe(a);
      expect(typed.grid.cells.get("b")?.n).toBe(7);
    });

    it("a node of the state whose handler returned a result does not take it in another variant either, where its reducer of that name is one for another state's result", () => {
      const fill = defineSignal<{ key: string }>("fill");
      const cell = defineState<{ n: number }>()
        .name("cell")
        .variant("empty", { initial: true })
        .variant("full", { results: { filled: (data) => Number(data) } })
        .build();
      defineFlow(cell.full, { filled: (c, n) => ({ ...c, n }) });
      // empty does not declare filled, so this reducer is one by which empty takes another state's filled.
      defineFlow(cell.empty, { [FAILURE]: (c) => c, filled: (_c, n: number) => cell.full({ n }) });
      const grid = defineState<{ cells: Items<typeof cell> }>()
        .name("grid")
        .signals({ fill })
        .variant("open", { initial: true })
        .build();
      defineFlow(grid.open, { fill: (g, { key }) => ({ cells: g.cells.with(key, cell.full({ n: 0 })) }) });
      const target = { grid: { cells: cell.items().with("a", cell.empty({ n: 0 })) } };
      applyFlow(target, [grid], (sm) => {
        sm.addEnterHandler(cell.full, () => cell.full.results.filled(7));
      });
      const typed = target as unknown as { grid: InstanceOf<typeof grid> };
      const a = typed.grid.cells.get("a");

      expect(dispatch(target, fill({ key: "b" })).kind).toBe(ResultKind.OK);

      expect(typed.grid.cells.get("a")).toBe(a);
      expect(typed.grid.cells.get("b")?.n).toBe(7);
    });

    it("FAILURE stays with the nodes the step into failed enters or updates: another state's FAILURE reducer gets nothing", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => StateResult.ok(door.open(d), door.jammed(d)) });
      defineFlow(door.jammed, {}, { noted: (d) => d, [FAILURE]: (d) => ({ ...d, at: -1 }) });
      const light = defineLight();
      defineFlow(light.off, {}, { [FAILURE]: (l) => ({ ...l, since: -1 }) });
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
      });
      const before = target.light;

      expect(dispatch(target, push()).kind).toBe(ResultKind.Rejected);

      expect(String(target.door)).toBe("door.jammed(at=-1)");
      expect(target.light).toBe(before);
    });

    it("in a step into failed, which commits whatever happens, a refusing answer is left out and joins the result as an Error", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => StateResult.ok(door.open(d), door.jammed(d)) });
      defineFlow(door.jammed, {}, { noted: (d) => d });
      const light = defineLight();
      defineFlow(light.off, {}, { noted: () => StateResult.rejected("busy") });
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.noted("jam"));
      });
      const before = target.light;

      const result = dispatch(target, push());

      expect(String(target.door)).toBe("door.jammed(at=0)");
      expect(target.light).toBe(before);
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "busy [SF029] Make the failed variant's handlers succeed; report trouble there through state, not a refusal.",
      );
    });

    it("in a step into failed, a named result whose own fold fails is skipped at its node, and no other state takes it", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => StateResult.ok(door.open(d), door.jammed(d)) });
      defineFlow(
        door.jammed,
        {},
        {
          noted: () => {
            throw new Error("bad note");
          },
        },
      );
      const light = defineLight();
      defineFlow(light.off, {}, { noted: (_l, note: string) => light.on({ since: note.length }) });
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.noted("jam"));
      });
      const before = target.light;

      const result = dispatch(target, push());

      expect(String(target.door)).toBe("door.jammed(at=0)");
      expect(target.light).toBe(before);
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe("bad note");
    });

    it("in a step into failed, FAILURE folds in the first round only, also when another state's answer adds a round", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => StateResult.ok(door.open(d), door.jammed(d)) });
      defineFlow(door.jammed, {}, { noted: (d) => d, [FAILURE]: (d) => ({ ...d, at: d.at + 1 }) });
      const light = defineLight();
      defineFlow(light.off, {}, { noted: (_l, note: string) => light.on({ since: note.length }) });
      const calls: string[] = [];
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.noted("jam"));
        sm.addEnterHandler(light.on, () => {
          calls.push("enter light.on");
          return HandlerResult.ok();
        });
      });

      expect(dispatch(target, push()).kind).toBe(ResultKind.Rejected);

      // The light's answer made a further round, which ran its enter handler; the door counted one failure.
      expect(calls).toEqual(["enter light.on"]);
      expect(String(target.door)).toBe("door.jammed(at=1)");
      expect(String(target.light)).toBe("light.on(since=3)");
    });

    it("in a step into failed, the answers to a later result commit after an earlier result's answers refused", () => {
      const door = defineDoor();
      defineFlow(door.closed, { push: (d) => StateResult.ok(door.open(d), door.jammed(d)) });
      defineFlow(door.jammed, {}, { noted: (d) => d });
      const light = defineLight();
      defineFlow(
        light.off,
        {},
        {
          noted: (_l, note: string) =>
            note === "jam" ? StateResult.rejected("busy") : light.on({ since: note.length }),
        },
      );
      const target = { door: { at: 0 }, light: { since: 0 } };
      applyFlow(target, [door, light], (sm) => {
        sm.addEnterHandler(door.open, () => HandlerResult.rejected("stuck"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.noted("jam"));
        sm.addEnterHandler(door.jammed, () => door.jammed.results.noted("later"));
      });

      const result = dispatch(target, push());

      expect(String(target.door)).toBe("door.jammed(at=0)");
      expect(String(target.light)).toBe("light.on(since=5)");
      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "busy [SF029] Make the failed variant's handlers succeed; report trouble there through state, not a refusal.",
      );
    });
  });

  describe("from an update handler", () => {
    const turn = defineSignal("turn");

    /** A dial that turn updates, a new instance of its one variant, set, which declares the result turned. */
    function defineDial() {
      const dial = defineState<{ at: number }>()
        .name("dial")
        .signals({ turn })
        .variant("set", { initial: true, results: { turned: (data) => Number(data) } })
        .build();
      defineFlow(dial.set, { turn: (d) => ({ at: d.at + 1 }) }, { turned: (d, at) => ({ ...d, at }) });
      return dial;
    }

    it("another state takes it in the same step, on the snapshot the step started from; a further round runs that state's handlers, and one entry holds both changes", async () => {
      const dial = defineDial();
      const lamp = defineState<{ level: number }>()
        .name("lamp")
        .signals({ turn })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      const read: string[] = [];
      defineFlow(
        lamp.off,
        {},
        {
          turned: (l, at: number, ctx) => {
            read.push(`${String(l)} sees ${String(dial(ctx))}`);
            return lamp.on({ level: at });
          },
        },
      );
      const calls: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = { dial: { at: 0 }, lamp: { level: 0 } };
      applyFlow(
        target,
        [dial, lamp],
        (sm) => {
          sm.addUpdateHandler(dial.set, (d, _snapshot, prev) => {
            calls.push(`update dial.set ${prev.at} -> ${d.at}`);
            return dial.set.results.turned(d.at * 10);
          });
          // A later round's handlers get the target with the results folded.
          sm.addEnterHandler(lamp.on, (l, snapshot) => {
            calls.push(`enter lamp.on at ${l.level}, dial ${String(snapshot.dial)}`);
            return HandlerResult.ok();
          });
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const typed = target as unknown as { dial: InstanceOf<typeof dial>; lamp: InstanceOf<typeof lamp> };

      expect(dispatch(target, turn()).kind).toBe(ResultKind.OK);
      await tick();

      expect(String(typed.dial)).toBe("dial.set(at=10)");
      expect(String(typed.lamp)).toBe("lamp.on(level=10)");
      // The lamp's reducer ran on the snapshot the step started from, where the dial had not turned yet.
      expect(read).toEqual(["lamp.off(level=0) sees dial.set(at=0)"]);
      expect(calls).toEqual(["update dial.set 0 -> 1", "enter lamp.on at 10, dial dial.set(at=10)"]);
      expect(entries).toHaveLength(1);
      expect(entries[0].handlerResults.map((line) => `${line.type} ${line.stateName} ${line.result}`)).toEqual([
        "update dial OK(turned)",
        "enter lamp OK",
      ]);
      expect(entries[0].stateChanges).toEqual([
        { stateName: "dial", oldState: "dial.set(at=0)", newState: "dial.set(at=10)" },
        { stateName: "lamp", oldState: "lamp.off(level=0)", newState: "lamp.on(level=10)" },
      ]);
    });

    it("an update handler's and an enter handler's results of one round both fold, the update's first, whatever the order of the states", async () => {
      const dial = defineDial();
      const gauge = defineState<{ shown: string }>()
        .name("gauge")
        .signals({ turn })
        .variant("idle", { initial: true })
        .variant("live", { results: { read: (data) => String(data) } })
        .build();
      defineFlow(gauge.idle, { turn: (g) => gauge.live(g) });
      // The gauge's fold reads the dial through ctx, which reads the step's target as folded so far.
      defineFlow(gauge.live, {}, { read: (g, value, ctx) => ({ ...g, shown: `${value} at ${dial(ctx).at}` }) });
      const entries: StateFlowLogEntry[] = [];
      const target = { gauge: { shown: "" }, dial: { at: 0 } };
      // The gauge comes first in the flow's order; the phases, not that order, decide which result folds first.
      applyFlow(
        target,
        [gauge, dial],
        (sm) => {
          sm.addUpdateHandler(dial.set, (d) => dial.set.results.turned(d.at * 10));
          sm.addEnterHandler(gauge.live, () => gauge.live.results.read("needle"));
        },
        { logHandlers: [(entry) => entries.push(entry)] },
      );
      const typed = target as unknown as { gauge: InstanceOf<typeof gauge>; dial: InstanceOf<typeof dial> };

      expect(dispatch(target, turn()).kind).toBe(ResultKind.OK);
      await tick();

      expect(String(typed.dial)).toBe("dial.set(at=10)");
      // The update phase runs before the enter phase, so the dial's result had folded when the gauge's folded.
      expect(typed.gauge.shown).toBe("needle at 10");
      expect(entries[0].handlerResults.map((line) => `${line.type} ${line.stateName} ${line.result}`)).toEqual([
        "update dial OK(turned)",
        "enter gauge OK(read)",
      ]);
    });
  });

  describe("in a transition's temp step", () => {
    const start = defineSignal("start");

    /**
     * A job holding a tag. start declares a transition whose temp, running, declares noted, which running's enter
     * handler returns and the tag takes; done's transition handler is the work. The failed, and next, each keep the
     * tag or build a new one.
     */
    function defineJob(failedTag: "kept" | "new", nextTag: "kept" | "new" = "kept") {
      const tag = defineState<{ label: string }>()
        .name("tag")
        .signals({ start })
        .variant("blank", { initial: true })
        .variant("set")
        .build();
      const job = defineState<{ tag: InstanceOf<typeof tag> }>()
        .name("job")
        .signals({ start })
        .variant("idle", { initial: true })
        .variant("running", { transitional: true, results: { noted: (data) => String(data) } })
        .variant("done", { async: true })
        .variant("failed")
        .build();
      defineFlow(job.idle, {
        start: (j) =>
          StateResult.transition(
            job.done(nextTag === "kept" ? j : { tag: tag.blank({ label: "none" }) }),
            job.running(j),
            job.failed(failedTag === "kept" ? j : { tag: tag.blank({ label: "none" }) }),
          ),
      });
      defineFlow(job.running, {}, { noted: (j) => j });
      defineFlow(tag.blank, {}, { noted: (_t, label: string) => tag.set({ label }) });
      return { job, tag };
    }

    it.each([
      ["next", HandlerResult.ok(), "job.done(tag=tag.set(label=hot))"],
      ["failed", HandlerResult.rejected("no"), "job.failed(tag=tag.set(label=hot))"],
    ])("an answer below the declaring node commits with the temp when both ends keep that node, and the end at %s keeps it", async (_end, work, ended) => {
      const { job, tag } = defineJob("kept");
      const target = { job: { tag: tag.blank({ label: "" }) } };
      applyFlow(target, [job], (sm) => {
        sm.addEnterHandler(job.running, () => job.running.results.noted("hot"));
        sm.addTransitionHandler(job.done, async () => work);
      });
      const typed = target as unknown as { job: InstanceOf<typeof job> };

      const pending = dispatch(target, start());

      expect(String(typed.job)).toBe("job.running(tag=tag.set(label=hot))");
      await pending.done();
      expect(String(typed.job)).toBe(ended);
    });

    it("an answer below the declaring node that an end builds anew is an Error: the temp step is refused, and no transition starts", () => {
      const { job, tag } = defineJob("new");
      const works: string[] = [];
      const target = { job: { tag: tag.blank({ label: "" }) } };
      applyFlow(target, [job], (sm) => {
        sm.addEnterHandler(job.running, () => job.running.results.noted("hot"));
        sm.addTransitionHandler(job.done, async () => {
          works.push("work");
          return HandlerResult.ok();
        });
      });
      const typed = target as unknown as { job: InstanceOf<typeof job> };

      const result = dispatch(target, start());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "job.tag: the result reducer noted of tag.blank answered for a node the transition of job decides at its next or failed; two answers would decide one state [SF031] Fold the result into the transition's next and failed, or into a node outside them.",
      );
      // The refused temp step takes job to the failed its reducer declared, and no work runs.
      expect(String(typed.job)).toBe("job.failed(tag=tag.blank(label=none))");
      expect(works).toEqual([]);
    });

    it("an answer below the declaring node that next builds anew is an Error too, though the failed keeps that node", () => {
      const { job, tag } = defineJob("kept", "new");
      const target = { job: { tag: tag.blank({ label: "old" }) } };
      applyFlow(target, [job], (sm) => {
        sm.addEnterHandler(job.running, () => job.running.results.noted("hot"));
      });
      const typed = target as unknown as { job: InstanceOf<typeof job> };

      const result = dispatch(target, start());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "job.tag: the result reducer noted of tag.blank answered for a node the transition of job decides at its next or failed; two answers would decide one state [SF031] Fold the result into the transition's next and failed, or into a node outside them.",
      );
      expect(String(typed.job)).toBe("job.failed(tag=tag.blank(label=old))");
    });

    describe("an answer of a node outside the declaring node's subtree", () => {
      const stop = defineSignal("stop");

      /** A house holding a job, whose running declares noted, and a lamp; the house and the lamp take noted. */
      function defineHouse() {
        const job = defineState<{ n: number }>()
          .name("job")
          .signals({ start, stop })
          .variant("idle", { initial: true })
          .variant("running", { transitional: true, results: { noted: (data) => String(data) } })
          .variant("done", { async: true })
          .variant("failed")
          .build();
        defineFlow(job.idle, { start: (j) => StateResult.transition(job.done(j), job.running(j), job.failed(j)) });
        defineFlow(job.running, { stop: (j) => job.failed(j) }, { noted: (j) => j });
        const house = defineState<{ job: InstanceOf<typeof job>; note: string }>()
          .name("house")
          .signals({ start, stop })
          .variant("quiet", { initial: true })
          .variant("busy")
          .build();
        defineFlow(house.quiet, {}, { noted: (h, note: string) => house.busy({ ...h, note }) });
        const lamp = defineState<{ note: string }>()
          .name("lamp")
          .signals({ start, stop })
          .variant("off", { initial: true })
          .variant("on")
          .build();
        defineFlow(lamp.off, {}, { noted: (_l, note: string) => lamp.on({ note }) });
        return { job, house, lamp };
      }

      it.each([
        ["next", "done"],
        ["failed", "failed"],
        ["an abort", "failed"],
      ])("commits with the temp, from a state above the declaring node or another state, and stays at the end at %s", async (end, ended) => {
        const { job, house, lamp } = defineHouse();
        let settle: (result: HandlerResult) => void = () => {};
        const target = { house: { job: job.idle({ n: 0 }), note: "" }, lamp: { note: "" } };
        applyFlow(target, [house, lamp], (sm) => {
          sm.addEnterHandler(job.running, () => job.running.results.noted("hot"));
          sm.addTransitionHandler(
            job.done,
            (_next, _snapshot, _prev, _key, signal) =>
              new Promise<HandlerResult>((resolve) => {
                settle = resolve;
                signal.addEventListener("abort", () => resolve(HandlerResult.ok()));
              }),
          );
        });
        const typed = target as unknown as { house: InstanceOf<typeof house>; lamp: InstanceOf<typeof lamp> };
        await using send = await lock(target);

        const pending = send(start());

        // The house's answer keeps the job, which stands there as the temp step committed it.
        expect(String(typed.house)).toBe("house.busy(job=job.running(n=0) note=hot)");
        expect(String(typed.lamp)).toBe("lamp.on(note=hot)");
        if (end === "an abort") {
          await send(stop(), { abort: true }).done();
        } else {
          settle(end === "next" ? HandlerResult.ok() : HandlerResult.rejected("no"));
        }
        await pending.done();
        expect(String(typed.house)).toBe(`house.busy(job=job.${ended}(n=0) note=hot)`);
        expect(String(typed.lamp)).toBe("lamp.on(note=hot)");
      });
    });
  });

  describe("nested nodes", () => {
    const ring = defineSignal("ring");

    /** A house holding a lamp and a bell; ring reaches the bell, whose ringing variant declares rang. */
    function defineHouse() {
      const bell = defineState<{ loud: boolean }>()
        .name("bell")
        .signals({ ring })
        .variant("quiet", { initial: true })
        .variant("ringing", { results: { rang: (data) => Boolean(data) } })
        .build();
      defineFlow(bell.quiet, { ring: () => bell.ringing({ loud: false }) }, {});
      defineFlow(bell.ringing, {}, { rang: (b, loud) => ({ ...b, loud }) });
      const lamp = defineState<{ lit: boolean }>()
        .name("lamp")
        .signals({ ring })
        .variant("off", { initial: true })
        .variant("on")
        .build();
      const house = defineState<{ lamp: InstanceOf<typeof lamp>; bell: InstanceOf<typeof bell> }>()
        .name("house")
        .signals({ ring })
        .variant("idle", { initial: true })
        .variant("alert")
        .build();
      return { bell, lamp, house };
    }

    it("a parent's answer holds the child's, and takes the step's change below it", () => {
      const { bell, lamp, house } = defineHouse();
      defineFlow(house.idle, {}, { rang: (h) => house.alert(h) });
      defineFlow(lamp.off, {}, { rang: () => lamp.on({ lit: true }) });
      const calls: string[] = [];
      const target = { house: { lamp: lamp.off({ lit: false }), bell: bell.quiet({ loud: false }) } };
      applyFlow(target, [house], (sm) => {
        sm.addEnterHandler(bell.ringing, () => bell.ringing.results.rang(true));
        sm.addEnterHandler(house.alert, (h) => {
          calls.push(`enter house.alert holding ${String(h.lamp)} and ${String(h.bell)}`);
          return HandlerResult.ok();
        });
        sm.addEnterHandler(lamp.on, (_l, _snapshot, _prev, key) => {
          calls.push(`enter lamp.on, key ${String(key)}`);
          return HandlerResult.ok();
        });
      });
      const typed = target as unknown as { house: InstanceOf<typeof house> };

      expect(dispatch(target, ring()).kind).toBe(ResultKind.OK);

      expect(String(typed.house)).toBe("house.alert(lamp=lamp.on(lit=T) bell=bell.ringing(loud=T))");
      // Parents first: the house, then its lamp. The bell's change of the step stands in the house's answer, folded.
      expect(calls).toEqual([
        "enter house.alert holding lamp.on(lit=T) and bell.ringing(loud=T)",
        "enter lamp.on, key undefined",
      ]);
    });

    it("a parent's answer that replaces a child whose own reducer answered too is an Error", () => {
      const { bell, lamp, house } = defineHouse();
      defineFlow(house.idle, {}, { rang: (h) => house.alert({ ...h, lamp: lamp.off({ lit: false }) }) });
      defineFlow(lamp.off, {}, { rang: () => lamp.on({ lit: true }) });
      const target = { house: { lamp: lamp.off({ lit: false }), bell: bell.quiet({ loud: false }) } };
      applyFlow(target, [house], (sm) => {
        sm.addEnterHandler(bell.ringing, () => bell.ringing.results.rang(true));
      });
      const before = target.house;

      const result = dispatch(target, ring());

      expect(result.error?.message).toBe(
        "house replaced or removed house.lamp, whose own reducer also answered [SF023] Keep the nested state in the parent's answer, or let only one of the two reducers answer.",
      );
      expect(target.house).toBe(before);
    });

    it("a parent's answer that replaces a child the step changes is an Error", () => {
      const { bell, lamp, house } = defineHouse();
      defineFlow(house.idle, {}, { rang: (h) => house.alert({ ...h, bell: bell.quiet({ loud: true }) }) });
      const target = { house: { lamp: lamp.off({ lit: false }), bell: bell.quiet({ loud: false }) } };
      applyFlow(target, [house], (sm) => {
        sm.addEnterHandler(bell.ringing, () => bell.ringing.results.rang(true));
      });
      const before = target.house;

      const result = dispatch(target, ring());

      expect(result.error?.message).toBe(
        "house: the result reducer rang of house.idle answered for house.bell, which this step changes already; two answers would decide one state [SF030] Let one of the two decide that node: drop the result reducer's change or the step's.",
      );
      expect(target.house).toBe(before);
    });
  });

  describe("result names are unique in a flow", () => {
    it("applyFlow throws when two states declare results of one name", () => {
      const driver = defineDriver();
      const cache = defineState<{ hits: number }>()
        .name("cache")
        .variant("cold", { initial: true })
        .variant("warm", { results: { loaded: (data) => Number(data) } })
        .build();

      expect(() => applyFlow({ driver: { manifest: null }, cache: { hits: 0 } }, [driver, cache], () => {})).toThrow(
        "driver and cache both declare a result named loaded; every state with a result reducer of that name takes it, so one state of a flow declares it",
      );
    });

    it("applyFlow throws for a nested state's definition too, an empty Items' included", () => {
      const created = defineState<{ id: string }>()
        .name("producer")
        .variant("active", { initial: true, results: { created: (data) => String(data) } })
        .build();
      const media = defineState<{ producers: Items<typeof created> }>()
        .name("media")
        .variant("idle", { initial: true })
        .build();
      const stats = defineState<{ count: number }>()
        .name("stats")
        .variant("counted", { initial: true, results: { created: (data) => Number(data) } })
        .build();

      expect(() =>
        applyFlow({ media: { producers: created.items() }, stats: { count: 0 } }, [media, stats], () => {}),
      ).toThrow("producer and stats both declare a result named created");
    });

    /** A lamp and a meter, two definitions that both declare a result named switched. */
    function defineSwitched() {
      const lamp = defineState<{ lit: boolean }>()
        .name("lamp")
        .variant("off", { initial: true, results: { switched: (data) => Boolean(data) } })
        .build();
      const meter = defineState<{ n: number }>()
        .name("meter")
        .variant("read", { initial: true, results: { switched: (data) => Number(data) } })
        .build();
      return { lamp, meter };
    }

    it("applyFlow throws for a definition a nested state holds directly", () => {
      const { lamp, meter } = defineSwitched();
      const house = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("house")
        .variant("idle", { initial: true })
        .build();

      expect(() =>
        applyFlow({ house: { lamp: lamp.off({ lit: false }) }, meter: { n: 0 } }, [house, meter], () => {}),
      ).toThrow("lamp and meter both declare a result named switched");
    });

    it("applyFlow throws for a definition that an element of an Items holds", () => {
      const { lamp, meter } = defineSwitched();
      const socket = defineState<{ lamp: InstanceOf<typeof lamp> }>()
        .name("socket")
        .variant("live", { initial: true })
        .build();
      const house = defineState<{ sockets: Items<typeof socket> }>()
        .name("house")
        .variant("idle", { initial: true })
        .build();
      const sockets = socket.items().with("a", socket.live({ lamp: lamp.off({ lit: false }) }));

      expect(() => applyFlow({ house: { sockets }, meter: { n: 0 } }, [house, meter], () => {})).toThrow(
        "lamp and meter both declare a result named switched",
      );
    });

    it("a clash applyFlow does not see reaches no reducer under a name its own variant declares", () => {
      const mount = defineSignal("mount");
      const go = defineSignal("go");
      const gauge = defineState<{ n: number }>()
        .name("gauge")
        .variant("idle", { initial: true, results: { ready: (data) => Number(data) } })
        .build();
      defineFlow(gauge.idle, { ready: (g, n) => ({ ...g, n }) });
      // The panel holds no gauge at applyFlow, so applyFlow does not see the gauge's definition.
      const panel = defineState<{ gauge: InstanceOf<typeof gauge> | null }>()
        .name("panel")
        .signals({ mount })
        .variant("bare", { initial: true })
        .variant("fitted")
        .build();
      defineFlow(panel.bare, { mount: () => panel.fitted({ gauge: gauge.idle({ n: 0 }) }) });
      const driver = defineState<{ url: string }>()
        .name("driver")
        .signals({ go })
        .variant("off", { initial: true })
        .variant("on", { results: { ready: (data) => data as { url: string } } })
        .build();
      defineFlow(driver.off, { go: (d) => driver.on(d) });
      defineFlow(driver.on, {}, { ready: (d, { url }) => ({ ...d, url }) });
      const target = { panel: { gauge: null }, driver: { url: "" } };
      applyFlow(target, [panel, driver], (sm) => {
        sm.addEnterHandler(driver.on, () => driver.on.results.ready({ url: "u" }));
      });
      const typed = target as unknown as { panel: InstanceOf<typeof panel>; driver: InstanceOf<typeof driver> };
      expect(dispatch(target, mount()).kind).toBe(ResultKind.OK);
      const fitted = typed.panel;

      expect(dispatch(target, go()).kind).toBe(ResultKind.OK);

      // The gauge's ready reducer folds the gauge's own result only: the driver's ready leaves the panel as it was.
      expect(String(typed.driver)).toBe("driver.on(url=u)");
      expect(typed.panel).toBe(fitted);
    });

    it("one state may declare a name on several variants", () => {
      const job = defineState<{ n: number }>()
        .name("job")
        .variant("idle", { initial: true, results: { done: (data) => Number(data) } })
        .variant("running", { results: { done: (data) => Number(data) } })
        .build();

      expect(() => applyFlow({ job: { n: 0 } }, [job], () => {})).not.toThrow();
    });
  });
});
