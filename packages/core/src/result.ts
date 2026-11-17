/**
 * Results. A reducer returns a {@link StateResult} (or props or an instance bare), a handler returns a
 * {@link HandlerResult}, and everything the engine makes (a merge, a refusal it finds, a timeout, an abort)
 * is an internal Verdict. `send()` and `dispatch()` return a {@link Result}, the abstract base of all three.
 *
 * Merging ranks Error > Rejected > OK > Ignored (see {@link Result.merge}); an `InTransition` result (a
 * declared or pending transition) cannot be merged.
 *
 * @example ```ts
 *   // a reducer: the instance it commits, or a refusal
 *   return StateResult.ok(audio.unmuted({ volume: 0.7 }));
 *   return StateResult.rejected("not allowed");
 *
 *   // a handler
 *   return HandlerResult.ok();
 *   return HandlerResult.ignored("already muted");
 *   try {
 *     // ...
 *   } catch (err) {
 *     return HandlerResult.error(err);
 *   }
 * ```
 */

import type { StateFlowLogEntry } from "./logger";
import type { Signal } from "./signal";
import { isState, type StateInstance, type StateVariant } from "./state";
import { DEF, VARIANT, VARIANT_ID } from "./symbols";
import { StateFlowError } from "./utils";

export enum ResultKind {
  /**
   * The signal committed: a reducer returned a state, or a declared transition's next committed.
   */
  OK,

  /**
   * No reducer handled the signal; nothing committed.
   */
  Ignored,

  /**
   * A transition declared by a reducer (`StateResult.transition`), or the pending result `send()` returns
   * while its work runs; `done()` resolves to its outcome.
   */
  InTransition,

  /**
   * A reducer rejected the signal, and nothing committed; or an exit, update or enter handler, or another state's
   * reducer of a named result, rejected it, and each state whose reducer declared a failed committed that failed, while
   * nothing else committed; or, as a declared transition's outcome: a handler of its work or end, or a result reducer,
   * rejected, and the node went to its failed; or an accepted abort cut it off ("aborted by <signal>"); or the send
   * came after disposeFlow, whatever its lock ("<name> is disposed"), and nothing was dispatched.
   */
  Rejected,

  /**
   * A reducer threw or returned an error, or its answers broke a rule of the dispatch, and nothing committed; or an
   * exit, update or enter handler threw or returned an error, or a named result it returned did not fold, another
   * state's answer to it failed, or the named results broke a DisposableBox rule as they folded, and each state whose
   * reducer declared a failed committed that failed, while nothing else committed; or that failed committed but one of
   * its own handlers refused, or a result reducer that folds into it failed, the FAILURE reducer included; or, as a
   * declared transition's outcome: a handler of its work, or of its end, failed, its end broke a DisposableBox rule, or
   * the work outlasted its timeout (the error is then a TransitionAborted of kind timeout), and the node went to its
   * failed; or the flow was disposed during the transition, and nothing more committed, which is also the outcome of an
   * abort waiting for its work ("flow disposed during the abort of <path>") and of every send queued behind the
   * transition ("flow disposed before <signal> was reduced"); or a string form threw while a step made after the call
   * returned (a queued send, an abort's step, a transition's end) was logged, and that step did not commit.
   */
  Error,
}

/** Options of {@link StateResult.transition}. */
export interface TransitionOptions {
  /** Milliseconds the work may run before `failed` commits. Default 500. A positive finite number up to
   * 2_147_483_647, the largest delay setTimeout honours (above it the timer fires at once). */
  timeoutMs?: number;
}

/** @internal What a declared transition adds to its answer: the temp it commits first, and its timeout. */
export interface DeclaredTransition {
  temp: StateInstance<any>;
  timeoutMs: number;
}

/**
 * @internal What a reducer's StateResult decided: the instance it commits, where a refused step takes the node
 * (undefined, which only an ok answer leaves it: it stays as it was), and, for a transition, the rest.
 */
export interface ReducerAnswer {
  next: StateInstance<any>;
  failed: StateInstance<any> | undefined;
  transition: DeclaredTransition | null;
}

/** @internal A named result's data and where it folds: the result reducer `name` of `variant`. */
interface NamedData {
  variant: StateVariant;
  name: string;
  data: unknown;
}

