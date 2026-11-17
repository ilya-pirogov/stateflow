import { isInReducer } from "./reducer-scope";
import { BOX } from "./symbols";
import { StateFlowError } from "./utils";

/** Options for {@link Box.of}. */
export interface BoxOptions {
  /** Human display name; overrides `value.constructor.displayName` / `value.constructor.name`. */
  displayName?: string;
}

let boxCounter = 0;

const SANITIZE = /[\s{}[\]=]+/g;
const NAME_CAP = 20;

function sanitize(s: string, cap: number): string {
  const cleaned = s.replace(SANITIZE, "_");
  return cleaned.length > cap ? cleaned.slice(0, cap) : cleaned;
}

function resolveDisplayName(value: unknown, opts?: BoxOptions): string {
  if (opts?.displayName != null) {
    return opts.displayName;
  }
  const ctor =
    value == null ? undefined : (value as { constructor?: { displayName?: string; name?: string } }).constructor;
  if (ctor?.displayName != null) {
    return ctor.displayName;
  }
  if (ctor?.name != null && ctor.name !== "") {
    return ctor.name;
  }
  return "Box";
}

/**
 * An opaque, owned handle to a live resource (MediaStream, CallAPI, DOM element, socket, …).
 *
 * Its interior is intentionally NOT frozen. Reducers may create/place a `Box` but MUST NOT read
 * it — {@link Box.deref} throws inside a reducer. Compare boxes with {@link Box.equals} (pure
 * identity), never `===` on the wrapper itself — re-wrapping the same value with `Box.of` mints
 * a new wrapper instance.
 *
 * @example
 * ```ts
 * const camera = Box.of(mediaStream);
 * // ... later, from a handler (enter, exit, update, commit), a declared transition's work, or an observer:
 * const stream = camera.deref(); // legal outside a reducer
 * stream.getTracks().forEach((t) => t.stop());
 * ```
 */
export class Box<T> {
  readonly #value: T;
  readonly #n: number;
  readonly #displayName: string;

  // Protected for DisposableBox; any other Box is made by Box.of.
  protected constructor(value: T, opts?: BoxOptions) {
    this.#value = value;
    this.#n = boxCounter++;
    this.#displayName = resolveDisplayName(value, opts);
    Object.defineProperty(this, BOX, { value: true, enumerable: false }); // brand — NEVER VARIANT
    Object.freeze(this);
  }

  /**
   * Wraps `value` in a new opaque `Box`.
   *
   * @param value - The live resource to own.
   * @param opts - Optional display-name override.
   */
  static of<T>(value: T, opts?: BoxOptions): Box<T> {
    return new Box(value, opts);
  }

  get [Symbol.toStringTag](): string {
    return "Box";
  }

  /**
   * Returns the boxed value.
   *
   * @remarks
   * Opaque owned handle. Reducers must not read live resources, so this THROWS a
   * `StateFlowError` when called inside a reducer — read it from an enter, exit, update or commit
   * handler, a declared transition's work, or an observer instead. It behaves the same while
   * `setHandlersDisabled` is on: the switch stops handlers, and a deref is not one.
   * @throws {StateFlowError} When called synchronously inside a reducer.
   */
  deref(): T {
    if (isInReducer()) {
      throw new StateFlowError(
        "SF001",
        "Cannot deref a Box inside a reducer; read it in a handler (enter, exit, update, transition or commit) or an observer.",
      );
    }
    return this.#value;
  }

  /**
   * True when `other` is a Box wrapping the same value (reference identity). Safe in ANY scope; never reads contents.
   *
   * @param other - The value to compare against; anything but a Box gives false.
   */
  equals(other: unknown): boolean {
    return other instanceof Box && this.#value === other.#value;
  }

  /** A stable, per-instance identifier (e.g. `"Box#3"`). */
  get id(): string {
    return `Box#${this.#n}`;
  }

  /** The resolved display name (`opts.displayName` → `value.constructor.displayName` → `value.constructor.name` → `"Box"`). */
  get displayName(): string {
    return this.#displayName;
  }

