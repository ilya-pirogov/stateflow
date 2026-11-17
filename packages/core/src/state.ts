/**
 * Contains tools for defining states
 *
 * @example ```ts
 *
 * const audio = defineState<{volume: number}>("audio")
 *   .signals(signals)
 *   .variant("unmuted")
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
 *   unmute: (s) => Result.reject("not allowed"),
 *   mute: (s) => Result.reject("not allowed"),
 *   userInteraction: (s) => s.volume > 0 ? audio.unMuted(s) : audio.muted(s);
 * });
 *
 * ```
 */

import { runInReducer } from "./reducer-scope";
import { Result } from "./result";
import { sealProps } from "./seal-props";
import type { Signal, SignalHandler, SignalHandlers } from "./signal";
import { DEF, HANDLERS, IS_INITIAL, PARSER, SIGNALS, STRING_REPR, VARIANT } from "./symbols";
import { type Infer, StateFlowError, serializeDebug } from "./utils";

//#region Helper Types

export type ExtractVariants<T> =
  T extends StateDefinition<any, infer TVariants, any, any>
    ? TVariants
    : T extends StateVariant<any, infer TVariants, any, any>
      ? TVariants
      : never;

export type ExtractSignals<T> =
  T extends StateDefinition<any, "", infer TSignals, any>
    ? TSignals
    : T extends StateVariant<any, "", infer TSignals, any>
      ? TSignals
      : never;

export type ExtractName<T> =
  T extends StateDefinition<infer _TProps, infer _TVariants, infer _TSignals, infer TName>
    ? [TName] extends [""]
      ? never
      : TName
    : T extends StateVariant<infer _TProps, infer _TVariants, infer _TSignals, infer TName>
      ? [TName] extends [""]
        ? never
        : TName
      : never;

export type ArrayToRecord<T extends readonly unknown[]> = {
  [K in T[number] as ExtractName<K>]: Readonly<Infer<K>>;
};

export type StateResult<TProps> = TProps | StateInstance<TProps> | Result;

type Parser<T> = (val: object) => T;

type StringRepr<TProps, TVariants extends PropertyKey, TSignals> = (
  val: StateInstance<TProps, TVariants, TSignals>,
) => string;

//#endregion

//#region State Types

/**
 * Represents a state type. Contains all possible
 * state values as a hashmap
 */
export type StateDefinition<
  TProps = any,
  TVariants extends PropertyKey = string,
  TSignals = unknown,
  TName extends string = "",
> = {
  (x: unknown): StateInstance<TProps>;
  readonly [Symbol.toStringTag]: TName;
  readonly [SIGNALS]: TSignals;
  readonly [PARSER]: Parser<TProps>;
  readonly [STRING_REPR]: StringRepr<TProps, TVariants, TSignals>;
} & {
  readonly [K in TVariants]: StateVariant<TProps, TVariants, TSignals>;
};

/**
 * Represents one of possible value for the state
 * Can be constructed by calling it as a function
 */
export type StateVariant<
  TProps = any,
  TVariants extends PropertyKey = string,
  TSignals = unknown,
  TName extends string = "",
> = {
  readonly [Symbol.toStringTag]: string;
  readonly [DEF]: StateDefinition<TProps, "", TSignals, TName>;
  readonly [HANDLERS]: SignalHandlers<TProps, TSignals>;
  readonly [IS_INITIAL]: boolean;

  (props: TProps): StateInstance<TProps, TVariants, TSignals>;
};

/**
 * Represents an instance of specific state.
 * Contains all required props.
 */
export type StateInstance<
  TProps = unknown,
  TVariants extends PropertyKey = string,
  TSignals = unknown,
  TName extends string = "",
> = {
  readonly [Symbol.toStringTag]: string;
  readonly [VARIANT]: StateVariant<TProps, TVariants, TSignals, TName>;
} & {
  readonly [K in keyof TProps]: TProps[K];
};

//#endregion

//#region Helper Functions

export function isState(state: unknown): state is StateInstance {
  return typeof state === "object" && state != null && VARIANT in state;
}

