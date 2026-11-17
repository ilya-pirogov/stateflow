/**
 * Signals: what a caller sends to a flow's target, and what its reducers take.
 *
 * @example ```ts
 *   const signals = {
 *     mute: defineSignal("mute"),
 *     unmute: defineSignal("unmute"),
 *     volume: defineSignal<{ volume: number }>("volume"),
 *   };
 *
 *   await using send = await lock(target);
 *   // the result at once: OK, Ignored, Rejected or Error, or InTransition while a declared transition runs
 *   const res1 = send(signals.unmute());
 *   // the outcome, after a declared transition's end
 *   const res2 = await send(signals.volume({ volume: 0.7 })).done();
 * ```
 */

import type { InstanceOf, ReducerReturn, StateInstance } from "./state";
import { SIGNAL } from "./symbols";
import { type Infer, serializeDebug } from "./utils";

export interface StateSignal {
  [SIGNAL]: true;
  [Symbol.toStringTag]: string;
}

export type Signal<TArgs = unknown> = StateSignal & TArgs;

/**
 * What defineSignal returns: the factory of the signal, named by its toStringTag, which takes the payload `TArgs` when
 * the signal has one and nothing otherwise. The check wraps `TArgs` in a one-element tuple so that it does not
 * distribute over a union: a union payload gives one factory that takes any member of the union, where a bare
 * `TArgs extends ...` would give a union of factories, one per member, which no argument can call.
 */
export type SignalDefinition<TArgs = void> = [TArgs] extends [Record<string, unknown>]
  ? { [Symbol.toStringTag]: string } & ((props: TArgs) => StateSignal & TArgs)
  : { [Symbol.toStringTag]: string } & (() => StateSignal);

/**
 * Creates a new signal definition that can trigger state transitions.
 *
 * @param name - The signal's name: a variant's reducer keyed by it runs for the signal
 * @param stringRepr - The payload's string form in a signal's own string form, `name{payload}`; serializeDebug by
 *   default
 * @returns Function to create signal instances, optionally with parameters
 *
 * @example
 * ```ts
 * const signals = {
 *   play: defineSignal("play"),
 *   seek: defineSignal<{time: number}>("seek"),
 *   volume: defineSignal<{level: number}>("volume")
 * };
 * ```
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` is the intended "no payload" marker for parameterless signals.
export function defineSignal<TArgs extends Record<string, unknown> | void = void>(
  name: string,
  stringRepr = (args: TArgs) => serializeDebug(args),
): SignalDefinition<TArgs> {
  const fn = (p?: Record<string, unknown>) => {
    return Object.freeze({
      ...p,
      [SIGNAL]: true,
      [Symbol.toStringTag]: name,
      [Symbol.toPrimitive]: () => `${name}{${stringRepr(p as TArgs)}}`,
    });
  };
  Reflect.defineProperty(fn, Symbol.toStringTag, {
    value: name,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return fn as unknown as SignalDefinition<TArgs>;
}

/**
 * A reducer's third argument. A top-level state's definition called on it reads that state in the snapshot the
 * reducer runs on: `power(ctx).on`. A signal reducer runs on the snapshot from before the signal; a result reducer that
 * folds its own node's result on the step's target as folded so far, and one that takes another state's result on the
 * snapshot the step started from. A nested state reads its parent through `parent`. It is frozen, so a write to it
 * fails: in strict-mode code, which modules and classes are, it throws, and the throw is the reducer's Error.
 */
export interface ReducerContext<TDefs = any> {
  /** The parent's instance in the reducer's snapshot; undefined at the top level. */
  readonly parent: StateInstance | undefined;
  /** This state's key in its parent's Items; undefined at the top level and for a single nested state. */
  readonly key: unknown;
  /**
   * Another top-level state of the flow in the reducer's snapshot, by its name: `ctx.read("driver")`. Typed by the
   * flow's definitions when the state declares them (`defineState<Props, PlayerStates>()`), so a state module reads a
   * sibling with no import of its definition; `isIn(instance, "variant")` then checks the variant by name.
   * @throws StateFlowError when the flow has no state of that name
   */
  read<K extends keyof TDefs & string>(name: K): 0 extends 1 & TDefs ? StateInstance : InstanceOf<TDefs[K]>;
}

/** A signal reducer: what `state`, the instance the signal reaches (typed as its props), becomes. */
export type SignalReducer<TProps = unknown, TArgs = unknown, TDefs = any> = (
  state: TProps,
  signal: TArgs,
  ctx: ReducerContext<TDefs>,
) => ReducerReturn<TProps>;

export type SignalReducers<TProps, TSignals, TDefs = any> = Partial<{
  readonly [K in keyof TSignals]: SignalReducer<TProps, Infer<TSignals[K]>, TDefs>;
}>;
