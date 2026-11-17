/**
 * Contains tools for defining states
 *
 * @example ```ts
 *
 * const audio = defineState<{volume: number}>()
 *   .name("audio")
 *   .signals(signals)
 *   .variant("unmuted", { initial: true })
 *   .variant("muted")
 *   .variant("forbidden")
 *   .stringRepr(s => `vol=${s.volume}`)
 *   .build();
 *
 * defineFlow(audio.unmuted, {
 *   mute: (s) => audio.muted(s),
 *   volume: (s, args) => audio.unmuted({ volume: args.volume }),
 * });
 *
 * defineFlow(audio.muted, {
 *   unmute: (s) => audio.unmuted(s),
 * });
 *
 * defineFlow(audio.forbidden, {
 *   unmute: (s) => StateResult.rejected("not allowed"),
 *   mute: (s) => StateResult.rejected("not allowed"),
 *   userInteraction: (s) => s.volume > 0 ? audio.unmuted(s) : audio.muted(s),
 * });
 *
 * ```
 */

import { emptyItems, type Items } from "./collections";
import { type HandlerResult, namedResult, type StateResult } from "./result";
import { sealProps } from "./seal-props";
import type { ReducerContext, SignalReducers } from "./signal";
import {
  DEF,
  type FAILURE,
  IS_ASYNC,
  IS_INITIAL,
  IS_TRANSITIONAL,
  PARSER,
  RESULT_REDUCERS,
  SIGNAL_REDUCERS,
  SIGNALS,
  SNAPSHOT,
  STRING_REPR,
  VARIANT,
  type VARIANT_ID,
} from "./symbols";
import { type Infer, isPlainObject, StateFlowError, serializeDebug } from "./utils";

//#region Helper Types

type ExtractSignals<T> =
  T extends StateDefinition<any, "", infer TSignals, any, any>
    ? TSignals
    : T extends StateVariant<any, "", infer TSignals, any, any, any>
      ? TSignals
      : never;

type ExtractName<T> =
  T extends StateDefinition<infer _TProps, infer _TVariants, infer _TSignals, infer TName, infer _TResults>
    ? [TName] extends [""]
      ? never
      : TName
    : T extends StateVariant<
          infer _TProps,
          infer _TVariants,
          infer _TSignals,
          infer TName,
          infer _TVariant,
          infer _TResults
        >
      ? [TName] extends [""]
        ? never
        : TName
      : never;

export type ArrayToRecord<T extends readonly unknown[]> = {
  [K in T[number] as ExtractName<K>]: Readonly<Infer<K>>;
};

/** What a signal reducer may return: props or an instance of its own state bare, or a StateResult. */
export type ReducerReturn<TProps> = TProps | StateInstance<TProps> | StateResult;

type Parser<T> = (val: object) => T;

type StringRepr<TProps, TVariants extends PropertyKey, TSignals> = (
  val: StateInstance<TProps, TVariants, TSignals>,
) => string;

/** A flow's state instances by state name: a handler's `snapshot` argument, and what a reducer's ctx carries. */
export type FlowSnapshot = Readonly<Record<string, StateInstance>>;

/** A variant's named results: result name -> the type of its data, which its parser returns. */
type ResultTypes = Record<string, unknown>;

/** The named results of a variant that declares none. */
type NoResults = Record<never, never>;

/** The named results the definition's results map `TResults` declares for the variant `TVariant`. */
type ResultTypesOf<TResults, TVariant> = TVariant extends keyof TResults
  ? TResults[TVariant] extends ResultTypes
    ? TResults[TVariant]
    : NoResults
  : NoResults;

/**
 * A result reducer: folds a named result's data into `next`, the instance being entered or updated (typed as its
 * props, as a signal reducer's state is), and returns props or an instance of the same variant. A nested element's key
 * is `ctx.key`.
 */
export type ResultReducer<TProps, TData, TDefs = any> = (
  next: TProps,
  data: TData,
  ctx: ReducerContext<TDefs>,
) => TProps | StateInstance<TProps>;

/**
 * The result reducers by which the variant `V` takes other states' named results, by result name: under a name the
 * variant does not declare, a reducer by which it takes another state's named result of that name, in the step the
 * result folds in. `state` is the node's instance before that step, typed as its props, and the reducer answers as a
 * signal reducer does, but with no transition and no failed. The data is typed never: the reducer annotates the type
 * the declaring state's parser returns (any annotation fits, and without one there is nothing to read), since nothing
 * ties a name to the state that declares it.
 */