// The largest delay setTimeout accepts; a larger one overflows its 32-bit field and fires at once.
const MAX_TIMEOUT_MS = 2_147_483_647;

// The order merge() ranks kinds in: a later kind wins over an earlier one.
const MERGE_ORDER: readonly ResultKind[] = [ResultKind.Ignored, ResultKind.OK, ResultKind.Rejected, ResultKind.Error];

/**
 * A verdict on a signal or on a handler's work. Abstract: reducers return {@link StateResult}s, handlers
 * {@link HandlerResult}s, and `send()` and `dispatch()` return what the engine made.
 */
export abstract class Result {
  readonly kind: ResultKind;

  // The message of an Ignored or Rejected result, or the error of an Error result.
  readonly #reason: string | Error;

  // The code of a refusal whose text the engine wrote, or of a merge of Errors (see `code`); null otherwise.
  readonly #code: string | null;

  // The plain data a handler's Rejected carries (see `data`); undefined otherwise. Not readonly: a copy or a merge
  // sets it on the Verdict it makes, as it sets the signal, handler and state (see #verdictWith).
  #data: Readonly<Record<string, unknown>> | undefined;

  // What done() waits for: set only on the pending result of a send whose end is still to come.
  readonly #pending: Promise<Result> | null;

  // kinds the caller asserted via expect() on an InTransition result.
  // The assertion is deferred to the FINAL resolved result and enforced in done().
  #expectedKinds: ResultKind[] | null = null;

  // contexts for logging purposes
  #timestamps: [number, number];
  #signal: Signal | null = null;
  #handler: string | null = null;
  #state: string | null = null;

  /** @internal Called only by the constructors of StateResult, HandlerResult and Verdict. */
  protected constructor(
    kind: ResultKind,
    reason: string | Error,
    pending: Promise<Result> | null = null,
    code: string | null = null,
    data: Readonly<Record<string, unknown>> | undefined = undefined,
  ) {
    // `abstract` binds TypeScript callers only; this check also binds a cast and plain JavaScript.
    if (new.target === Result) {
      throw new StateFlowError(
        "SF065",
        "Result is abstract: a reducer returns a StateResult, a handler a HandlerResult",
      );
    }
    this.kind = kind;
    this.#reason = reason;
    this.#pending = pending;
    this.#code = code;
    this.#data = data;
    const now = Date.now();
    this.#timestamps = [now, now];
  }

  get startedAt(): number {
    return this.#timestamps[0];
  }

  get finishedAt(): number {
    return this.#timestamps[1];
  }

  in(...args: ResultKind[]): boolean {
    return args.includes(this.kind);
  }

  /**
   * Resolves to the outcome of a pending result (the end a declared transition reached, or a queued send's
   * own result once it is reduced, or the Error of disposeFlow when it ended the transition first); resolves to the
   * result itself for every other result. Applies a deferred `expect()` to that outcome.
   */
  async done(): Promise<Result> {
    const final = this.#pending != null ? await this.#pending : this;
    return this.#assertExpected(final);
  }

  /**
   * Error object for `Error` results
   * Or null for all other kinds of results
   */
  get error(): Error | null {
    return this.#reason instanceof Error ? this.#reason : null;
  }

  /**
   * Message string for `Ignored` or `Rejected` kinds
   * Or null for all other kinds of results
   */
  get message(): string | null {
    if (typeof this.#reason === "string" && this.#reason !== "") {
      return this.#reason;
    }
    return null;
  }

  /**
   * The code of this result's cause in error-codes.json: its error's code when that is a StateFlowError, the code of
   * a refusal whose text the engine wrote itself (listed in the API reference), and null for every other result, one
   * a reducer or a handler built from its own text included. A refusal's message stays the engine's text alone. A
   * merge keeps the winner's code; a merge that joins two messages (two Ignored, two Errors) the earlier one's, or the
   * later one's when the earlier has none.
   */
  get code(): string | null {
    return this.#reason instanceof StateFlowError ? this.#reason.code : this.#code;
  }

  /**
   * The plain data a handler gave with its refusal (`HandlerResult.rejected(message, data)`), the same object, not a
   * copy; undefined for a refusal without data and for every other result. A tap reads it here, on the handler's
   * result.
   */
  get data(): Readonly<Record<string, unknown>> | undefined {
    return this.#data;
  }

