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
 * // ... later, from an enter/exit/update handler or an observer:
 * const stream = camera.deref(); // legal outside a reducer
 * stream.getTracks().forEach((t) => t.stop());
 * ```
 */
export class Box<T> {
  readonly #value: T;
  readonly #n: number;
  readonly #displayName: string;

  private constructor(value: T, opts?: BoxOptions) {
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
   * `StateFlowError` when called inside a reducer — read it from an enter/exit/update handler
   * or an observer instead.
   * @throws {StateFlowError} When called synchronously inside a reducer.
   */
  deref(): T {
    if (isInReducer()) {
      throw new StateFlowError(
        "Cannot deref a Box inside a reducer; read it in an enter/exit/update handler or observer.",
      );
    }
    return this.#value;
  }

  /**
   * Reference-identity equality against another value. Safe in ANY scope; never reads contents.
   *
   * @param other - The value to compare against.
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