type OtherResultReducers<V> = {
  readonly [name: string]: (state: Infer<V>, data: never, ctx: ReducerContext<DefsOf<V>>) => ReducerReturn<Infer<V>>;
};

/** The flow's definitions a variant's reducers read siblings by (`ctx.read`); `any` when the state declared none. */
type DefsOf<V> = V extends StateVariant<any, any, any, any, any, any, any, infer D> ? D : any;

/**
 * The data of the FAILURE result: what led to the failed step. `kind` says how the failure came about:
 * - `rejected`: the refusal of the step, of a transition's work or of its end step was a Rejected, which a handler
 *   returned; `reason` is its message, and there is no `error`.
 * - `error`: that refusal was an Error: a handler threw or returned one, or a named result did not fold; `reason` is
 *   the error's message, and `error` the Error, an AggregateError when two Errors merged.
 * - `timeout`: a transition's work outlasted its timeoutMs; `error` is the TransitionAborted of kind timeout, which is
 *   also the reason of the transition's signal, and `reason` its message.
 * - `aborted`: an accepted abort's own step was refused, and the failed step ends the transition it aborted in that
 *   transition's failed; `reason` and `error` are the refusal's, as for `rejected` and `error`.
 *
 * `data` is a frozen shallow copy of the record a handler gave with its Rejected (see HandlerResult.rejected), when the
 * refusal is one that carries data: of kind `rejected`, or `aborted` when the abort's step was refused that way. Of two refusals that
 * merged, the earlier Rejected's; none when an Error won. The key is absent, not undefined, when there is none, so
 * the object's keys are then kind, reason and error.
 */
export type FailureData = {
  kind: "rejected" | "error" | "timeout" | "aborted";
  reason?: string;
  error?: unknown;
  data?: Readonly<Record<string, unknown>>;
};

//#endregion

//#region State Types

/**
 * Whether the variant `TVariant` of a definition whose asynchronous variants are `TAsync` is asynchronous. A
 * definition type that names no set of them (`TAsync` is `string`, the default) leaves it `boolean`, so every built
 * definition fits such a type.
 */
type IsAsync<TAsync extends string, TVariant> = string extends TAsync
  ? boolean
  : TVariant extends TAsync
    ? true
    : false;

/**
 * Represents a state type. Contains all possible
 * state values as a hashmap
 */
export type StateDefinition<
  TProps = any,
  TVariants extends PropertyKey = string,
  TSignals = unknown,
  TName extends string = "",
  TResults = NoResults,
  // The names of the variants declared with { async: true }.
  TAsync extends string = string,
  // The flow's definitions by state name, which the reducers read siblings by (defineState<Props, Defs>()).
  TDefs = any,
> = {
  /** This state's instance in a snapshot, or in the snapshot a reducer's ctx carries: `power(ctx)`. */
  (snapshotOrCtx: unknown): StateInstance<TProps, TVariants, TSignals, TName>;
  /**
   * An empty {@link Items} of this state's instances: a map, or with `key` a set keyed by each element. A prop
   * that holds it holds nested states.
   */
  items<K = string>(options?: {
    key: (item: StateInstance<TProps, TVariants, TSignals>) => K;
  }): Items<StateDefinition<TProps, TVariants, TSignals, TName, TResults, TAsync, TDefs>, K>;
  readonly [Symbol.toStringTag]: TName;
  readonly [SIGNALS]: TSignals;
  readonly [PARSER]: Parser<TProps>;
  readonly [STRING_REPR]: StringRepr<TProps, TVariants, TSignals>;
} & {
  readonly [K in TVariants]: StateVariant<
    TProps,
    TVariants,
    TSignals,
    TName,
    K & string,
    ResultTypesOf<TResults, K>,
    IsAsync<TAsync, K>,
    TDefs
  >;
};

/**
 * Represents one of possible value for the state
 * Can be constructed by calling it as a function
 */
export type StateVariant<
  TProps = any,
  TVariants extends PropertyKey = string,
  TSignals = unknown,
  // `string`, not "", by default: the variant id below is then any "<state>.<variant>", which every variant's is.
  TName extends string = string,
  TVariant extends string = string,
  TResults extends ResultTypes = NoResults,
  // true for a variant declared with { async: true }, false for any other; `boolean` for a variant of any kind.
  TAsync extends boolean = boolean,
  // The flow's definitions by state name, which the reducers read siblings by (defineState<Props, Defs>()).
  TDefs = any,
