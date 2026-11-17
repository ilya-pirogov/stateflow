import { FROZEN } from "./symbols";
import { StateFlowError } from "./utils";

function brandAndFreeze(target: object): void {
  Object.defineProperty(target, FROZEN, { value: true, enumerable: false });
  Object.freeze(target);
}

/**
 * Immutable `Set`. Extends native `Set` so it renders via `serializeValue`'s `instanceof Set`
 * branch and inherits `has`/`size`/iteration. Mutators throw; set algebra is implemented
 * manually (ES2023 lib has no `Set.prototype.intersection`) and returns a plain, mutable `Set`.
 *
 * @remarks
 * Use `FrozenSet` directly in a state prop to hold immutable collections. Construction
 * populates the set efficiently; all mutations throw. Read operations (`has`, `size`,
 * iteration) work as in native `Set`. Set algebra (`intersection`, `symmetricDifference`)
 * returns plain `Set` instances for further manipulation.
 *
 * @example
 * ```ts
 * const state = defineState<{ tags: FrozenSet<string> }>()
 *   .variant("active", true)
 *   .build();
 * const inst = state.active({ tags: new FrozenSet(["a", "b"]) });
 * inst.tags.has("a"); // true
 * inst.tags.add("c"); // throws StateFlowError
 * ```
 */
export class FrozenSet<T> extends Set<T> {
  constructor(iterable?: Iterable<T> | null) {
    // MUST be empty: `new Set(iterable)` calls THIS class's overridden throwing `add`.
    super();
    if (iterable != null) {
      for (const v of iterable) {
        Set.prototype.add.call(this, v);
      }
    }
    brandAndFreeze(this);
  }

  /**
   * @throws StateFlowError Always; `FrozenSet` is immutable.
   */
  add(_value: T): this {
    throw new StateFlowError("FrozenSet is immutable; build a new FrozenSet instead of mutating.");
  }

  /**
   * @throws StateFlowError Always; `FrozenSet` is immutable.
   */
  delete(_value: T): boolean {
    throw new StateFlowError("FrozenSet is immutable; build a new FrozenSet instead of mutating.");
  }

  /**
   * @throws StateFlowError Always; `FrozenSet` is immutable.
   */
  clear(): void {
    throw new StateFlowError("FrozenSet is immutable; build a new FrozenSet instead of mutating.");
  }

  /**
   * Returns a plain `Set` containing only elements present in both this set and the other.
   */
  intersection(other: Iterable<T>): Set<T> {
    const o = other instanceof Set ? other : new Set(other);
    const out = new Set<T>();
    for (const v of this) {
      if (o.has(v)) {
        out.add(v);
      }
    }
    return out;
  }

  /**
   * Returns a plain `Set` containing elements that are in this set XOR the other,
   * but not in both.
   */
  symmetricDifference(other: Iterable<T>): Set<T> {
    const o = other instanceof Set ? other : new Set(other);
    const out = new Set<T>();
    for (const v of this) {
      if (!o.has(v)) {
        out.add(v);
      }
    }
    for (const v of o) {
      if (!this.has(v)) {
        out.add(v);
      }
    }
    return out;
  }
}

/**
 * Immutable `Map`. Extends native `Map` (renders via `serializeValue`'s `instanceof Map` branch;
 * inherits `get`/`has`/`size`/iteration). Mutators throw.
 *
 * @remarks
 * Use `FrozenMap` directly in a state prop to hold immutable key-value collections.
 * Construction populates the map; all mutations throw. Read operations (`get`, `has`,
 * `size`, iteration) work as in native `Map`.
 *
 * @example
 * ```ts
 * const state = defineState<{ config: FrozenMap<string, number> }>()
 *   .variant("idle", true)
 *   .build();
 * const inst = state.idle({ config: new FrozenMap([["timeout", 5000]]) });
 * inst.config.get("timeout"); // 5000
 * inst.config.set("retry", 3); // throws StateFlowError
 * ```
 */
export class FrozenMap<K, V> extends Map<K, V> {
  constructor(iterable?: Iterable<readonly [K, V]> | null) {
    super();
    if (iterable != null) {
      for (const [k, v] of iterable) {
        Map.prototype.set.call(this, k, v);
      }
    }
    brandAndFreeze(this);
  }

  /**
   * @throws StateFlowError Always; `FrozenMap` is immutable.
   */
  set(_key: K, _value: V): this {
    throw new StateFlowError("FrozenMap is immutable; build a new FrozenMap instead of mutating.");
  }

  /**
   * @throws StateFlowError Always; `FrozenMap` is immutable.
   */
  delete(_key: K): boolean {
    throw new StateFlowError("FrozenMap is immutable; build a new FrozenMap instead of mutating.");
  }

  /**
   * @throws StateFlowError Always; `FrozenMap` is immutable.
   */
  clear(): void {
    throw new StateFlowError("FrozenMap is immutable; build a new FrozenMap instead of mutating.");
  }
}
