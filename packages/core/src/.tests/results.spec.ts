import { describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  type FlowChange,
  HandlerResult,
  type InstanceOf,
  type Items,
  lock,
  observe,
  type ReducerContext,
  ResultKind,
  type StateFlowLogEntry,
  StateResult,
  subscribeFlow,
} from "..";

/**
 * Named results: `.variant(name, { results: { name: parser } })` puts a factory per result on the
 * variant; an enter or update handler of that variant returns one, and after the enter phase the variant's result
 * reducer folds its data into the instance entered or updated, which is what commits. Every definition with reducers
 * is made inside its test, because defineFlow binds once per variant.
 */
describe("named results", () => {
  const load = defineSignal("load");
  const stop = defineSignal("stop");

  // Log entries are delivered after the dispatch returns; observers and subscribers on a 0 ms timer.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  type Manifest = { url: string };
  type DriverProps = { url: string; manifest: Manifest | null; seen: string[] };

  /** A hand-written parser of loaded's data: an object whose manifest has a string `url`, which it trims. */
  const parseLoaded = (data: unknown): { manifest: Manifest } => {
    const url = (data as { manifest?: { url?: unknown } } | null)?.manifest?.url;
    if (typeof url !== "string") {
      throw new TypeError("a manifest needs a url");
    }
    return { manifest: { url: url.trim() } };
  };

  /** A driver: idle (initial), active with the named results loaded and noted, and failed. */
  const defineDriver = () =>
    defineState<DriverProps>()
      .name("driver")
      .signals({ load, stop })
      .variant("idle", { initial: true })
      .variant("active", {
        results: {
          loaded: (data) => parseLoaded(data),
          noted: (data) => String(data),
        },
      })
      .variant("failed")
      .build();
  type Driver = ReturnType<typeof defineDriver>;

  /** idle -> active on load; active's result reducers put the manifest and append each note. */
  function defineDriverFlow(driver: Driver): void {
    defineFlow(driver.idle, { load: (s) => driver.active({ ...s, url: "u" }) });
    defineFlow(
      driver.active,
      { stop: (s) => driver.idle({ ...s, manifest: null }) },
      {
        loaded: (s, data) => ({ ...s, manifest: data.manifest }),
        noted: (s, note) => ({ ...s, seen: [...s.seen, note] }),
      },
    );
  }

  type DriverTarget = { driver: InstanceOf<Driver> };

  function makeDriver(driver: Driver, init: Parameters<typeof applyFlow>[2], entries: StateFlowLogEntry[] = []) {
    const target = { driver: { url: "", manifest: null, seen: [] } };
    applyFlow(target, [driver], init, { logHandlers: [(entry) => entries.push(entry)] });
    return target as unknown as DriverTarget;
  }

  describe("the results option", () => {
    it("build() puts a factory per result on the variant's results, frozen; a variant without results has an empty one", () => {
      const driver = defineDriver();

      expect(Object.keys(driver.active.results)).toEqual(["loaded", "noted"]);
      expect(Object.isFrozen(driver.active.results)).toBe(true);
      expect(Object.keys(driver.idle.results)).toEqual([]);
      expect(Object.isFrozen(driver.idle.results)).toBe(true);
    });

    it("a factory runs the parser when it is called and returns a named OK; invalid data throws", () => {
      const parse = vi.fn((data: unknown) => parseLoaded(data));
      const job = defineState<{ n: number }>()
        .name("job")
        .variant("done", { initial: true, results: { loaded: parse } })
        .build();

      const result = job.done.results.loaded({ manifest: { url: "m" } });

      expect(parse).toHaveBeenCalledTimes(1);
      expect(result).toBeInstanceOf(HandlerResult);
      expect(result.kind).toBe(ResultKind.OK);
      expect(String(result)).toBe("OK(loaded)");
      // Invalid data breaks the factory's type on purpose, hence the cast.
      expect(() => job.done.results.loaded({ manifest: { url: 1 } } as never)).toThrow("a manifest needs a url");
    });

    it("invalid data inside an enter handler is an entry failure: the dispatch is an Error and nothing commits", () => {
      const driver = defineDriver();
      defineDriverFlow(driver);
      const target = makeDriver(driver, (sm) => {
        sm.addEnterHandler(driver.active, () => driver.active.results.loaded({ manifest: { url: 1 } } as never));
      });
      const before = target.driver;

      const result = dispatch(target, load());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe("a manifest needs a url");
      expect(target.driver).toBe(before);
    });
  });

  describe("the fold", () => {
    it("a result reducer gets the entered instance as the signal reducer declared it, the data its parser returned and ctx, and its return commits", () => {
      const driver = defineDriver();
      defineFlow(driver.idle, { load: (s) => driver.active({ ...s, url: "u" }) });
      const args: unknown[][] = [];
      defineFlow(
        driver.active,
        {},
        {
          loaded: (s, data, ctx) => {
            args.push([String(s), data, ctx.parent, ctx.key]);
            return { ...s, manifest: data.manifest };
          },
          noted: (s) => s,
        },
      );
      const target = makeDriver(driver, (sm) => {
        // The parser trims the url, so the reducer's data shows it gets what the parser returned.
        sm.addEnterHandler(driver.active, (s) => driver.active.results.loaded({ manifest: { url: ` ${s.url} ` } }));
      });

      expect(dispatch(target, load()).kind).toBe(ResultKind.OK);

      expect(args).toEqual([
        ["driver.active(url=u manifest=N seen=[])", { manifest: { url: "u" } }, undefined, undefined],
      ]);
      expect(target.driver.manifest).toEqual({ url: "u" });
    });

    it("results fold in registration order, each on the last fold; HandlerResult.ok() folds nothing", () => {
      const driver = defineDriver();
      defineDriverFlow(driver);
      const target = makeDriver(driver, (sm) => {
        sm.addEnterHandler(driver.active, () => driver.active.results.noted("first"));
        sm.addEnterHandler(driver.active, () => HandlerResult.ok());
        sm.addEnterHandler(driver.active, () => driver.active.results.noted("second"));
      });

      dispatch(target, load());

      expect(target.driver.seen).toEqual(["first", "second"]);

      // With only plain results, the instance the reducer declared is the one that commits.
      const plain = defineDriver();
      let declared: unknown;
      defineFlow(plain.idle, {
        load: (s) => {
          declared = plain.active({ ...s, url: "u" });
          return declared as InstanceOf<Driver>;
        },
      });
      defineFlow(plain.active, {}, { loaded: (s) => s, noted: (s) => s });
      const plainTarget = makeDriver(plain, (sm) => {
        sm.addEnterHandler(plain.active, () => HandlerResult.ok());
      });

      dispatch(plainTarget, load());

      expect(plainTarget.driver).toBe(declared);
    });

    it("named results of several entered nodes fold in the order of the enter calls (ctx.parent and def(ctx) read the target as folded so far)", () => {
      const add = defineSignal("add");
      const cell = defineState<{ id: string; n: number }>()
        .name("cell")
        .variant("empty", { initial: true })
        .variant("full", { results: { filled: (data) => Number(data) } })
        .build();
      const grid = defineState<{ cells: Items<typeof cell> }>()
        .name("grid")
        .signals({ add })
        .variant("open", { initial: true })
        .build();
      defineFlow(grid.open, {
        add: (g) => ({
          cells: g.cells.with("a", cell.full({ id: "a", n: 0 })).with("b", cell.full({ id: "b", n: 0 })),
        }),
      });
      const counter = defineState<{ total: number }>()
        .name("counter")
        .signals({ add })
        .variant("zero", { initial: true })
        .variant("counted", { results: { summed: (data) => Number(data) } })
        .build();
      defineFlow(counter.zero, { add: (c) => counter.counted(c) });
      const reads: unknown[] = [];
      // b's reducer reads a through ctx.parent, folded first; counter's reducer reads the grid through grid(ctx).
      defineFlow(cell.full, {
        filled: (c, n, ctx: ReducerContext) => {
          const parent = ctx.parent as InstanceOf<typeof grid>;
          reads.push(`${c.id} sees a=${parent.cells.get("a")?.n}`);
          return { ...c, n };
        },
      });
      defineFlow(
        counter.counted,
        {},
        {
          summed: (c, n, ctx) => {
            const cells = [...grid(ctx).cells.values()];
            reads.push(`counter sees ${cells.map((x) => x.n).join(",")}`);
            return { ...c, total: n };
          },
        },
      );
      const target = { grid: { cells: cell.items() }, counter: { total: 0 } };
      applyFlow(target, [grid, counter], (sm) => {
        sm.addEnterHandler(cell.full, (_c, _snapshot, _prev, key) => cell.full.results.filled(key === "a" ? 1 : 2));
        sm.addEnterHandler(counter.counted, () => counter.counted.results.summed(3));
      });
      const typed = target as unknown as { grid: InstanceOf<typeof grid>; counter: InstanceOf<typeof counter> };

      expect(dispatch(target, add()).kind).toBe(ResultKind.OK);

      expect(reads).toEqual(["a sees a=0", "b sees a=1", "counter sees 1,2"]);
      expect([...typed.grid.cells.values()].map((x) => x.n)).toEqual([1, 2]);
      expect(typed.counter.total).toBe(3);
    });

    it("a result reducer of an Items element reads the element's key as ctx.key", () => {
      const add = defineSignal("add");
      const cell = defineState<{ n: number }>()
        .name("cell")
        .variant("full", { initial: true, results: { filled: (data) => Number(data) } })
        .build();
      const keys: unknown[] = [];
      defineFlow(cell.full, {
        filled: (c, n, ctx) => {
          keys.push(ctx.key);
          return { ...c, n };
        },
      });
      const grid = defineState<{ cells: Items<typeof cell> }>()
        .name("grid")
        .signals({ add })
        .variant("open", { initial: true })
        .build();
      defineFlow(grid.open, { add: (g) => ({ cells: g.cells.with("k", cell.full({ n: 0 })) }) });
      const target = { grid: { cells: cell.items() } };
      applyFlow(target, [grid], (sm) => {
        sm.addEnterHandler(cell.full, () => cell.full.results.filled(5));
      });

      dispatch(target, add());

      expect(keys).toEqual(["k"]);
    });

    it("the enter phase sees the instance as the reducer declared it; the commit, commit handlers, observers and subscribers see it folded", async () => {
      const driver = defineDriver();
      defineDriverFlow(driver);
      const seen: string[] = [];
      const target = makeDriver(driver, (sm) => {
        sm.addEnterHandler(driver.active, (s, snapshot) => {
          seen.push(`enter 1: ${s.manifest?.url} / snapshot ${(snapshot.driver as InstanceOf<Driver>).manifest?.url}`);
          return driver.active.results.loaded({ manifest: { url: "m" } });
        });
        sm.addEnterHandler(driver.active, (s) => {
          seen.push(`enter 2: ${s.manifest?.url}`);
          return HandlerResult.ok();
        });
        sm.addCommitHandler(driver.active, (s, snapshot) => {
          seen.push(`commit: ${s.manifest?.url} / snapshot ${(snapshot.driver as InstanceOf<Driver>).manifest?.url}`);
        });
      });
      using _observer = observe(target, [driver.active], (s) => {
        seen.push(`observer: ${(s as InstanceOf<Driver>).manifest?.url}`);
      });
      const changes: FlowChange[] = [];
      using _sub = subscribeFlow(target, (change) => changes.push(change));

      dispatch(target, load());
      await tick();

      expect(seen).toEqual([
        "enter 1: undefined / snapshot undefined",
        "enter 2: undefined",
        "commit: m / snapshot m",
        "observer: m",
      ]);
      expect(target.driver.manifest).toEqual({ url: "m" });
      expect(changes.map((change) => change.next)).toEqual([target.driver]);
    });

    it("the entry's stateChanges show the fold, as finalStates do; a refused step's show its attempt", async () => {
      const driver = defineDriver();
      defineDriverFlow(driver);
      const entries: StateFlowLogEntry[] = [];
      let refuse = false;
      const target = makeDriver(
        driver,
        (sm) => {
          sm.addEnterHandler(driver.active, () => driver.active.results.loaded({ manifest: { url: "m" } }));
          sm.addEnterHandler(driver.active, () => (refuse ? HandlerResult.rejected("no") : HandlerResult.ok()));
        },
        entries,
      );

      dispatch(target, load());
      dispatch(target, stop());
      refuse = true;
      dispatch(target, load());
      await tick();

      expect(entries[0].stateChanges).toEqual([
        {
          stateName: "driver",
          oldState: "driver.idle(url= manifest=N seen=[])",
          newState: "driver.active(url=u manifest.url=m seen=[])",
        },
      ]);
      expect(entries[0].finalStates).toEqual({ driver: "driver.active(url=u manifest.url=m seen=[])" });
      expect(entries[0].handlerResults.map((line) => line.result)).toEqual(["OK(loaded)", "OK"]);
      // Refused: the attempt, as the reducer declared it, before any fold.
      expect(entries[2].stateChanges).toEqual([
        {
          stateName: "driver",
          oldState: "driver.idle(url=u manifest=N seen=[])",
          newState: "driver.active(url=u manifest=N seen=[])",
        },
      ]);
    });

    it("an update handler's named result folds into the new instance in the same step: the update handler sees it unfolded, the observers and the entry see it folded", async () => {
      const driver = defineDriver();
      defineFlow(driver.idle, { load: (s) => driver.active({ ...s, url: "u" }) });
      // On active, load updates: a new instance of the same variant.
      defineFlow(
        driver.active,
        { load: (s) => ({ ...s, url: `${s.url}!` }) },
        { loaded: (s) => s, noted: (s, note) => ({ ...s, seen: [...s.seen, note] }) },
      );
      const seen: string[] = [];
      const entries: StateFlowLogEntry[] = [];
      const target = makeDriver(
        driver,
        (sm) => {
          sm.addUpdateHandler(driver.active, (s, _snapshot, prev) => {
            seen.push(`update ${prev.url} -> ${s.url}, seen [${s.seen.join(" ")}]`);
            return driver.active.results.noted(s.url);
          });
        },
        entries,
      );
      dispatch(target, load());
      using _observer = observe(target, [driver.active], (s) => {
        seen.push(`observer: seen [${(s as InstanceOf<Driver>).seen.join(" ")}]`);
      });

      expect(dispatch(target, load()).kind).toBe(ResultKind.OK);
      await tick();

      expect(seen).toEqual(["update u -> u!, seen []", "observer: seen [u!]"]);
      expect(target.driver.seen).toEqual(["u!"]);
      // The second load's entry: one step, whose update handler's result names the result it returned.
      expect(entries).toHaveLength(2);
      expect(entries[1].handlerResults.map((line) => `${line.type} ${line.result}`)).toEqual(["update OK(noted)"]);
      expect(entries[1].stateChanges).toEqual([
        {
          stateName: "driver",
          oldState: "driver.active(url=u manifest=N seen=[])",
          newState: "driver.active(url=u! manifest=N seen=u!)",
        },
      ]);
      expect(entries[1].finalStates).toEqual({ driver: "driver.active(url=u! manifest=N seen=u!)" });
    });

    it("a transition handler's named result folds before the transition's end step: the end's enter and commit handlers and the observers see it", async () => {
      // The driver's shape with an asynchronous active, entered through a transition.
      const driver = defineState<DriverProps>()
        .name("driver")
        .signals({ load, stop })
        .variant("idle", { initial: true })
        .variant("active", {
          async: true,
          results: {
            loaded: (data) => parseLoaded(data),
            noted: (data) => String(data),
          },
        })
        .variant("failed")
        .build();
      defineFlow(driver.idle, {
        load: (s, _signal, ctx) =>
          StateResult.transition(driver.active({ ...s, url: "u" }), driver(ctx), driver.failed(s)),
      });
      defineFlow(
        driver.active,
        { stop: (s) => driver.idle({ ...s, manifest: null }) },
        { loaded: (s, data) => ({ ...s, manifest: data.manifest }), noted: (s) => s },
      );
      const seen: string[] = [];
      const target = { driver: { url: "", manifest: null, seen: [] } } as unknown as {
        driver: InstanceOf<typeof driver>;
      };
      applyFlow(target, [driver], (sm) => {
        sm.addTransitionHandler(driver.active, async (next) => {
          seen.push(`work: ${next.manifest?.url}`);
          return driver.active.results.loaded({ manifest: { url: " m " } });
        });
        sm.addEnterHandler(driver.active, (s) => {
          seen.push(`enter: ${s.manifest?.url}`);
          return HandlerResult.ok();
        });
        sm.addCommitHandler(driver.active, (s) => {
          seen.push(`commit: ${s.manifest?.url}`);
        });
      });
      using _observer = observe(target, [driver.active], (s) => {
        seen.push(`observer: ${(s as InstanceOf<typeof driver>).manifest?.url}`);
      });

      expect((await dispatch(target, load()).done()).kind).toBe(ResultKind.OK);
      await tick();

      expect(seen).toEqual(["work: undefined", "enter: m", "commit: m", "observer: m"]);
      expect(target.driver.manifest).toEqual({ url: "m" });
    });

    it("a fold in a declared transition's temp step stays in the other states after the end", async () => {
      const job = defineState<{ n: number }>()
        .name("job")
        .signals({ load })
        .variant("idle", { initial: true })
        .variant("running")
        .variant("done")
        .variant("failed")
        .build();
      defineFlow(job.idle, { load: (s) => StateResult.transition(job.done(s), job.running(s), job.failed(s)) });
      const driver = defineDriver();
      defineDriverFlow(driver);
      const target = { job: { n: 0 }, driver: { url: "", manifest: null, seen: [] } };
      applyFlow(target, [job, driver], (sm) => {
        sm.addEnterHandler(driver.active, () => driver.active.results.loaded({ manifest: { url: "m" } }));
      });
      const typed = target as unknown as { job: InstanceOf<typeof job>; driver: InstanceOf<Driver> };

      await using send = await lock(target);
      await send(load()).done();

      expect(String(typed.job)).toBe("job.done(n=0)");
      expect(typed.driver.manifest).toEqual({ url: "m" });
    });
  });

  describe("entry failures", () => {
    it("another variant's named result from an enter handler is an Error, and nothing commits", () => {
      const driver = defineDriver();
      defineFlow(driver.idle, { load: (s) => driver.failed(s) });
      const target = makeDriver(driver, (sm) => {
        // A sibling variant's result does not type-check, hence the cast.
        sm.addEnterHandler(driver.failed, function enter() {
          return driver.active.results.loaded({ manifest: { url: "m" } }) as never;
        });
      });
      const before = target.driver;

      const result = dispatch(target, load());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "Handler 'enter' on driver.failed returned driver.active's named result loaded [SF054] Return a named result of the handler's own variant.",
      );
      expect(target.driver).toBe(before);
    });

    it.each([
      [
        "a reducer returning another variant",
        (driver: Driver) => (s: DriverProps) => driver.failed(s),
        "driver: the result reducer loaded of driver.active returned driver.failed(url=u manifest=N seen=[]), not an instance of driver.active [SF061] Return an instance of the reducer's own state, made by one of its variants.",
      ],
      [
        "a reducer that throws",
        () => () => {
          throw new Error("reducer broke");
        },
        "reducer broke",
      ],
      [
        "a reducer returning neither props nor an instance",
        () => () => undefined,
        "driver: the result reducer loaded of driver.active returned undefined, not an instance of driver.active [SF061] Return an instance of the reducer's own state, made by one of its variants.",
      ],
      [
        "a name without a reducer",
        // `noted` has no reducer below; ResultReducers requires one, so only JavaScript or a cast gets here.
        () => (s: DriverProps) => s,
        "driver: driver.active has no result reducer for noted [SF062] Add the result reducer to the variant's defineFlow, or return the result from the variant that has it.",
      ],
    ])("%s is an entry failure: an Error, and nothing commits", (_what, reducerOf, message) => {
      const driver = defineDriver();
      defineFlow(driver.idle, { load: (s) => driver.active({ ...s, url: "u" }) });
      // Reducers that break the type on purpose, hence the cast.
      defineFlow(driver.active, {}, { loaded: reducerOf(driver) } as never);
      const target = makeDriver(driver, (sm) => {
        sm.addEnterHandler(driver.active, () => driver.active.results.loaded({ manifest: { url: "m" } }));
        sm.addEnterHandler(driver.active, () => driver.active.results.noted("x"));
      });
      const before = target.driver;

      const result = dispatch(target, load());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(message);
      expect(target.driver).toBe(before);
    });

    it.each([
      "constructor",
      "toString",
    ])("a result named %s finds no reducer in a variant that has none of that name", (name) => {
      const go = defineSignal("go");
      const s = defineState<{ n: number }>()
        .name("s")
        .signals({ go })
        .variant("idle", { initial: true })
        .variant("active", { results: { [name]: (data: unknown) => Number(data) } })
        .build();
      defineFlow(s.idle, { go: (x) => s.active(x) });
      // No reducer for the result; ResultReducers requires one, so only JavaScript or a cast gets here.
      defineFlow(s.active, {}, {} as never);
      const target = { s: { n: 0 } };
      applyFlow(target, [s], (sm) => {
        sm.addEnterHandler(s.active, () => s.active.results[name](5));
      });
      const before = target.s;

      const result = dispatch(target, go());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        `s: s.active has no result reducer for ${name} [SF062] Add the result reducer to the variant's defineFlow, or return the result from the variant that has it.`,
      );
      expect(target.s).toBe(before);
    });

    it("a fold that changes a nested state is an entry failure", () => {
      const add = defineSignal("add");
      const badge = defineState<{ n: number }>().name("badge").variant("on", { initial: true }).build();
      const member = defineState<{ badge: InstanceOf<typeof badge>; joined: boolean }>()
        .name("member")
        .variant("waiting", { initial: true })
        .variant("active", { results: { joined: () => true } })
        .build();
      defineFlow(member.active, { joined: (m) => ({ ...m, joined: true, badge: badge.on({ n: 9 }) }) });
      const room = defineState<{ member: InstanceOf<typeof member> }>()
        .name("room")
        .signals({ add })
        .variant("open", { initial: true })
        .build();
      defineFlow(room.open, { add: (r) => ({ member: member.active(r.member) }) });
      const target = { room: { member: member.waiting({ badge: badge.on({ n: 1 }), joined: false }) } };
      applyFlow(target, [room], (sm) => {
        sm.addEnterHandler(member.active, () => member.active.results.joined(true));
      });
      const before = target.room;

      const result = dispatch(target, add());

      expect(result.kind).toBe(ResultKind.Error);
      expect(result.error?.message).toBe(
        "room.member: the result reducer joined of member.active changed a nested state; nested states change only through a step [SF063] Keep the nested states as they are; change them with a signal their own reducers take.",
      );
      expect(target.room).toBe(before);
    });

    it("with failed declared, an entry failure takes the node to its failed, and the result is the Error", () => {
      const driver = defineDriver();
      defineFlow(driver.idle, { load: (s) => StateResult.ok(driver.active({ ...s, url: "u" }), driver.failed(s)) });
      defineFlow(
        driver.active,
        {},
        {
          loaded: () => {
            throw new Error("reducer broke");
          },
          noted: (s) => s,
        },
      );
      const target = makeDriver(driver, (sm) => {
        sm.addEnterHandler(driver.active, () => driver.active.results.loaded({ manifest: { url: "m" } }));
      });

      const result = dispatch(target, load());

      expect(result.error?.message).toBe("reducer broke");
      expect(String(target.driver)).toBe("driver.failed(url= manifest=N seen=[])");
    });
  });

  it("a named result from an exit handler is an Error: the node it leaves holds no instance of that variant to fold it into", () => {
    const driver = defineDriver();
    defineDriverFlow(driver);
    // Exit handlers take plain results only, hence the cast.
    const target = makeDriver(driver, (sm) => {
      sm.addExitHandler(driver.active, function onExit() {
        return driver.active.results.noted("x") as never;
      });
    });
    dispatch(target, load());
    const before = target.driver;

    const exited = dispatch(target, stop());

    expect(exited.error?.message).toBe(
      "exit handler 'onExit' returned the named result noted; only an enter, update or transition handler may [SF051] Return the named result from an enter, update or transition handler.",
    );
    expect(target.driver).toBe(before);
  });

  it("a state without signals takes its result reducers as defineFlow's second argument", () => {
    const open = defineSignal("open");
    const transport = defineState<{ socket: string | null }>()
      .name("transport")
      .variant("closed", { initial: true })
      .variant("connected", { results: { opened: (data) => String(data) } })
      .build();
    defineFlow(transport.connected, { opened: (t, socket) => ({ ...t, socket }) });
    const media = defineState<{ transport: InstanceOf<typeof transport> }>()
      .name("media")
      .signals({ open })
      .variant("idle", { initial: true })
      .variant("active")
      .build();
    defineFlow(media.idle, { open: () => media.active({ transport: transport.connected({ socket: null }) }) });
    const target = { media: { transport: transport.closed({ socket: null }) } };
    applyFlow(target, [media], (sm) => {
      sm.addEnterHandler(transport.connected, () => transport.connected.results.opened("ws"));
    });
    const typed = target as unknown as { media: InstanceOf<typeof media> };

    expect(dispatch(target, open()).kind).toBe(ResultKind.OK);

    expect(String(typed.media)).toBe("media.active(transport=transport.connected(socket=ws))");
  });
});