> = {
  readonly [Symbol.toStringTag]: string;
  readonly [DEF]: StateDefinition<TProps, "", TSignals, TName>;
  readonly [SIGNAL_REDUCERS]: SignalReducers<TProps, TSignals, TDefs>;
  readonly [RESULT_REDUCERS]: Partial<
    { readonly [K in keyof TResults]: ResultReducer<TProps, TResults[K], TDefs> } & {
      readonly [FAILURE]: ResultReducer<TProps, FailureData, TDefs>;
    }
  >;
  readonly [IS_INITIAL]: boolean;
  readonly [IS_TRANSITIONAL]: boolean;
  readonly [IS_ASYNC]: TAsync;
  /**
   * One factory per named result the variant declares: it runs the result's parser on `data` now, so invalid
   * data throws (inside a handler, as that handler's throw), and returns a named result that only this variant's
   * handlers may return.
   */
  readonly results: { readonly [K in keyof TResults]: (data: TResults[K]) => HandlerResult<`${TName}.${TVariant}`> };
  /** Type-only: "<state>.<variant>", which ties the named results above to this variant's handlers. */
  readonly [VARIANT_ID]?: `${TName}.${TVariant}`;

  (props: TProps): StateInstance<TProps, TVariants, TSignals, TName>;
};

/** Any built variant: the type parameter of every function that takes one and types its handlers by it. */
export type AnyVariant = StateVariant;

/** Any built variant declared with `{ async: true }`: the variant a transition handler takes. */
export type AsyncVariant = StateVariant<any, string, unknown, string, string, NoResults, true>;

/** The instance type of a variant: what calling it returns. */
export type InstanceOfVariant<V> = V extends (props: any) => infer I ? I : never;

/** The id "<state>.<variant>" of a variant; a named result of that variant carries it in its type. */
export type VariantId<V> = V extends { readonly [VARIANT_ID]?: infer I } ? Extract<I, string> : never;

/**
 * Represents an instance of specific state.
 * Contains all required props. The state's name, `TName`, is part of the type, through the variant, so instances of
 * two states with the same props are not of one type.
 */
export type StateInstance<
  TProps = unknown,
  TVariants extends PropertyKey = string,
  TSignals = unknown,
  // `string`, as for StateVariant: the variant below then has an id that any concrete variant's overlaps.
  TName extends string = string,
> = {
  readonly [Symbol.toStringTag]: string;
  readonly [VARIANT]: StateVariant<TProps, TVariants, TSignals, TName>;
} & {
  readonly [K in keyof TProps]: TProps[K];
};

/** Any state definition: `never` variants leave the per-variant members out of the type, so every built
 * definition fits it; with `any` they would form a string index signature that no built definition has. */
export type AnyDefinition = StateDefinition<any, never, any, any>;

/** The instance type of a definition: `type Transport = InstanceOf<typeof transport>`. */
export type InstanceOf<TDef> = TDef extends (snapshotOrCtx: unknown) => infer I ? I : never;

//#endregion

//#region Helper Functions

export function isState(state: unknown): state is StateInstance {
  return typeof state === "object" && state != null && VARIANT in state;
}

/** Tells a state variant, a function one of a definition's variants is, from any other value. */
export function isVariant(value: unknown): value is StateVariant {
  return typeof value === "function" && DEF in value;
}

export function isStateDef(obj: unknown): obj is StateDefinition {
  return obj != null && typeof obj === "function" && SIGNALS in obj;
}

export function stateVar<T>(obj: StateInstance<T> | T): StateVariant<T> {
  if (obj == null || typeof obj !== "object" || !(VARIANT in obj)) {
    throw new StateFlowError("SF080", "Not a state");
  }

  return obj[VARIANT] as StateVariant<T>;
}

export function getInitialState<TProps>(def: StateDefinition<TProps>): StateVariant<TProps> {
  const svar = Object.values(def).find((x) => x[IS_INITIAL]);
  if (svar == null) {
    throw new StateFlowError("SF081", "Initial state variant not found");
  }
  return svar;
}

export function getName<T extends StateDefinition>(def: T): ExtractName<T> {
  return def[Symbol.toStringTag] as ExtractName<T>;
}

//#endregion

/**
 * Builds a new immutable state instance of `value` from `props`: the parser, sealProps, then {@link instantiate}.
 *
 * @throws StateFlowError when the parser returns anything but a plain object (prototype Object.prototype or null):
 *   the engine rebuilds a node by copying its props without running a constructor, so a class instance would lose
 *   its private fields there.
 */