  expect(...kinds: ResultKind[]): this {
    if (this.kind === ResultKind.InTransition) {
      // Defer the assertion to the FINAL resolved result. No side promise is parked here: one that
      // rejected would be an unhandled rejection whenever done() is never called. done() applies
      // #expectedKinds to whatever the transition resolves to, so `.expect(...).done()` composes in
      // any order.
      this.#expectedKinds = kinds;
      return this;
    }

    if (!kinds.includes(this.kind)) {
      throw new StateFlowError(
        "SF066",
        buildErrorMessages(this.kind, this.error, this.message, this.#signal, this.#handler, this.#state),
        this.error,
      );
    }
    return this;
  }

  /**
   * Applies the kinds expect() stored on an InTransition result to the FINAL
   * resolved result. Throws if the final kind is not allowed. No-op when no
   * expectation was registered.
   * @internal
   */
  #assertExpected(final: Result): Result {
    if (this.#expectedKinds == null) {
      return final;
    }
    if (!this.#expectedKinds.includes(final.kind)) {
      throw new StateFlowError(
        "SF066",
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

  /** @internal Names the signal the result is about, for expect()'s message. */
  withSignal(signal: Signal | null): this {
    this.#signal = signal;
    return this;
  }

  /** @internal Names the handler whose result this is, for expect()'s message. */
  withHandlerName(name: string | null): this {
    this.#handler = name;
    return this;
  }

  /** @internal Names what the handler was doing ("enter media.producers[cam]"), for expect()'s message. */
  withStateUpdating(state: string | null): this {
    this.#state = state;
    return this;
  }

  /**
   * Combines this result with a later one into a new result that carries no named result: Error > Rejected > OK >
   * Ignored. Of one kind this result, the earlier, wins, except that two Ignored join their messages and two
   * Errors become one Error whose error is an AggregateError of both and whose message joins theirs ("a; b").
   * Each merge aggregates only its two sides, so merging a third Error into that result nests the first
   * AggregateError in a new one: its `errors` are [AggregateError(a, b), c], its message "a; b; c".
   * The new result keeps the winner's signal, handler, state and refusal data (see `data`), and spans both results'
   * times.
   *
   * @throws StateFlowError when either result is InTransition (a declared or pending transition).
   */
  merge(other: Result): Result {
    this.#refuseTransition();
    other.#refuseTransition();
    const winner = MERGE_ORDER.indexOf(other.kind) > MERGE_ORDER.indexOf(this.kind) ? other : this;
    let reason = winner.#reason;
    let code = winner.#code;
    // A merge that joins both messages names the first code of the two, so a cause with a code is never left
    // without it.
    if (this.kind === other.kind && this.kind === ResultKind.Ignored) {
      reason = joinMessages(String(this.#reason), String(other.#reason));
      code = this.code ?? other.code;
    } else if (this.kind === other.kind && this.kind === ResultKind.Error) {
      // The reason of an Error result is its Error: every way to build one goes through toError. The merged error is
      // not the engine's, so its code is held here.
      const errors = [this.#reason as Error, other.#reason as Error];
      reason = new MergedErrors(errors, joinMessages(errors[0].message, errors[1].message));
      code = this.code ?? other.code;
    }
    return winner.#verdictWith(reason, code).withTimestamps(...this.#timestamps, ...other.#timestamps);
  }

  /**
   * @internal A new Verdict of this result's kind, reason, data, signal, handler, state and times.
   * The engine names and tags copies, never a result a reducer or a handler returned: several handlers may
   * return one constant.
   *
   * @throws StateFlowError when this result is InTransition, as {@link Result.merge} does.
   */
  copy(): Verdict {
    this.#refuseTransition();
    return this.#verdictWith(this.#reason, this.#code).withTimestamps(...this.#timestamps);
  }

  // A declared or pending transition is not a verdict: the engine never merges or copies one, and a merge or
  // a copy would drop the declared transition's answer or the outcome a pending result waits for.
  #refuseTransition(): void {
    if (this.kind === ResultKind.InTransition) {
      throw new StateFlowError("SF067", "a pending or declared transition result cannot be merged or copied");
    }
  }

  // A new Verdict of this result's kind with `reason` and `code`, keeping its data, signal, handler and state.
  #verdictWith(reason: string | Error, code: string | null): Verdict {
    const verdict = new Verdict(this.kind, reason, null, code);
    verdict.#data = this.#data;
    verdict.#signal = this.#signal;
    verdict.#handler = this.#handler;
    verdict.#state = this.#state;
    return verdict;
  }

  get [Symbol.toStringTag](): string {
    return `Result.${ResultKind[this.kind]}`;
  }

  [Symbol.toPrimitive](): string {
    if (this.kind === ResultKind.Error) {
      return this.error != null ? String(this.error) : ResultKind[this.kind];
    }

    return `${ResultKind[this.kind]}${this.message != null ? `: ${this.message}` : ""}`;
  }
}

/**
 * What a signal reducer returns. A reducer may also return props or an instance bare: an instance is the same as
 * `StateResult.ok(instance)`, and props have no other way in, since ok and transition take instances only.
 */
export class StateResult extends Result {
  // What the reducer decided; null for ignored, rejected and error.
  readonly #answer: ReducerAnswer | null;

  private constructor(kind: ResultKind, reason: string | Error, answer: ReducerAnswer | null) {
    super(kind, reason);
    this.#answer = answer;
    Object.freeze(this);
  }

  /** @internal What the reducer decided, read by the engine; null for ignored, rejected and error. */
  get answer(): ReducerAnswer | null {
    return this.#answer;
  }

  /**
   * The reducer's answer: `next`, an instance of the reducer's own state, commits when every handler of the step
   * passes. When a handler refuses the step, the node goes to `failed` and the dispatch's result is the refusal, with
   * the refusals of the failed step's own handlers added as an Error (see StateManager); without `failed` it stays as
   * it was and nothing of the step commits.
   *
   * @param next - The instance the node takes.
   * @param failed - An instance of the same state, checked when the reducer returns. The refusal reaches its props
   *   through the result reducer its variant has for FAILURE, if any (see defineFlow). It may be next itself or hold
   *   the instances next holds: the failed step calls the handlers of its diff from the instances before the signal,
   *   so it enters or updates again an instance the refused step entered or updated, as it exits again one the refused
   *   step exited; an enter or update handler may run twice in one dispatch, as an exit handler may (see StateManager).
   * @throws StateFlowError when `next` is not a state instance (a reducer answers with props by returning them
   *   bare), or `failed` is not an instance of next's state. Inside a reducer the throw becomes an Error result; a
   *   `next` of a state other than the reducer's own is an Error when the reducer returns.
   *
   * @example
   * ```ts
   * // on's enter handler switches the bulb on; when it refuses or throws, the lamp goes to broken.
   * defineFlow(lamp.off, { switchOn: (s) => StateResult.ok(lamp.on(s), lamp.broken(s)) });
   * // broken takes the refusal's reason into its props.
   * defineFlow(lamp.broken, {}, { [FAILURE]: (s, { reason }) => ({ ...s, reason: reason ?? null }) });
   * ```
   */
  // `any` in every slot: a concrete instance is not assignable to `StateInstance` with its defaults, because
  // its definition's signals and string form are typed by its own props and signals. NoInfer makes `next` the
  // only inference site for T: `failed` is checked against next's type and takes no part in inferring it.
  static ok<T extends StateInstance<any, any, any, any>>(next: T, failed?: NoInfer<T>): StateResult {
    if (!isState(next)) {
      throw new StateFlowError("SF068", "StateResult.ok takes a state instance; a reducer returns props bare");
    }
    if (failed !== undefined && !(isState(failed) && failed[VARIANT][DEF] === next[VARIANT][DEF])) {
      throw new StateFlowError("SF069", "StateResult.ok: failed must be an instance of next's state");
    }
    return new StateResult(ResultKind.OK, "", { next, failed, transition: null });
  }

  /**
   * Declares a transition into `next`, an entry that waits for the world; returned by a reducer only. A first step
   * commits `temp` at once, together with the dispatch's other answers. The work is every transition handler of every
   * asynchronous variant the step from temp to next enters, started together with one AbortSignal. When every handler
   * settles OK or Ignored, the named results they returned fold and next commits; when one refuses or fails, or the
   * work outlasts `timeoutMs`, the node goes to `failed`. The work never chooses a state, and the target's lock stays
   * held until the end. A transition whose end enters no asynchronous variant, or none with a transition handler
   * registered, has no work, so next commits inside the send that declared it.
   *
   * @param next - The instance the node takes when the work succeeds.
   * @param temp - The instance the node holds while the work runs. Its own instance (`def(ctx)` for a top-level
   *   state) keeps it as it is: the temp step then changes nothing there.
   * @param failed - An instance of next's state, checked when the reducer returns: the node takes it when the work
   *   refuses, fails or outlasts its timeout, or the end step is refused. The failure reaches its props through the
   *   result reducer its variant has for FAILURE, if any (see defineFlow). It may hold temp's and next's instances:
   *   as for ok's failed, the step into failed enters or updates again an instance the refused temp step or end step
   *   entered or updated, so an enter or update handler may run twice in one dispatch.
   * @param options - `timeoutMs`, default 500.
   * @throws StateFlowError when next, temp or failed is not a state instance (a reducer answers with props by
   *   returning them bare), the instances are not of one state definition, or the options are not an object that
   *   holds only a timeoutMs, a positive finite number up to 2_147_483_647. Inside a reducer the throw becomes an
   *   Error result.
   *
   * @example
   * ```ts
   * play: (s, { url }) =>
   *   StateResult.transition(
   *     driver.active({ ...s, url, manifest: null }),
   *     driver.activating({ ...s, url }),
   *     driver.failed({ ...s, url }),
   *     { timeoutMs: 5000 },
   *   ),
   * ```
   */
  static transition<T extends StateInstance<any, any, any, any>>(
    next: T,
    temp: NoInfer<T>,
    failed: NoInfer<T>,
    options: TransitionOptions = {},
  ): StateResult {
    if (!isState(next)) {
      throw new StateFlowError(
        "SF070",
        "StateResult.transition takes a state instance as next; a reducer returns props bare",
      );
    }
    if (!isState(temp)) {
      throw new StateFlowError(
        "SF071",
        "StateResult.transition takes a state instance as temp, the instance the node holds while the work runs",
      );
    }
    if (!isState(failed)) {
      throw new StateFlowError(
        "SF072",
        "StateResult.transition takes failed, an instance of next's state, which the node takes when the work fails",
      );
    }
    const def = next[VARIANT][DEF];
    if (temp[VARIANT][DEF] !== def || failed[VARIANT][DEF] !== def) {
      throw new StateFlowError(
        "SF073",
        "StateResult.transition: next, temp and failed must be instances of one state definition",
      );
    }
    if (typeof options !== "object" || options === null) {
      throw new StateFlowError("SF074", "StateResult.transition: the options are an object { timeoutMs }");
    }
    const other = Object.keys(options).find((key) => key !== "timeoutMs");
    if (other !== undefined) {
      throw new StateFlowError("SF075", `StateResult.transition: the options take timeoutMs only, not ${other}`);
    }
    const timeoutMs = options.timeoutMs ?? 500;
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
      throw new StateFlowError(
        "SF076",
        `StateResult.transition: timeoutMs must be a positive finite number <= ${MAX_TIMEOUT_MS}, got ${timeoutMs}`,
      );
    }
    return new StateResult(ResultKind.InTransition, "", { next, failed, transition: { temp, timeoutMs } });
  }

  /** The reducer does not take the signal: its state stays as it is. */
  static ignored(message = ""): StateResult {
    return new StateResult(ResultKind.Ignored, message, null);
  }

  /** The reducer refuses the signal: nothing commits. */
  static rejected(message: string): StateResult {
    return new StateResult(ResultKind.Rejected, message, null);
  }

  /** The reducer fails with `error`; a value that is not an Error becomes one. Nothing commits. */
  static error(error: unknown): StateResult {
    return new StateResult(ResultKind.Error, toError(error), null);
  }
}

/**
 * A named result of the variant `TVariantId` ("<state>.<variant>"), an OK whose data the variant's result reducer
 * folds into the instance its handler entered or updated, and which every other state with a result reducer of its
 * name takes. Built only by the variant's factories, `driver.active.results.loaded(data)`.
 * @internal
 */
export let namedResult: <TVariantId extends string>(named: NamedData) => HandlerResult<TVariantId>;

/**
 * What an enter, exit or update handler returns: one of the four plain results, which fit every handler, or a
 * named result of the variant `TVariantId`, which only an enter or an update handler of that variant may return. Any
 * of them, a transition handler's too, may carry commit delegates (see {@link HandlerResult.onCommit}).
 */
export class HandlerResult<TVariantId extends string = never> extends Result {
  // Type-only: the variant whose result reducer folds this result; the four plain results leave it never, so they
  // fit every handler. Public, because a private member loses its type in the emitted declarations.
  declare readonly [VARIANT_ID]?: TVariantId;

  // The variant, result name and data of a named result; null for the four plain results.
  readonly #named: NamedData | null;

  // The commit delegates, in the order they run (see onCommit).
  readonly #delegates: ReadonlyArray<() => void>;

  private constructor(
    kind: ResultKind,
    reason: string | Error,
    named: NamedData | null = null,
    delegates: ReadonlyArray<() => void> = [],
    data: Readonly<Record<string, unknown>> | undefined = undefined,
  ) {
    super(kind, reason, null, null, data);
    this.#named = named;
    this.#delegates = delegates;
    Object.freeze(this);
  }

  // Assigns namedResult, declared above this class: the one place that reaches its private constructor.
  static {
    namedResult = (named) => new HandlerResult(ResultKind.OK, "", named);
  }

  /** @internal The variant, result name and data of a named result, read by the engine; null for a plain one. */
  get named(): NamedData | null {
    return this.#named;
  }

  /** @internal The commit delegates, read by the engine, in the order they run. */
  get delegates(): ReadonlyArray<() => void> {
    return this.#delegates;
  }

  static ok(): HandlerResult {
    return new HandlerResult(ResultKind.OK, "");
  }

  /** The handler had nothing to do; it does not refuse the step. */
  static ignored(message = ""): HandlerResult {
    return new HandlerResult(ResultKind.Ignored, message);
  }

  /**
   * The handler refuses the step. `data`, when given, is a record of plain data about the refusal, for a decision
   * that must not read the message: the failed end the refusal leads to gets it as the `data` of its FAILURE result
   * (see FailureData), from a transition handler and from an exit, update or enter handler alike, and a tap reads it
   * as the result's `data`, so a recording keeps it and a replay gives it back.
   *
   * The failed end gets a frozen shallow copy, as a reducer gets a signal's payload, and the engine checks nothing in
   * it: what it holds deeper is the handler's own object, which the refusal neither copies nor freezes. As for a
   * payload, a reducer that keeps a deeper value in a prop of its own has it frozen there, in place. No text the
   * engine writes prints the data.
   */
  static rejected(message: string, data?: Readonly<Record<string, unknown>>): HandlerResult {
    return new HandlerResult(ResultKind.Rejected, message, null, [], data);
  }

  /** The handler fails the step with `error`; a value that is not an Error becomes one. */
  static error(error: unknown): HandlerResult {
    return new HandlerResult(ResultKind.Error, toError(error));
  }

  /**
   * This result, of the same kind, with `delegates` added after the ones it carries. When the step whose exit, update
   * or enter handler returned it commits, the engine calls them right after the commit, before the commit handlers, in
   * the order of the handler calls that returned them; a step that does not commit drops them. So a handler that
   * replaces a resource releases the old one here, and a refused step leaves the world as it leaves the state.
   *
   * The kind does not decide: an Ignored in a step that commits runs its delegates, and so do a Rejected and an Error
   * in a failed step, which commits whatever its handlers return. An exit handler runs in every step that leaves its
   * variant, so when the failed step after a refused one leaves the instance that step left, its exit call returns its
   * delegates anew and they run at the failed step's commit (see StateHandler). A transition handler's delegates run
   * when the transition's end step commits, before those of the end step's own handlers, in the order of the work's
   * calls; an end that does not commit, whatever kept it, drops them.
   *
   * A delegate is synchronous and its return value is ignored. A throw is logged as a commit handler's is, as a commit
   * result named by the handler that returned the delegate, and the next delegate still runs. Like a handler, a
   * delegate must not dispatch to or dispose its own target synchronously: that throws.
   *
   * @example
   * ```ts
   * sm.addEnterHandler(source.online, (s, _snapshot, prev) =>
   *   source.online.results.polled({ poll: Box.of(startPoll(s.url)) }).onCommit(() => prev?.poll?.deref().stop()),
   * );
   * ```
   */
  onCommit(...delegates: Array<() => void>): HandlerResult<TVariantId> {
    // The reason is private to Result: an Error result's is its error, any other's its message, "" when it has none.
    return new HandlerResult(
      this.kind,
      this.error ?? this.message ?? "",
      this.#named,
      [...this.#delegates, ...delegates],
      this.data,
    );
  }

  /** `OK(loaded)` for a named result, so its handler result in a log entry names it; as any result otherwise. */
  [Symbol.toPrimitive](): string {
    return this.#named !== null ? `OK(${this.#named.name})` : super[Symbol.toPrimitive]();
  }
}

/**
 * @internal Every result the engine makes: a merge, a refusal it finds, a timeout, an abort or a dispose,
 * and the pending result of a send whose end is still to come. The package does not export it, and a reducer or
 * a handler that returns one returns neither a StateResult nor a HandlerResult, which is an Error.
 */
export class Verdict extends Result {
  constructor(
    kind: ResultKind,
    reason: string | Error,
    pending: Promise<Result> | null = null,
    code: string | null = null,
  ) {
    super(kind, reason, pending, code);
    Object.freeze(this);
  }

  static ok(): Verdict {
    return new Verdict(ResultKind.OK, "");
  }

  /** An Ignored result; `code` names the table entry of a message the engine wrote, null when it wrote none. */
  static ignored(code: string | null = null, message = ""): Verdict {
    return new Verdict(ResultKind.Ignored, message, null, code);
  }

  /** A Rejected result whose message the engine wrote, with the code of that message's table entry. */
  static rejected(code: string, message: string): Verdict {
    return new Verdict(ResultKind.Rejected, message, null, code);
  }

  static error(error: unknown): Verdict {
    return new Verdict(ResultKind.Error, toError(error));
  }

  /** An InTransition result whose `done()` resolves to `outcome`. */
  static pending(outcome: Promise<Result>): Verdict {
    return new Verdict(ResultKind.InTransition, "", outcome);
  }
}

/**
 * The Error an Error result carries: `error` itself, or for any other thrown value an Error with its string
 * form as the message. Never throws, so logging the result by its string form later cannot throw either:
 * the engine maps every handler's throw through here.
 */
function toError(error: unknown): Error {
  try {
    // Taken for every value, Errors too, so a value with no string form is caught here and not when the
    // result is logged: Object.create(null) and a revoked Proxy have none, and neither has an Error whose
    // toString or message getter throws.
    const text = String(error);
    return error instanceof Error ? error : new Error(text);
  } catch {
    return new Error("a thrown value with no string form", { cause: error });
  }
}

/** The AggregateError of two Errors that merged (see Result.merge): the only kind of error a log entry's data lists
 * flat. Its name stays "AggregateError", so the text of a result is the same as before. */
class MergedErrors extends AggregateError {}

/**
 * The name and message of `error`, or of each error a merge of the engine holds, at any depth (Result.merge nests a
 * merge of merges); none for null. Any other error, an AggregateError a handler threw included, is one entry: a
 * missing (null or undefined) name reads "Error", a missing message "", and anything else its string form.
 */
function flatErrors(error: Error | null): NonNullable<StateFlowLogEntry["finalResultData"]>["errors"] {
  if (error == null) {
    return [];
  }
  if (!(error instanceof MergedErrors)) {
    return [{ name: String(error.name ?? "Error"), message: String(error.message ?? "") }];
  }
  return error.errors.flatMap((inner: Error) => flatErrors(inner));
}

/** Two messages joined with "; ", leaving out an empty one. */
function joinMessages(a: string, b: string): string {
  if (a === "") {
    return b;
  }
  if (b === "") {
    return a;
  }
  return `${a}; ${b}`;
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
      msg += "threw an error";
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
    msg += ` while trying to ${stateUpd}`;
  }

  if (error != null) {
    msg += `: ${error}`;
  }

  if (message != null) {
    msg += `: Message: ${message}`;
  }
  return msg;
}

// Global step-start counter shared by ALL flows on the page: each entry takes the next value when its
// collector is made, which gives a total order of step starts that delivery-ordered logs and
// same-millisecond startTime ties cannot provide.
let dispatchCounter = 0;

/** Builds the log entry of one step: a dispatch, a declared transition's end, or an accepted abort. */
export class ResultCollector {
  /**
   * The entry's `dispatchOrder`, as a number: the entry's type leaves it optional for hand-built entries. A field is
   * initialized before the constructor's body runs, so a collector whose signal's string form throws there has taken
   * its number all the same, and the next entry's is one more.
   */
  readonly dispatchOrder = ++dispatchCounter;
  /** The entry as written so far; finish completes it. The engine reads its transition mark and its observers when
   * it tells the taps a step ended (see FlowTap.ended in flow.ts). */
  readonly entry: StateFlowLogEntry;

  /** Starts an entry of flow `flowName` for `signal`; it takes the next `dispatchOrder`. */
  constructor(flowName: string, signal: unknown) {
    this.entry = {
      message: "",
      flowName,
      signal: String(signal),
      isAsync: false,
      startTime: Date.now(),
      dispatchOrder: this.dispatchOrder,
      finalStates: {},
      stateChanges: [],
      handlerResults: [],
      observers: [],
      finalResult: "",
    };
  }

  /** The signal's string form, as the entry records it. */
  get signal(): string {
    return this.entry.signal;
  }

  /** Marks the entry as a declared transition's: its temp step, or the end it reached (next, or failed). */
  setTransition(which: "temp" | "final" | "failed"): void {
    this.entry.transition = which;
  }

  /** Marks the entry as an accepted abort of the transition of the node at `path` (`media.producers[cam]`). */
  setAborted(path: string): void {
    this.entry.aborted = path;
  }

  /** Marks the entry as an asynchronous end of a transition that started at `startTime`. */
  markAsync(startTime: number): void {
    this.entry.isAsync = true;
    this.entry.duration = Date.now() - startTime;
  }

  /** Adds a state change to the entry, named by the node's path. An undefined side is a nested state's position
   * empty on that side, written "(none)". */
  logStateChange(stateName: string, oldState: StateInstance | undefined, newState: StateInstance | undefined) {
    this.entry.stateChanges.push({
      stateName,
      oldState: oldState === undefined ? "(none)" : String(oldState),
      newState: newState === undefined ? "(none)" : String(newState),
    });
  }

  /** Adds a handler result to the entry: the handler's kind and name, its node's path, and the Result it
   * returned, the error it threw, or what became of a transition handler's work. */
  logHandler(
    stateName: string,
    type: "enter" | "exit" | "update" | "commit" | "transition",
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

  /** Adds an observer's result on a change to the entry, named by the node's path: whether its compare asked for its
   * callback, or, when the compare threw, the Error result of the throw, whose string form the entry records. */
  logObserver(stateName: string, observerName: string, needObserve: boolean, thrown?: Result) {
    this.entry.observers.push({
      stateName,
      observerName,
      needObserve,
      ...(thrown === undefined ? {} : { error: String(thrown) }),
    });
  }

  /** Completes the entry with the final states and the result. It resolves on a later microtask, so an
   * entry is delivered after the dispatch that wrote it returns. */
  async finish(snapshot: Record<string, StateInstance>, result: Result): Promise<StateFlowLogEntry> {
    this.entry.finalStates = Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, String(v)]));
    this.entry.finalResult = String(result);
    // The data reads an error's name and message again after the text did, and a getter may throw on a later read
    // only. Such an entry goes out without the data rather than not at all.
    try {
      this.entry.finalResultData = {
        kind: ResultKind[result.kind],
        message: result.message,
        code: result.code,
        errors: flatErrors(result.error),
      };
    } catch {}

    const timing = this.entry.duration != null ? `[${this.entry.duration}ms] ` : "";

    this.entry.message = `[SF/${this.entry.flowName}] ${this.entry.signal} - ${
      this.entry.isAsync ? "async " : ""
    }${timing}${this.entry.finalResult}`;
    return this.entry;
  }
}

/**
 * The merge of `results`, folded left from the first (see {@link Result.merge}), so the first of a kind wins
 * with its handler and state. Always a new result, which the engine may tag: a copy of a single result, and
 * Ignored for none.
 */
export function mergeResults(results: readonly Result[]): Result {
  if (results.length === 0) {
    return Verdict.ignored();
  }
  return results.slice(1).reduce((merged, r) => merged.merge(r), results[0].copy());
}
