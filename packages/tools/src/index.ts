import { DisposableBox, lock, type Result, type Signal, setHandlersDisabled } from "@state-flow/core";

export { checkAbort } from "./abort";
export { coverageGate, startCoverage } from "./coverage";
export { dryRun } from "./dry-run";
export { printStates, printValue } from "./print";
export { checkPurity } from "./purity";
export { recordSessions } from "./recorder";
export { parsePrint, replay } from "./replay";
export { flowReport, reportChanges } from "./report";
export { signalTable, signalTableMarkdown } from "./signal-table";
export { type WalkSubject, walk, walkPath } from "./walk";

/**
 * Waits one macrotask, which runs only after the microtask queue is empty, so every promise reaction queued so far,
 * and those they queue, has run. It goes through a MessageChannel, which test runners' fake timers do not replace,
 * so it works whether they were switched on before or after this module loaded. Needs a global MessageChannel
 * (Node 15+, browsers).
 */
function drain(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    // An open port keeps Node's event loop alive, so the listener closes it; a port delivers to addEventListener
    // listeners only once started.
    port1.addEventListener("message", () => {
      port1.close();
      resolve();
    });
    port1.start();
    port2.postMessage(null);
  });
}

interface Timer {
  due: number;
  callback: () => void;
}

/**
 * Pass it as `FlowConfig.timers` to every flow in a test: time moves only when the test moves it, and never back.
 * The engine's own `settled()` waits on the flow's timers, so on this clock it resolves only while the clock is
 * driven: wait with `idle()`. `idle()` cannot see an answer that arrives on real timers the test did not route
 * through the clock.
 */
export class TestClock {
  #now = 0;
  // Insertion order is creation order.
  #timers = new Set<Timer>();

  /** `ms` is a finite number; a negative one counts as 0, as the platform's setTimeout does. */
  setTimeout(callback: () => void, ms: number): unknown {
    const timer = { due: this.#now + Math.max(ms, 0), callback };
    this.#timers.add(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as Timer);
  }

  /** The time in ms the first timer is due at, undefined while no timer is set. */
  get nextDue(): number | undefined {
    return this.#first()?.due;
  }

  /** The clock's time in ms, 0 at its creation; only `advance` moves it. */
  get now(): number {
    return this.#now;
  }

  /**
   * Moves time to `ms` after the time of the call, running each timer that falls due by then, earliest first, and
   * what its callback queues. Overlapping calls do not add up: each runs the timers due by its own end, and time ends
   * at the latest end any of them reached. `ms` is a finite number, and a negative one moves nothing. A callback that
   * throws rejects the call: the timer is gone, time stays at its due time, and the timers due after it wait for the
   * next call.
   */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    await drain();
    for (let timer = this.#first(); timer !== undefined && timer.due <= end; timer = this.#first()) {
      this.#timers.delete(timer);
      this.#now = timer.due;
      timer.callback();
      await drain();
    }
    this.#now = Math.max(this.#now, end);
  }

  /** Runs what is due now and never moves time, so it fires no timeout. */
  idle(): Promise<void> {
    return this.advance(0);
  }

  /**
   * Sends `signal` to `target` under the target's lock, as a method does, waits for the send's end, releases the lock,
   * then runs what is due now (`idle()`), so the deliveries of its commits and the sends they make have run. Resolves
   * with the send's result, a refusal included: it asserts no kind. While the world has not answered, the send's end
   * and so this promise wait until the test moves the clock or the world answers; so does a lock held by another
   * caller. A target with no flow rejects, as `lock` throws for it.
   */
  async send(target: object, signal: Signal): Promise<Result> {
    let result: Result;
    // A block, so the lock is released before idle(): what the commits' deliveries send waits for it.
    {
      await using send = await lock(target);
      result = await send(signal).done();
    }
    await this.idle();
    return result;
  }

  /** The timer due first, the earliest created among equals: sort is stable. Every timer is due at or after now. */
  #first(): Timer | undefined {
    return [...this.#timers].sort((a, b) => a.due - b.due)[0];
  }
}

/**
 * A transition handler for a world that never answers. It rejects once the work's signal aborts: an accepted abort
 * waits for the work to settle or for the transition's deadline, so a work that ignored the abort would hold it
 * until the timeout.
 */
export function neverAnswers(
  _next: unknown,
  _snapshot: unknown,
  _prev: unknown,
  _key: unknown,
  signal: AbortSignal,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// The handlersOff scopes that are open: handlers come back on only when the last one ends. A set, not a count, so
// that ending a scope twice takes nothing away from another scope.
const openScopes = new Set<Disposable>();

/**
 * Switches every handler off until the scope ends; while several scopes are open, handlers stay off until the last of
 * them ends, in whatever order they end. Ending a scope twice changes nothing. Open it with `using`: a scope a failed
 * test left open keeps handlers off for the tests after it.
 */
export function handlersOff(): Disposable {
  const scope: Disposable = {
    [Symbol.dispose]: () => {
      openScopes.delete(scope);
      setHandlersDisabled(openScopes.size > 0);
    },
  };
  openScopes.add(scope);
  setHandlersDisabled(true);
  return scope;
}

/**
 * Each emission of the events `names`, as `[name, payload]`, in the order the target emitted them across all of them.
 * A flow's event is emitted on a turn of the flow's timers, so for a flow on a TestClock the records appear after
 * `idle()`; a plain emitter's appear at once. A name given twice records each of its emissions twice.
 */
export function recordEvents(
  target: { on(name: string, listener: (payload: unknown) => void): unknown },
  ...names: string[]
): Array<[name: string, payload: unknown]> {
  const records: Array<[name: string, payload: unknown]> = [];
  for (const name of names) {
    target.on(name, (payload) => records.push([name, payload]));
  }
  return records;
}

/**
 * Puts `value` itself in a DisposableBox, adding `disposals`, which counts how often the engine disposed it, and the
 * `Symbol.dispose` that counts. The value is the one the test gave, so its class, methods and getters stay; a value
 * that cannot take new fields (frozen, sealed or not extensible) throws. A value that has `disposals` or
 * `Symbol.dispose`, its own or inherited, does not compile. One stand-in per value: a value given again counts from 0.
 */
export function standIn<T extends object>(
  value: T & { disposals?: never; [Symbol.dispose]?: never },
): DisposableBox<T & Disposable & { readonly disposals: number }> {
  const given: T = value; // The parameter's extra type only refuses those two keys; the value is a T.
  const stand = Object.assign(given, {
    disposals: 0,
    [Symbol.dispose]: () => {
      stand.disposals += 1;
    },
  });
  return DisposableBox.of(stand);
}