function factory<TProps, TVariants extends PropertyKey, TSignals>(
  value: StateVariant<TProps, TVariants, TSignals>,
  props: TProps | StateInstance<TProps, TVariants, TSignals>,
): StateInstance<TProps, TVariants, TSignals> {
  const inst: unknown = value[DEF][PARSER](props as object);
  if (!isPlainObject(inst)) {
    throw new StateFlowError(
      "SF082",
      `${String(value)}: the parser returned something other than a plain object (prototype Object.prototype or null); ` +
        "the engine copies props without a constructor when it rebuilds a node",
    );
  }
  sealProps(inst); // deep-freeze plain data / accept immutable-value-like / skip Boxes / verdict on live instances
  return instantiate(value, inst) as StateInstance<TProps, TVariants, TSignals>;
}

/**
 * Makes `props`, which passed the parser and sealProps, an instance of `variant`: gives it the variant and its
 * string form, and freezes it. The factory ends with it, and the engine's rebuild of a node whose nested states
 * changed calls it directly, so a rebuild runs no user code: no parser, which could throw where a step has no
 * branch for it.
 */
export function instantiate(variant: StateVariant, props: object): StateInstance {
  const name = String(variant);
  Object.defineProperties(props, {
    [Symbol.toStringTag]: { value: name, writable: false, configurable: false, enumerable: false },
    [Symbol.toPrimitive]: {
      value: () => `${name}(${variant[DEF][STRING_REPR](props as StateInstance)})`,
      writable: false,
      configurable: false,
      enumerable: false,
    },
    [VARIANT]: { value: variant, writable: false, configurable: false, enumerable: false },
  });
  return Object.freeze(props) as StateInstance;
}

/** What a state definition does when called: its instance in a snapshot, or in the snapshot a reducer's ctx carries. */
function extract(def: AnyDefinition, snapshotOrCtx: unknown): StateInstance {
  const name = def[Symbol.toStringTag];
  // A reducer's ctx carries its snapshot under a symbol rather than holding the states itself, so no state name
  // clashes with ctx's own keys.
  const snapshot =
    typeof snapshotOrCtx === "object" && snapshotOrCtx != null && SNAPSHOT in snapshotOrCtx
      ? snapshotOrCtx[SNAPSHOT]
      : snapshotOrCtx;
  if (snapshot == null || typeof snapshot !== "object" || !(name in snapshot)) {
    throw new StateFlowError("SF083", "State Flow object not found");
  }
  const state: unknown = Reflect.get(snapshot, name);
  // Two definitions may share a name; only an instance of this one is its state.
  if (!isState(state) || state[VARIANT][DEF] !== def) {
    throw new StateFlowError("SF084", `State not found: ${name}`);
  }

  return state;
}

/** A variant's named results by name: each the parser of its data. */
type ResultParsers<TResults extends ResultTypes> = { readonly [K in keyof TResults]: (data: unknown) => TResults[K] };

/** Options of a variant (see `variant()` of the state builder). */
interface VariantOptions<TResults extends ResultTypes, TAsync extends boolean> {
  /** The variant applyFlow starts the state in; one per state. */
  initial?: boolean;
  /**
   * A variant the engine commits only as the temp of a declared transition, at the top level or nested: a reducer's
   * answer that would leave a node in it is an Error, so the node leaves it when the transition ends, to next, to
   * failed, or by an abort reducer; only a string form that throws while the failed end is logged stops that commit
   * and leaves it there. Its reducers are the abort reducers of the transitions that pass through it. Its entry is
   * synchronous. Not with `initial`.
   */
  transitional?: boolean;
  /**
   * A variant whose entry waits for the world: a node enters it only as the next of a declared transition, whose
   * work is the variant's transition handlers. An ok answer, a temp or a failed that enters it, and an initial
   * snapshot that holds it, are Errors. Only an asynchronous variant takes transition handlers. Not with `initial`
   * or `transitional`.
   */
  async?: TAsync;
  /**
   * Named results: name -> the parser of its data, `(data: unknown) => T`. build() puts a factory per name on
   * the variant's `results`, and defineFlow takes a result reducer per name that folds the data into props. Every
   * other state with a result reducer of a name takes the result too, so applyFlow throws when another definition of
   * the flow declares the same name.
   */
  results?: ResultParsers<TResults>;
}

