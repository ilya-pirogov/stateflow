/**
 * Contains classes for handling and merging multiple results.
 * Merging process follows the rules:
 *
 *  - if at least one result is `Error`, then the final result is `Error`
 *  - if at least one result is `Rejected`, then the final result is `Rejected`
 *  - if a result is `InTransition`, then the final result will be gathered
 *    when transition is finished
 *  - if all results are `Ignored`, then the final result is `Ignored`
 *  - otherwise, the final result is `Handled`
 *
 * @example ```ts
 *   // returns 'ok' result with new state
 *   return Result.state(audio.unmuted({volume: 0.7}));
 *
 *   // returns 'ok' result without data
 *   return Result.ok();
 *
 *   // ignore signal/handling
 *   return Result.ignore("explanation message why it was ignored");
 *
 *   // reject signal/handling
 *   return Result.reject("explanation message why it was rejected");
 *
 *   // result containing error
 *   try {
 *     // ...
 *   } catch(err) {
 *     return Result.error(err);
 *   }
 *
 * ```
 */

import type { StateFlowMeta } from "./flow";
import type { StateFlowLogEntry } from "./logger";
import type { Signal, StateSignal } from "./signal";
import type { StateInstance } from "./state";
import { type CompactStackTrace, parseCompactStacktrace, StateFlowError } from "./utils";

export enum ResultKind {
  /**
   * At least one handler handled the signal and no errors were thrown.
   */
  OK,

  /**
   * All handlers and groups ignored the signal or didn't exist.
   */
  Ignored,

  /**
   * At least one handler is in transition and no errors were thrown yet.
   */
  InTransition,

  /**
   * At least one handler rejected the signal.
   */
  Rejected,

  /**
   * At least one handler threw an error.
   */
  Error,
}

/**
 * Represents the result of signal handling or state transition.
 */
export class Result<TData = unknown> {
  // a list of transitioning result promises
  readonly #executors: Array<Promise<Result>> = [];

  // signals to dispatch after this result completes successfully
  #enqueued: StateSignal[] = [];

  // cached promise for current result
  #promise: Promise<Result> | null = null;

  // kinds the caller asserted via expect() on an InTransition result.
  // The assertion is deferred to the FINAL resolved result and enforced in done().
  #expectedKinds: ResultKind[] | null = null;

  // contexts for logging purposes
  #timestamps: [number, number] = [Date.now(), Date.now()];
  #signal: Signal | null = null;
  #handler: string | null = null;
  #state: string | null = null;
  #stacktrace: CompactStackTrace | null = null;
  #meta: StateFlowMeta | null = null;

  /**
   * Internal constructor of Result
   *
   * @param kind
   * @param data
   * @param msg
   * @param ts
   * @private
   * @internal
   */
  private constructor(
    readonly kind: ResultKind,
    readonly data: TData | null,
    private readonly msg: string | Error,
    ts: number = Date.now(),
  ) {
    this.#timestamps = [ts, ts];

    if (kind === ResultKind.InTransition) {
      this.#executors.push(data as Promise<Result>);
    }
    // immutable object
    Object.freeze(this);
  }

  get startedAt(): number {
    return this.#timestamps[0];
  }

  get finishedAt(): number {
    return this.#timestamps[1];
  }

  get stacktrace(): CompactStackTrace | null {
    return this.#stacktrace;
  }

  in(...args: ResultKind[]): boolean {
    return args.includes(this.kind);
  }

  /**
   * Returns a promise with result
   * Useful for `InTransition` kind results
   * For all other kinds it wraps "this" object
   */
  async done(): Promise<Result> {
    // For InTransition results with meta, use the full processing chain
    // which includes state application and enqueue processing.
    // Check BEFORE calling waitAll() — the processing chain sets
    // meta.transitioning = null on completion, so checking after await
    // would always miss it.
    if (
      this.kind === ResultKind.InTransition &&
      this.#meta?.transitioning != null &&
      typeof this.#meta.transitioning !== "boolean"
    ) {
      return this.#assertExpected(await this.#meta.transitioning);
    }
    const result = await this.waitAll();
    if (this.#meta?.transitioning != null) {
      await this.#meta.transitioning;
    }
    return this.#assertExpected(result);
  }

  /**
   * Error object for `Error` results
   * Or null for all other kinds of results
   */
  get error(): Error | null {
    if (this.msg instanceof Error) {
      return this.msg;
    }
    return null;
  }

  /**
   * Message string for `Ignored` or `Rejected` kinds
   * Or null for all other kinds of results
   */
  get message(): string | null {
    if (typeof this.msg === "string" && this.msg !== "") {
      return this.msg;
    }
    return null;
  }