export function isStateDef(obj: unknown): obj is StateDefinition {
  return obj != null && typeof obj === "function" && SIGNALS in obj;
}

function isStateInstance<TProps, TVariants extends PropertyKey, TSignals>(
  obj: unknown,
  name: string,
): obj is StateInstance<TProps, TVariants, TSignals> {
  if (obj == null || typeof obj !== "object" || !(VARIANT in obj) || !(Symbol.toStringTag in obj)) {
    return false;
  }
  return String(obj[Symbol.toStringTag]).startsWith(name);
}

/**
 * Returns true if the group accepts the signal.
 */
export function stateAccepts<TProps, TSignals>(
  state: StateInstance<TProps, string, TSignals>,
  signalName: PropertyKey,
): signalName is keyof TSignals {
  return signalName in state[VARIANT][HANDLERS];
}

export function stateVar<T>(obj: StateInstance<T> | T): StateVariant<T> {
  if (obj == null || typeof obj !== "object" || !(VARIANT in obj)) {
    throw new StateFlowError("Not a state");
  }

  return obj[VARIANT] as StateVariant<T>;
}

export function getInitialState<TProps>(def: StateDefinition<TProps>): StateVariant<TProps> {
  const svar = Object.values(def).find((x) => x[IS_INITIAL]);
  if (svar == null) {
    throw new StateFlowError("Initial state variant not found");
  }
  return svar;
}

export function getName<T extends StateDefinition>(def: T): ExtractName<T> {
  return def[Symbol.toStringTag] as ExtractName<T>;
}

//#endregion

/**
 * Builds a new immutable state instance
 *
 * @param value
 * @param props
 */
function factory<TProps, TVariants extends PropertyKey, TSignals>(
  value: StateVariant<TProps, TVariants, TSignals>,
  props: TProps | StateInstance<TProps, TVariants, TSignals>,
): StateInstance<TProps, TVariants, TSignals> {
  const name = String(value);
  const inst = value[DEF][PARSER](props as object) as StateInstance<TProps, TVariants, TSignals>;

  sealProps(inst); // deep-freeze plain data / accept immutable-value-like / skip Boxes / verdict on live instances

  Object.defineProperties(inst, {
    [Symbol.toStringTag]: { value: name, writable: false, configurable: false, enumerable: false },
    [Symbol.toPrimitive]: {
      value: () => `${name}(${value[DEF][STRING_REPR](inst)})`,
      writable: false,
      configurable: false,
      enumerable: false,
    },
    [VARIANT]: { value, writable: false, configurable: false, enumerable: false },
  });

  return Object.freeze(inst);
}

function extract<TProps, TVariants extends PropertyKey, TSignals>(
  name: string,
  ctx: unknown,
): StateInstance<TProps, TVariants, TSignals> {
  if (ctx == null || typeof ctx !== "object" || !(name in ctx)) {
    throw new StateFlowError("State Flow object not found");
  }
  const state = Reflect.get(ctx, name);
  if (!isStateInstance<TProps, TVariants, TSignals>(state, name)) {
    throw new StateFlowError(`State not found: ${name}`);
  }

  return state;
}

class StateBuilder<TProps, TVariants extends PropertyKey, TSignals, TName extends string> {
  #signals?: TSignals;

  readonly #variants: Array<[TVariants, boolean]> = [];

  #parser: Parser<TProps> = (v: object) => ({ ...v }) as TProps;

  #stringRepr: StringRepr<TProps, TVariants, TSignals> = (v) => serializeDebug(v);

  #name: TName = "" as TName;

  name<TNewName extends string>(name: TNewName): StateBuilder<TProps, TVariants, TSignals, TNewName> {
    const self = this as unknown as StateBuilder<TProps, TVariants, TSignals, TNewName>;
    self.#name = name;
    return self;
  }

  signals<TArgSignals>(signals: TArgSignals): StateBuilder<TProps, TVariants, TArgSignals, TName> {
    const self = this as unknown as StateBuilder<TProps, TVariants, TArgSignals, TName>;
    self.#signals = signals;
    return self;
  }