/** One `.variant()` call: the variant's name, its flags, and the parsers of its named results. */
type VariantSpec<TVariants> = {
  name: TVariants;
  isInitial: boolean;
  isTransitional: boolean;
  isAsync: boolean;
  results: ResultParsers<ResultTypes>;
};

class StateBuilder<
  TProps,
  TVariants extends PropertyKey,
  TSignals,
  TName extends string,
  TResults,
  // The names of the variants added with { async: true }.
  TAsync extends string,
  // The flow's definitions by state name, which the reducers read siblings by (see defineState).
  TDefs = any,
> {
  #signals?: TSignals;

  readonly #variants: Array<VariantSpec<TVariants>> = [];

  #parser: Parser<TProps> = (v: object) => ({ ...v }) as TProps;

  #stringRepr: StringRepr<TProps, TVariants, TSignals> = (v) => serializeDebug(v);

  #name: TName = "" as TName;

  name<TNewName extends string>(
    name: TNewName,
  ): StateBuilder<TProps, TVariants, TSignals, TNewName, TResults, TAsync, TDefs> {
    const self = this as unknown as StateBuilder<TProps, TVariants, TSignals, TNewName, TResults, TAsync, TDefs>;
    self.#name = name;
    return self;
  }

  /**
   * The signals the state takes, each keyed by its name: a variant's reducer keyed by a signal's name runs for it.
   * Optional: a state without signals has no signal reducers.
   */
  signals<TArgSignals>(
    signals: TArgSignals,
  ): StateBuilder<TProps, TVariants, TArgSignals, TName, TResults, TAsync, TDefs> {
    const self = this as unknown as StateBuilder<TProps, TVariants, TArgSignals, TName, TResults, TAsync, TDefs>;
    self.#signals = signals;
    return self;
  }

  /**
   * Adds a variant. `options.results` declares its named results; each data type is its parser's return type, so
   * a parser takes `unknown`. `options.async`, written as the literal `true`, marks it asynchronous in its type too,
   * so only an asynchronous variant's transition handlers compile.
   *
   * @throws StateFlowError when `options.initial` is set and another variant is initial already, or together with
   *   `options.transitional` or `options.async`: applyFlow commits the initial variant with no transition. Also when
   *   `options.transitional` and `options.async` are both set: a temp is entered synchronously, an asynchronous
   *   variant only as a transition's next.
   */
  variant<TVariant extends string, TVariantResults extends ResultTypes = NoResults, TIsAsync extends boolean = false>(
    variant: TVariant,
    options: VariantOptions<TVariantResults, TIsAsync> = {},
  ): StateBuilder<
    TProps,
    TVariants | TVariant,
    TSignals,
    TName,
    TResults & { [P in TVariant]: TVariantResults },
    // Brackets keep the check from distributing over `boolean`: only a literal true marks the variant, since a
    // boolean flag may be false when the code runs.
    TAsync | ([TIsAsync] extends [true] ? TVariant : never),
    TDefs
  > {
    const self = this as unknown as StateBuilder<
      TProps,
      TVariants | TVariant,
      TSignals,
      TName,
      TResults & { [P in TVariant]: TVariantResults },
      TAsync | ([TIsAsync] extends [true] ? TVariant : never),
      TDefs
    >;
    const isInitial = options.initial === true;
    const isTransitional = options.transitional === true;
    const isAsync = options.async === true;
    if (isInitial && self.#variants.some((spec) => spec.isInitial)) {
      throw new StateFlowError("SF085", "Only one initial state variant is allowed");
    }
    if (isInitial && isTransitional) {
      throw new StateFlowError("SF086", `${variant}: an initial variant cannot be transitional`);
    }
    if (isInitial && isAsync) {
      throw new StateFlowError("SF087", `${variant}: an initial variant cannot be asynchronous`);
    }
    if (isTransitional && isAsync) {
      throw new StateFlowError("SF088", `${variant}: a transitional variant cannot be asynchronous`);
    }
    self.#variants.push({ name: variant, isInitial, isTransitional, isAsync, results: options.results ?? {} });
    return self;
  }

  parser(func: (val: object) => TProps): this {
    this.#parser = func;
    return this;
  }

  stringRepr(func: (val: StateInstance<TProps, TVariants, TSignals>) => string): this {
    this.#stringRepr = func;
    return this;
  }

  /**
   * @throws StateFlowError when the state has no name or no variant, a variant is named "items" (the definition's
   *   own method), or a key of the signals is not the name of the signal listed under it: a reducer is keyed by the
   *   name of the signal it takes, so a reducer keyed by that key would never run.
   */
  build(): StateDefinition<TProps, TVariants, TSignals, TName, TResults, TAsync, TDefs> {
    // A state built without .signals() takes none; its reducers object stays empty.
    const signals = this.#signals ?? (Object.freeze({}) as TSignals);
    const name = this.#name;

    if (name === "") {
      throw new StateFlowError("SF089", "Name was not provided");
    }

    if (this.#variants.length === 0) {
      throw new StateFlowError("SF090", "No state variants are defined");
    }

    if (this.#variants.some((spec) => spec.name === "items")) {
      throw new StateFlowError(
        "SF091",
        `${name}: a variant cannot be named items, which is the definition's items() method`,
      );
    }

    for (const [key, signal] of Object.entries(signals as object)) {
      // A signal definition carries its name as its string tag; anything else listed here has none.
      const signalName: unknown = (signal as { [Symbol.toStringTag]?: unknown } | null)?.[Symbol.toStringTag];
      if (signalName !== key) {
        throw new StateFlowError(
          "SF092",
          `${name}: the signal ${String(signalName)} is listed under the key ${key}; a reducer keyed ${key} would never run`,
        );
      }
    }

    const def: StateDefinition<TProps, TVariants, TSignals, TName, TResults, TAsync> = ((snapshotOrCtx: unknown) =>
      extract(def, snapshotOrCtx)) as unknown as StateDefinition<TProps, TVariants, TSignals, TName, TResults, TAsync>;
    Object.assign(def, Object.fromEntries(this.#variants.map((spec) => this.buildFactories(def, spec))));

    Object.defineProperties(def, {
      [Symbol.toStringTag]: { value: this.#name, enumerable: false, configurable: false, writable: false },
      [Symbol.toPrimitive]: { value: () => this.#name, enumerable: false, configurable: false, writable: false },
      [SIGNALS]: { value: signals, enumerable: false, configurable: false, writable: false },
      [PARSER]: { value: this.#parser, enumerable: false, configurable: false, writable: false },
      [STRING_REPR]: { value: this.#stringRepr, enumerable: false, configurable: false, writable: false },
      // Not enumerable, so the definition's values are its variants only.
      items: {
        value: (options?: { key: (item: StateInstance<TProps, TVariants, TSignals>) => unknown }) =>
          emptyItems(def, options?.key),
        enumerable: false,
        configurable: false,
        writable: false,
      },
    });

    return Object.freeze(def);
  }

  private buildFactories(
    def: StateDefinition<TProps, TVariants, TSignals, TName, TResults, TAsync, TDefs>,
    { name: variant, isInitial, isTransitional, isAsync, results }: VariantSpec<TVariants>,
  ): [PropertyKey, StateVariant<TProps, TVariants, TSignals>] {
    const fn = Object.defineProperties(
      function stateFactory(props) {
        return factory<TProps, TVariants, TSignals>(fn, props);
      } as StateVariant<TProps, TVariants, TSignals>,
      {
        [Symbol.toStringTag]: { value: variant, enumerable: false, writable: false, configurable: false },
        [Symbol.toPrimitive]: {
          value: () => `${String(def)}.${String(variant)}`,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        [DEF]: { value: def, enumerable: false, writable: false, configurable: false },
        // Reducers are looked up by a signal's or a result's name; without a prototype, a name like toString or
        // constructor finds only a reducer defined under it, never an Object.prototype member.
        [SIGNAL_REDUCERS]: { value: Object.create(null), enumerable: false, writable: false, configurable: false },
        [RESULT_REDUCERS]: { value: Object.create(null), enumerable: false, writable: false, configurable: false },
        [IS_INITIAL]: { value: isInitial, enumerable: false, writable: false, configurable: false },
        [IS_TRANSITIONAL]: { value: isTransitional, enumerable: false, writable: false, configurable: false },
        [IS_ASYNC]: { value: isAsync, enumerable: false, writable: false, configurable: false },
        results: {
          value: Object.freeze(
            Object.fromEntries(
              Object.entries(results).map(([result, parse]) => [
                result,
                (data: unknown) => namedResult({ variant: fn, name: result, data: parse(data) }),
              ]),
            ),
          ),
          enumerable: false,
          writable: false,
          configurable: false,
        },
      },
    );

    return [variant, fn];
  }
}

/**
 * Defines a new state type with associated variants and properties.
 *
 * @returns StateBuilder instance for fluent configuration of the state
 *
 * @example
 * ```ts
 * const audioState = defineState<{volume: number}>()
 *   .name("audio")
 *   .signals(audioSignals)
 *   .variant("playing", { initial: true })
 *   .variant("paused")
 *   .stringRepr(s => `vol=${s.volume}`)
 *   .build();
 * ```
 */
/**
 * Starts a state definition: `defineState<Props>().name("audio").signals(signals).variant("muted").build()`. A second
 * type argument names the flow's definitions by state name (`defineState<Props, PlayerStates>()`, a type-only import),
 * so the state's reducers read siblings by name through `ctx.read` with full types and import no other definition.
 */
export function defineState<TProps, TDefs = any>(): StateBuilder<TProps, "", unknown, "", NoResults, never, TDefs> {
  return new StateBuilder<TProps, "", unknown, "", NoResults, never, TDefs>();
}

/**
 * What the definitions `states` are made of, as plain data a report or a table is built from (JSON.stringify writes
 * it as it is): per definition, in the caller's order, its name and the names of the signals it takes; per variant,
 * in the order of the definition's own keys, its name, its marks as `initial`, `transitional` and `async` (the
 * options of `variant()`), the signals it has a reducer for, in the order of the object given to defineFlow (none
 * before defineFlow, and none mapped to undefined there), and the named results it declares, in the order of their
 * object. The definition's keys are its variants as the engine itself walks them: in the order of the variant()
 * calls, except that names that are integers come first, as JavaScript orders an object's keys.
 *
 * It lists only the definitions it is given: a nested definition an instance may hold is listed only when the caller
 * names it too. It does not list transitions, which exist only as what a reducer returns, nor a variant's reducers
 * of other states' results.
 */
export function listStates(states: readonly AnyDefinition[]) {
  return states.map((def) => ({
    name: String(def),
    signals: Object.keys(def[SIGNALS] as object),
    variants: Object.entries(def).map(([name, variant]) => ({
      name,
      initial: variant[IS_INITIAL],
      transitional: variant[IS_TRANSITIONAL],
      async: variant[IS_ASYNC],
      signals: Object.keys(variant[SIGNAL_REDUCERS]),
      results: Object.keys(variant.results),
    })),
  }));
}

/** The names of an instance's variants, from its definition's type. */
type VariantNamesOf<I> = I extends StateInstance<any, infer V, any, any> ? Exclude<V & string, ""> : never;

/**
 * Whether `instance` is in one of the named variants: `isIn(ctx.read("driver"), "registering")`. The names are typed
 * by the instance's definition, so a reducer that read a sibling by name checks its variant with no definition import.
 */
export function isIn<I extends StateInstance<any, any, any, any>>(
  instance: I,
  ...names: Array<VariantNamesOf<I>>
): boolean {
  const variant = stateVar(instance)[Symbol.toStringTag];
  return (names as string[]).includes(variant);
}

/** The factories of a variant's named results, by result name. */
type ResultFactoriesOf<V> = V extends { readonly results: infer R } ? R : never;

/** The reducer of the FAILURE result for the variant `V`: it folds what led to a failure into props. */
type FailureReducer<V> = ResultReducer<Infer<V>, FailureData, DefsOf<V>>;

/** A reducer for every named result the variant declares, a missing one does not compile; one for FAILURE if the
 * variant takes it; and one for each other state's result it takes. */
type ResultReducers<V> = {
  readonly [K in keyof ResultFactoriesOf<V>]: ResultReducer<
    Infer<V>,
    ResultFactoriesOf<V>[K] extends (data: infer TData) => unknown ? TData : never,
    DefsOf<V>
  >;
} & { readonly [FAILURE]?: FailureReducer<V> } & OtherResultReducers<V>;

/**
 * What defineFlow takes after the variant, chosen by its definition: signal reducers when the state takes signals,
 * then result reducers, required when the variant declares named results, optional when it declares none. A variant
 * with neither signals nor named results defines FAILURE's reducer, and beside it any other state's result it takes.
 */
type FlowReducers<V> = 0 extends 1 & V
  ? // V is `any` (only `any` makes `1 & V` a type that 0 extends): it names no definition to choose by.
    unknown[]
  : [keyof ExtractSignals<V>] extends [never]
    ? [keyof ResultFactoriesOf<V>] extends [never]
      ? [results: { readonly [FAILURE]: FailureReducer<V> } & OtherResultReducers<V>]
      : [results: ResultReducers<V>]
    : [keyof ResultFactoriesOf<V>] extends [never]
      ? [signals: SignalReducers<Infer<V>, ExtractSignals<V>, DefsOf<V>>, results?: ResultReducers<V>]
      : [signals: SignalReducers<Infer<V>, ExtractSignals<V>, DefsOf<V>>, results: ResultReducers<V>];

/**
 * Defines the reducers of a variant, once. Signal reducers: for each signal its state takes, a pure function from the
 * instance the signal reaches to what it becomes (see {@link ReducerReturn}); they come first, and a state that takes
 * no signals has none. Result reducers: for each named result the variant declares, a pure function that folds the
 * result's data into the instance being entered or updated (see {@link ResultReducer}); they come after the signal
 * reducers, or alone, and every declared result needs one.
 *
 * A named result is a fact of the flow: a result reducer under a name the variant does not declare takes another
 * state's result of that name (see OtherResultReducers); one under a name the variant declares folds only the
 * variant's own result. When a handler returns one, its node folds it first; then, in the same step, every node of
 * another state whose variant has such a reducer of that name answers on the snapshot the step started from, and the
 * answers commit with the step, as a signal's do. A refusal among them refuses the step, an Ignored answers nothing,
 * and a transition or a failed is an Error. applyFlow throws when two definitions it sees declare results of one name.
 *
 * Any variant may also take the FAILURE result, without declaring it, with a result reducer keyed by that symbol. A
 * refused step, or the failure of a declared transition, takes nodes to the failed their reducers declared
 * (`StateResult.ok(next, failed)`, `StateResult.transition(next, temp, failed)`); every node that failed step enters or
 * updates, a nested state inside a failed included, gets `{ kind, reason, error, data }` folded in through that
 * reducer, in the same fold as the named results the update and enter handlers return and before them. `kind` is
 * `rejected`, `error`, `timeout` or `aborted` (see {@link FailureData}); `reason` is the failure's message for a
 * Rejected, its error's message for an Error; `data` is the record a handler gave with its Rejected, if it gave one. A
 * variant without that reducer folds nothing, and a node the failed step keeps as the same instance gets nothing.
 *
 * @param variant - State variant to define reducers for
 * @param reducers - The signal reducers, the result reducers, or both, as the variant's definition takes them
 * @throws StateFlowError if reducers are already defined for the state variant
 *
 * @example
 * ```ts
 * defineFlow(driver.active, {
 *   stop: (s) => driver.idle({ ...s, manifest: null }),
 * }, {
 *   loaded: (s, data) => ({ ...s, manifest: data.manifest }),
 * });
 * // a state without signals takes its result reducers as the second argument
 * defineFlow(transport.open, { opened: (t, data) => ({ ...t, socket: data.socket }) });
 * // the reason of a failure that took the driver to failed
 * defineFlow(driver.failed, { play }, { [FAILURE]: (s, { reason }) => ({ ...s, reason }) });
 * // another state that takes the driver's loaded result, in the step it folds in, with its data's type written out
 * const source = defineState<{ url: string | null }>()
 *   .name("source")
 *   .signals(driverSignals)
 *   .variant("known", { initial: true })
 *   .build();
 * defineFlow(source.known, {}, { loaded: (k, { manifest }: { manifest: Manifest }) => ({ ...k, url: manifest.url }) });
 * ```
 */
export function defineFlow<V extends AnyVariant>(variant: V, ...reducers: FlowReducers<V>): void {
  if (Object.isFrozen(variant[SIGNAL_REDUCERS])) {
    throw new StateFlowError("SF093", `Flow is already defined: ${String(variant)}`);
  }
  // The overload follows the definition, as the type does: a state that takes signals takes its signal reducers first.
  const takesSignals = Object.keys(variant[DEF][SIGNALS] as object).length > 0;
  const [signalReducers, resultReducers] = takesSignals ? reducers : [undefined, reducers[0]];
  // defineFlow takes undefined under a signal's name without a cast; it means no reducer, so it is not kept.
  Object.assign(
    variant[SIGNAL_REDUCERS],
    Object.fromEntries(Object.entries(signalReducers ?? {}).filter(([, reducer]) => reducer !== undefined)),
  );
  Object.freeze(variant[SIGNAL_REDUCERS]);
  Object.assign(variant[RESULT_REDUCERS], resultReducers);
  Object.freeze(variant[RESULT_REDUCERS]);
}
