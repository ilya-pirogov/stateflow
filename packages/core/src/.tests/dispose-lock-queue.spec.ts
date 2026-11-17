import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  HandlerResult,
  lock,
  ResultKind,
  StateFlowError,
  type StateFlowLogEntry,
  StateResult,
  setConsoleLogSilenced,
} from "..";

/**
 * Once `disposeFlow` ran, every send answers Rejected "<name> is disposed", whatever its lock: one taken before the
 * dispose, one whose wait the dispose ended, for its turn or for a pending transition, and one asked for afterwards,
 * which `lock()` resolves at once to a sender that holds no lock. So no sender needs a catch, while a caller that
 * expects OK throws, as expect does for a kind it does not list. The release of a lock taken before still flushes the
 * entries its label buffered until the dispose.
 */
describe("disposeFlow and the lock queue", () => {
  const signals = { go: defineSignal("go"), load: defineSignal("load") };
  const s = defineState<{ n: number }>()
    .name("dq")
    .signals(signals)
    .variant("idle", { initial: true })
    .variant("loading")
    .variant("loaded", { async: true })
    .build();
  defineFlow(s.idle, {
    go: (state) => ({ n: state.n + 1 }),
    load: (state) => StateResult.transition(s.loaded(state), s.loading(state), s.idle(state)),
  });
  defineFlow(s.loaded, { go: (state) => ({ n: state.n + 1 }) });

  afterEach(() => {
    vi.restoreAllMocks();
    setConsoleLogSilenced(null);
  });

  it("gives every lock() still waiting, and every lock() called after it, a sender that answers each send Rejected and holds no lock", async () => {
    const app = { dq: { n: 0 } };
    applyFlow(app, [s], () => {});

    const holder = await lock(app, "holder");
    const first = lock(app, "first waiter");
    const second = lock(app, "second waiter");
    disposeFlow(app);

    const send = await first;
    const answered = send(signals.go());
    expect(answered.kind).toBe(ResultKind.Rejected);
    expect(answered.message).toBe("Object is disposed");
    expect(await answered.done()).toBe(answered);
    expect(send(signals.go(), { abort: true }).kind).toBe(ResultKind.Rejected);
    expect(() => send(signals.go()).expect(ResultKind.OK)).toThrow(StateFlowError);
    expect(() => send(signals.go()).expect(ResultKind.OK)).toThrow("Object is disposed");
    await send[Symbol.asyncDispose]();
    expect((await second)(signals.go()).message).toBe("Object is disposed");

    // A lock() called after the dispose gets the same sender at once, while the holder below still holds its lock.
    const late = await lock(app, "late");
    expect(late(signals.go()).kind).toBe(ResultKind.Rejected);
    expect(late(signals.go()).message).toBe("Object is disposed");
    await holder[Symbol.asyncDispose]();
  });

  it("a lock taken before the dispose answers each send after it Rejected and logs nothing; its release flushes the entries its label buffered before, which a labeled lock() the dispose woke leaves alone, and a lock() after the release still gets a sender that holds no lock", async () => {
    const entries: StateFlowLogEntry[] = [];
    const app = { dq: { n: 0 } };
    applyFlow(app, [s], () => {}, { logHandlers: [(entry) => entries.push(entry)] });

    const holder = await lock(app, "holder");
    const waiting = lock(app, "waiter");
    expect(holder(signals.go()).kind).toBe(ResultKind.OK);
    disposeFlow(app);

    const answered = holder(signals.go());
    expect(answered.kind).toBe(ResultKind.Rejected);
    expect(answered.message).toBe("Object is disposed");
    expect(await answered.done()).toBe(answered);

    // The waiter the dispose woke releases first: its label set no group, which would take the place of the holder's.
    const waiter = await waiting;
    waiter(signals.go());
    await waiter[Symbol.asyncDispose]();

    // The holder's release flushes one entry, the go sent before the dispose, under its label.
    await holder[Symbol.asyncDispose]();
    expect(entries.map((e) => e.groupLabel)).toEqual(["holder"]);

    const next = await lock(app);
    expect(next(signals.go()).message).toBe("Object is disposed");
    await next[Symbol.asyncDispose]();
    expect(entries).toHaveLength(1);
  });

  it("a sender queued behind a dispose that waited for a pending transition gets Rejected and throws nothing, and a call that expects OK rejects", async () => {
    class Player {
      dq = { n: 0 };
    }
    const player = new Player();

    // The work of the load ends when the spec says so.
    let endWork: (result: HandlerResult) => void = () => {};
    const work = new Promise<HandlerResult>((resolve) => {
      endWork = resolve;
    });
    applyFlow(player, [s], (sm) => {
      sm.addTransitionHandler(s.loaded, () => work);
    });

    // A method that loads holds the lock until the transition ends; the dispose waits its turn behind it.
    const loading = (async () => {
      await using send = await lock(player);
      await send(signals.load()).expect(ResultKind.OK).done();
    })();
    const disposing = (async () => {
      await using _ = await lock(player);
      disposeFlow(player);
    })();

    // A sender of the world and a method, both queued behind the dispose.
    const fact = (async () => {
      await using send = await lock(player);
      return send(signals.go()).done();
    })();
    const method = (async () => {
      await using send = await lock(player);
      await send(signals.go()).expect(ResultKind.OK).done();
    })();

    endWork(HandlerResult.ok());
    await loading;
    await disposing;

    const answered = await fact;
    expect(answered.kind).toBe(ResultKind.Rejected);
    expect(answered.message).toBe("Player is disposed");
    await expect(method).rejects.toThrow(StateFlowError);
    await expect(method).rejects.toThrow("Player is disposed");
  });

  it("a lock() that took the free lock and waits for a pending transition when disposeFlow runs resolves to a sender that answers each send Rejected; labeled, it logs nothing, and its release resolves", async () => {
    // Unsilenced, so that a console group the release opened would show.
    setConsoleLogSilenced(false);
    const group = vi.spyOn(console, "group").mockImplementation(() => {});

    // The work of the load never ends: only the dispose ends the transition.
    const entries: StateFlowLogEntry[] = [];
    const app = { dq: { n: 0 } };
    applyFlow(app, [s], (sm) => sm.addTransitionHandler(s.loaded, () => new Promise<HandlerResult>(() => {})), {
      logHandlers: [(entry) => entries.push(entry)],
    });

    // A bare dispatch starts the transition with no lock held; lock() takes the free lock and waits for its end.
    dispatch(app, signals.load());
    const waiting = lock(app, "waiting");
    await new Promise((resolve) => setTimeout(resolve, 0));
    disposeFlow(app);

    const send = await waiting;
    const answered = send(signals.go());
    expect(answered.kind).toBe(ResultKind.Rejected);
    expect(answered.message).toBe("Object is disposed");
    await send[Symbol.asyncDispose]();

    // The load's first entry, written before lock() was called; the group of "waiting" had nothing to flush, so it
    // opened no console group.
    expect(entries.map((e) => [e.transition, e.groupLabel])).toEqual([["temp", undefined]]);
    expect(group).not.toHaveBeenCalled();
  });
});
