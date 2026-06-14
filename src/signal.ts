/**
 * Contains types and interfaces for the signal system.
 *
 * @example ```ts
 *   const signals = {
 *     mute: defineSignal("mute"),
 *     unmute: defineSignal("unmute"),
 *     volume: defineSignal<{volume: number}>("volume"),
 *   };
 *
 *   // ...
 *
 *   // immediate result
 *   const res1 = dispatch(target, signals.unmute());
 *
 *   // or if you need to await transition
 *   const res2 = await dispatch(target, signals.volume({volume: 0.7})).done();
 * ```
 */

import type { StateResult } from "./state";
import { SIGNAL } from "./symbols";
import { type Infer, serializeDebug } from "./utils";

export interface StateSignal {
  [SIGNAL]: true;
  [Symbol.toStringTag]: string;
}

export type Signal<TArgs = unknown> = StateSignal & TArgs;

export type SignalDefinition<TArgs = void> =
  TArgs extends Record<string, unknown>
    ? { [Symbol.toStringTag]: string } & ((props: TArgs) => StateSignal & TArgs)
    : { [Symbol.toStringTag]: string } & (() => StateSignal);

/**
 * Creates a new signal definition that can trigger state transitions.
 *
 * @param name - Identifier for the signal
 * @param stringRepr
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
    // console.groupCollapsed(`[dispatch:] ${name}{${stringRepr(p as TArgs)}}`);
    // console.trace(name);
    // console.groupEnd();
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

export type SignalHandler<TProps = unknown, TArgs = unknown> = (
  state: TProps,
  signal: TArgs,
  ctx: unknown,
) => StateResult<TProps>;

export type SignalHandlers<TProps, TSignals> = Partial<{
  readonly [K in keyof TSignals]: SignalHandler<TProps, Infer<TSignals[K]>>;
}>;