  variant<TVariant extends PropertyKey>(
    variant: TVariant,
    isInitial = false,
  ): StateBuilder<TProps, TVariants | TVariant, TSignals, TName> {
    const self = this as StateBuilder<TProps, TVariants | TVariant, TSignals, TName>;
    if (isInitial && self.#variants.some(([_, i]) => i)) {
      throw new StateFlowError("Only one initial state variant is allowed");
    }
    self.#variants.push([variant, isInitial]);
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

  build(): StateDefinition<TProps, TVariants, TSignals, TName> {
    const signals = this.#signals;
    const name = this.#name;
    if (signals == null) {
      throw new StateFlowError("Signals were not provided");
    }

    if (name === "") {
      throw new StateFlowError("Name was not provided");
    }

    if (this.#variants.length === 0) {
      throw new StateFlowError("No state variants are defined");
    }

    const def = extract.bind(null, name) as unknown as StateDefinition<TProps, TVariants, TSignals, TName>;
    Object.assign(def, Object.fromEntries(this.#variants.map(([v, i]) => this.buildFactories(def, v, i))));

    Object.defineProperties(def, {
      [Symbol.toStringTag]: { value: this.#name, enumerable: false, configurable: false, writable: false },
      [Symbol.toPrimitive]: { value: () => this.#name, enumerable: false, configurable: false, writable: false },
      [SIGNALS]: { value: signals, enumerable: false, configurable: false, writable: false },
      [PARSER]: { value: this.#parser, enumerable: false, configurable: false, writable: false },
      [STRING_REPR]: { value: this.#stringRepr, enumerable: false, configurable: false, writable: false },
    });

    return Object.freeze(def);
  }

  private buildFactories(
    def: StateDefinition<TProps, TVariants, TSignals, TName>,
    variant: TVariants,
    isInitial: boolean,
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
        [HANDLERS]: { value: {}, enumerable: false, writable: false, configurable: false },
        [IS_INITIAL]: { value: isInitial, enumerable: false, writable: false, configurable: false },
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
 *   .variant("playing", true)
 *   .variant("paused")
 *   .stringRepr(s => `vol=${s.volume}`)
 *   .build();
 * ```
 */
export function defineState<TProps>(): StateBuilder<TProps, "", unknown, ""> {
  return new StateBuilder<TProps, "", unknown, "">();
}

/**
 * Configures state transition handlers for a specific state variant.
 *
 * @param state - State variant to define handlers for
 * @param handlers - Object mapping signal names to handler functions
 * @throws StateFlowError if handlers are already defined for the state variant
 *
 * @example
 * ```ts
 * defineFlow(audioState.playing, {
 *   pause: (state) => audioState.paused(state),
 *   volume: (state, args) => audioState.playing({ ...state, volume: args.volume })
 * });
 * ```
 */
export function defineFlow<TVariant extends StateVariant<any, any, any>>(
  state: TVariant,
  handlers: SignalHandlers<Infer<TVariant>, ExtractSignals<TVariant>>,
): void {
  if (Object.isFrozen(state[HANDLERS])) {
    throw new StateFlowError(`Flow is already defined: ${String(state)}`);
  }
  Object.assign(state[HANDLERS], handlers);
  Object.freeze(state[HANDLERS]);
}

/**
 * Handles the signal in current state.
 */
export function handleSignal<TProps, TState extends StateInstance<TProps, string, TSignals>, TSignals>(
  state: TState,
  signal: Signal<TProps>,
  ctx: object,
): Result<TState> {
  const signalName = signal[Symbol.toStringTag];
  if (!stateAccepts(state, signalName)) {
    return Result.ignore("");
  }

  const handler = state[VARIANT][HANDLERS][signalName] as SignalHandler<TProps>;

  try {
    const result = runInReducer(() => handler(state, signal, ctx));
    if (result instanceof Result) {
      return result as Result<TState>;
    }

    if (isState(result)) {
      return Result.state(result) as Result<TState>;
    }

    return Result.state(state[VARIANT](result) as any);
  } catch (err) {
    return Result.error(err);
  }
}