  [Symbol.toPrimitive](): string {
    return `Box(${sanitize(this.#displayName, NAME_CAP)}#${this.#n})`;
  }
}

/** Narrows `v` to a {@link Box}. */
export function isBox(v: unknown): v is Box<unknown> {
  return v !== null && typeof v === "object" && Reflect.has(v, BOX);
}

/**
 * How many DisposableBoxes were made. While none was, no state or result can hold one, so the engine skips its
 * DisposableBox checks and scans, which every dispatch would otherwise pay for.
 */
export let madeDisposableBoxes = 0;

/**
 * A {@link Box} of a value that has `Symbol.dispose` or `Symbol.asyncDispose`, which the engine owns once the flow has
 * it: what the committed states do not hold is disposed. Otherwise it is a Box: a reducer may place it, `deref`
 * follows the same rules, and isBox is true.
 *
 * A box's place is an own enumerable string-keyed prop of a node, a top-level or a nested state's instance, read
 * through its descriptor, so no getter runs; a symbol-keyed prop, and an array or an object in a prop, hold none. Two
 * boxes are one when {@link Box.equals} says so, so a value wrapped anew is the same box.
 *
 * Before any handler runs, a dispatch is refused, with an Error that names the places, when a face it may commit
 * (next, a failed, a declared transition's temp, its next and its failed end) holds one box in two places or a box the
 * engine disposed already, and when a declared transition's temp drops a box the committed states hold while its next
 * or its failed end holds it again: the temp's commit would dispose it. A step other than a step into failed is
 * refused the same way before its commit when the named results of its handlers, a transition's work's at its end,
 * fold in and other states take them, and that leaves one box in two places or places a disposed one. A transition's
 * end is checked so even with nothing to fold, since its next stands on the temp as it committed: a box the temp step's
 * fold dropped, which the temp's commit disposed, may stand in next again.
 *
 * After every step, the engine disposes each box the step carried that no node of the committed states holds after it:
 * the boxes of the instances the step replaced, of every instance it planned, even one a named result then folded
 * over, and of the named results its handlers returned, as their data or in their data's props, at a transition's end
 * its work's too. So a box moved to another node, into a nested state or to another key of an Items stays. After a
 * commit this runs once the step's commit delegates and commit handlers ran. A refused step's boxes go with those of
 * the step into failed after it, so a box the failed commits stays: once that step's commit delegates and commit
 * handlers ran, or at once when it changes nothing. When a declared transition does not reach its next, the boxes of
 * that next as the reducer built it are disposed too, unless a node holds them: with the boxes of the step into failed
 * when the temp step or the end step is refused, and otherwise when the transition ends with no commit of its work's
 * results (a work refused, their fold or another state's answer failed, the timeout, an accepted abort, disposeFlow),
 * with the boxes those results carry, a result that settles later included: its transition handler listens for
 * nothing. disposeFlow disposes every box the final states hold.
 *
 * The engine disposes a value once, through `Symbol.dispose`, or else `Symbol.asyncDispose`, not awaited. A throw or a
 * rejection goes to console.error. Disposal runs whether setHandlersDisabled is on or not.
 *
 * @example
 * ```ts
 * // The old connection is closed once a step commits the new one, the new one when its step does not commit.
 * sm.addEnterHandler(link.up, (s) => link.up.results.connected({ conn: DisposableBox.of(openConnection(s.url)) }));
 * ```
 */
export class DisposableBox<T> extends Box<T> {
  /**
   * Wraps `value`, which has `Symbol.dispose` or `Symbol.asyncDispose`, in a new DisposableBox.
   *
   * @param value - The live resource to own.
   * @param opts - Optional display-name override.
   */
  // The value's type is an intersection, not a constraint on T: a subclass's static of must accept what Box.of does.
  static of<T>(value: T & (Disposable | AsyncDisposable), opts?: BoxOptions): DisposableBox<T> {
    madeDisposableBoxes += 1;
    return new DisposableBox(value, opts);
  }
}