  /**
   * Signals enqueued for dispatch after this result completes successfully
   */
  get enqueuedSignals(): readonly StateSignal[] {
    return this.#enqueued;
  }

  /**
   * @internal
   * @private
   */
  waitAll(): Promise<Result> {
    // cache the promise if we haven't already
    // that allows to not use the promise if we don't need to
    // (probably most of the time)
    if (this.#promise == null) {
      if (this.kind === ResultKind.InTransition) {
        // so for in transition, we need to wait for all the executors to finish
        // and then merge the results
        this.#promise = Promise.all(this.#executors)
          .then(mergeResults)
          // A transition whose asyncFn resolved to ANOTHER InTransition (a nested transition, or a
          // send() returned without .done()) must keep resolving to its concrete final — otherwise the
          // result stays InTransition forever: it logs as "InTransition" (never the resolved
          // message), .done() returns InTransition so callers see kind !== OK, and dispatchCore neither
          // commits nor rolls back. Each level has its own withTimeout, so recursion always terminates.
          .then((res) => (res.kind === ResultKind.InTransition ? res.waitAll() : res))
          .then((res) => res.withTimestamps(...this.#timestamps, Date.now()));
      } else {
        // but for everything else, we can just resolve in the next tick
        this.#promise = Promise.resolve(this);
      }
    }
    return this.#promise;
  }

  /**
   * Creates `Ignored` result with explanation message
   *
   * @param message explanation message
   */
  static ignore<T>(message: string): Result<T> {
    return new Result<T>(ResultKind.Ignored, null, message);
  }

  /**
   * Creates `Ok` result without any messages
   */
  static ok<T = null>(data: T = null as T): Result<T> {
    return new Result(ResultKind.OK, data, "");
  }

  /**
   * Creates `Ok` result with a new state
   * Used in a flow handlers
   *
   * @param data a new state
   */
  static state<T extends StateInstance>(data: T): Result<T> {
    return new Result(ResultKind.OK, data, "");
  }

  /**
   * Creates `Ok` result that enqueues a follow-up signal for dispatch
   * after the current dispatch completes successfully.
   * If the enqueued signal fails, the entire chain is rolled back.
   *
   * @param signal - Signal to dispatch after current dispatch succeeds
   */
  static enqueue<T = null>(signal: StateSignal): Result<T> {
    const result = new Result<T>(ResultKind.OK, null as T, "");
    result.#enqueued = [signal];
    return result;
  }

  /**
   * Creates a new `InTransition` result with using async callback
   * and timeout for executing it.
   *
   * @param asyncFn
   * @param timeout
   */
  static transition<T>(asyncFn: () => Promise<Result<T>>, timeout = 500): Result<Promise<Result<T>>> {
    const ts = Date.now();
    return new Result(
      ResultKind.InTransition,
      withTimeout(
        asyncFn().catch((err) => Result.error(err)),
        timeout,
      ),
      "",
      ts,
    );
  }

  /**
   * Creates a new `Rejected` result with explanation message
   *
   * @param message
   */
  static reject<T>(message: string): Result<T> {
    return new Result<T>(ResultKind.Rejected, null, message);
  }

  static error<T>(error: unknown): Result<T> {
    if (error instanceof Error) {
      return new Result<T>(ResultKind.Error, null, error);
    }
    return new Result<T>(ResultKind.Error, null, new Error(String(error)));
  }

  expect(...kinds: ResultKind[]): this {
    if (this.kind === ResultKind.InTransition) {
      // Defer the assertion to the FINAL resolved result. We do NOT park a
      // side-promise here (that previously leaked an unhandled rejection and
      // was orphaned by done(), which returns meta.transitioning without ever
      // reading it). done() applies #expectedKinds to whatever the transition
      // resolves to, so `.expect(...).done()` composes in any order.
      this.#expectedKinds = kinds;
      return this;
    }

    if (!kinds.includes(this.kind)) {
      throw new StateFlowError(
        buildErrorMessages(this.kind, this.error, this.message, this.#signal, this.#handler, this.#state),
        this.error,
      );
    }
    return this;
  }

  /**
   * Applies a previously-stored expect() assertion (from an InTransition
   * result) to the FINAL resolved result. Throws if the final kind is not
   * allowed. No-op when no expectation was registered.
   * @internal
   */
  #assertExpected(final: Result): Result {
    if (this.#expectedKinds == null) {
      return final;
    }
    if (!this.#expectedKinds.includes(final.kind)) {
      throw new StateFlowError(
        buildErrorMessages(
          final.kind,
          final.error,
          final.message,
          final.#signal ?? this.#signal,
          final.#handler ?? this.#handler,
          final.#state ?? this.#state,
        ),
        final.error,
      );
    }
    return final;
  }

  /**
   * @internal
   */
  withTimestamps(...ts: number[]): this {
    this.#timestamps = [Math.min(...ts), Math.max(...ts)];
    return this;
  }

  /**
   * @internal
   * @param signal
   */
  withSignal(signal: Signal | null): this {
    this.#signal = signal;
    return this;
  }

  /**
   * @internal
   * @param name
   */
  withHandlerName(name: string | null): this {
    this.#handler = name;
    return this;
  }

  withStacktrace(stack: CompactStackTrace | string | null): this {
    this.#stacktrace = Array.isArray(stack) ? stack : parseCompactStacktrace(stack);
    return this;
  }

  /**
   * @internal
   * @param state
   */
  withStateUpdating(state: string | null): this {
    this.#state = state;
    return this;
  }

  withMeta(meta: StateFlowMeta): this {
    this.#meta = meta;
    return this;
  }

  /**
   * @internal
   */
  withEnqueued(signals: StateSignal[]): this {
    this.#enqueued = signals;
    return this;
  }

  /**
   * @internal
   * @param other
   */
  merge<T>(other: Result<T>): Result<TData | T> {
    const combinedEnqueued = [...this.#enqueued, ...other.#enqueued];

    // when both results are the same...
    if (this.kind === other.kind) {
      switch (this.kind) {
        case ResultKind.Ignored:
          // merge the messages
          return Result.ignore<TData>(mergeStrings(this.msg, other.msg))
            .withTimestamps(...this.#timestamps, ...other.#timestamps)
            .withSignal(this.#signal)
            .withHandlerName(this.#handler)
            .withStateUpdating(this.#state)
            .withStacktrace(this.#stacktrace)
            .withEnqueued(combinedEnqueued);
        case ResultKind.OK:
          // it doesn't matter which state we return here
          // because they are the same
          return this.withTimestamps(...this.#timestamps, ...other.#timestamps).withEnqueued(combinedEnqueued);
        case ResultKind.InTransition:
          // combine the executors
          this.#executors.push(...other.#executors);
          this.#enqueued = combinedEnqueued;
          return this;
        case ResultKind.Rejected:
          // don't care about other rejected results
          // matters only the fact that this result is rejected
          return this.withTimestamps(...this.#timestamps, ...other.#timestamps).withEnqueued(combinedEnqueued);
        case ResultKind.Error: {
          // return merged error which contains both errors
          const msg = [this.data, other.data]
            .filter((m) => m !== "")
            .map((e) => String(e))
            .filter((m) => m !== "")
            .join("; ");
          return Result.error<TData>(new StateFlowError(msg))
            .withTimestamps(...this.#timestamps, ...other.#timestamps)
            .withSignal(this.#signal)
            .withHandlerName(this.#handler)
            .withStateUpdating(this.#state)
            .withStacktrace(this.#stacktrace)
            .withEnqueued(combinedEnqueued);
        }
        default:
          throw new Error(`unknown state result: ${this.kind}`);
      }
    }

    const choose = <A, B>(a: Result<A>, b: Result<B>): Result<A | B> | null => {
      // we need to decide which result is more important here
      switch (a.kind) {
        case ResultKind.Ignored:
          // no need to merge here, because Ignored is the least important result
          return b;
        case ResultKind.InTransition:
          // just add the other result to the executors
          // so that it will be merged later
          a.#executors.push(b.waitAll());
          return a;
        case ResultKind.Rejected:
        case ResultKind.Error:
          // if this result is an error or rejected, then it is the most important
          // we don't care about the other results
          return a;
        default:
          return null;
      }
    };

    return (choose(this, other) ?? choose(other, this) ?? this)
      .withTimestamps(...this.#timestamps, ...other.#timestamps)
      .withSignal(this.#signal)
      .withHandlerName(this.#handler)
      .withStateUpdating(this.#state)
      .withStacktrace(this.#stacktrace)
      .withEnqueued(combinedEnqueued);
  }

  [Symbol.toStringTag](): string {
    if (this.#enqueued.length > 0) {
      return `Result.Enqueue(${this.#enqueued.map(String).join(", ")})`;
    }
    return `Result.${ResultKind[this.kind]}()`;
  }

  [Symbol.toPrimitive](): string {
    if (this.#enqueued.length > 0) {
      return `Enqueue(${this.#enqueued.map(String).join(", ")})`;
    }

    if (this.kind === ResultKind.Error) {
      return this.error != null ? String(this.error) : ResultKind[this.kind];
    }

    return `${ResultKind[this.kind]}${this.message != null ? `: ${this.message}` : ""}`;
  }
}

function mergeStrings(a?: unknown, b?: unknown): string {
  if (a == null && b == null) {
    return "";
  }

  if (a == null || a === "") {
    return String(b);
  }
  if (b == null || b === "") {
    return String(a);
  }
  return `${a}; ${b}`;
}

function withTimeout<T>(promise: Promise<Result<T>>, timeout: number): Promise<Result<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(Result.error(new Error("timeout")) as Result<T>);
    }, timeout);

    promise.then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function buildErrorMessages(
  got: ResultKind,
  error: Error | null,
  message: string | null,
  signal: Signal | null = null,
  handler: string | null = null,
  stateUpd: string | null = null,
): string {
  let msg: string;

  if (signal != null) {
    msg = `[SF] Signal '${String(signal)}' `;
  } else {
    msg = "[SF] Result ";
  }

  if (handler != null) {
    msg += `in handler '${handler}()' `;
  }

  switch (got) {
    case ResultKind.Rejected:
      msg += "was rejected";
      break;
    case ResultKind.Error:
      msg += "thrown an error";
      break;
    case ResultKind.InTransition:
      msg += "was in transition";
      break;
    case ResultKind.OK:
      msg += "was ok";
      break;
    default:
      msg += "was ignored";
  }

  if (stateUpd != null) {
    msg += ` while tried to ${stateUpd}`;
  }

  if (error != null) {
    msg += `: ${error}`;
  }

  if (message != null) {
    msg += `: Message: ${message}`;
  }
  return msg;
}

// Global dispatch-start counter shared by ALL flows on the page: entries carry a
// total order at dispatch START, which delivery-ordered logs (async entries are
// appended on finish) and same-millisecond startTime ties cannot provide.
let dispatchCounter = 0;

export class ResultCollector {
  private results: Result[] = [];
  private readonly entry: StateFlowLogEntry;

  constructor(flowName: string, signal: unknown, duringTransition = false) {
    this.entry = {
      message: "",
      flowName,
      signal: String(signal),
      isAsync: false,
      startTime: Date.now(),
      dispatchOrder: ++dispatchCounter,
      finalStates: {},
      stateChanges: [],
      handlerResults: [],
      observers: [],
      enqueuedSignals: [],
      stacktrace: null,
      finalResult: "",
    };
    if (duringTransition) {
      this.entry.duringTransition = true;
    }
  }

  /**
   * The stringified signal this collector was created for. Sourced from the
   * signal passed to the constructor (already `String(signal)`), so no new
   * parameter has to be threaded through the dispatch call sites.
   */
  get signal(): string {
    return this.entry.signal;
  }

  merge(): Result {
    if (this.results.length === 1 && this.results[0] != null) {
      return this.results[0];
    }

    const final = mergeResults(this.results);
    this.results = [final];
    return final;
  }

  push(val: unknown): void {
    const res = val instanceof Result ? val : Result.error(val);
    this.results.push(res);
  }

  logStateChange(stateName: string, oldState: StateInstance, newState: StateInstance) {
    this.entry.stateChanges.push({
      stateName,
      oldState: String(oldState),
      newState: String(newState),
    });
  }

  logHandler(
    stateName: string,
    type: "enter" | "exit" | "update" | "rollback",
    handlerName: string,
    result: unknown,
  ): void {
    this.entry.handlerResults.push({
      type,
      handlerName,
      stateName,
      result: String(result),
    });
  }

  logEnqueue(signal: string, handlerName: string) {
    this.entry.enqueuedSignals.push({ signal, fromHandler: handlerName });
  }

  logObserver(stateName: string, observerName: string, needObserve: boolean) {
    this.entry.observers.push({
      stateName,
      observerName,
      needObserve,
    });
  }

  async finish(snapshot: Record<string, StateInstance>, result: Result): Promise<StateFlowLogEntry> {
    this.entry.stacktrace = result.stacktrace;

    let finalResult = result;
    if (result.kind === ResultKind.InTransition) {
      const startTime = this.entry.startTime;
      finalResult = await result.waitAll();
      this.entry.isAsync = true;
      this.entry.duration = Date.now() - startTime;
    }

    this.entry.finalStates = Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, String(v)]));
    this.entry.finalResult = String(finalResult);

    const timing = this.entry.duration != null ? `[${this.entry.duration}ms] ` : "";
    const stale = this.entry.duringTransition ? "(during transition) " : "";

    this.entry.message = `[SF/${this.entry.flowName}] ${this.entry.signal} - ${
      this.entry.isAsync ? "async " : ""
    }${timing}${stale}${this.entry.finalResult}`;
    return this.entry;
  }
}

export function mergeResults(results: Result[], ignoreMessage = ""): Result {
  return results.reduce((l, r) => r.merge(l), Result.ignore(ignoreMessage));
}
