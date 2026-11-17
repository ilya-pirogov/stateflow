/**
 * The collections a state prop holds. Items: the nested states a prop holds by key, an immutable map of one
 * definition's instances or a set keyed by each element, built with `def.items()` or `def.items({ key })`; the engine
 * finds an Items in a prop by its ITEMS brand, as it finds a Box, and diffs it entry by entry. FrozenSet and FrozenMap:
 * immutable data collections, a native Set or Map whose mutators throw.
 *
 * @example
 * ```ts
 * const producers = producer.items({ key: (p) => p.id }).with(producer.active({ id: "cam", track }));
 * const cams = producer.items().with("cam", producer.active({ id: "cam", track }));
 * cams.without("cam").size; // 0
 * ```
 */
import { type AnyDefinition, type InstanceOf, isState } from "./state";
import { DEF, ITEMS, VARIANT } from "./symbols";
import { StateFlowError } from "./utils";

/** The function a keyed set files each element under. */
type KeyFunction<TDef, K> = (item: InstanceOf<TDef>) => K;

// The engine's operations on Items. They are assigned in the class's static block, the one place that reaches its
// private constructor and fields, and are no members of it, so user code sets an Items only through with() and
// without(). index.ts exports only definitionOf, which reads.

/** An empty map of `def`'s instances, or with `key` an empty keyed set: what `def.items()` returns. */
export let emptyItems: <TDef, K>(def: AnyDefinition, key: KeyFunction<TDef, K> | undefined) => Items<TDef, K>;

/**
 * A new map or set with `item` under `key`, which `items` holds already, at the same place. The engine puts a
 * changed nested state back where it was with it; it runs no key function, because the key was checked where a
 * reducer built the element.
 */
export let replaceItem: <TDef, K>(items: Items<TDef, K>, key: K, item: InstanceOf<TDef>) => Items<TDef, K>;

/** The key function of a keyed set, undefined for a map; the engine checks a reducer's new element with it. */
export let keyFunctionOf: <TDef, K>(items: Items<TDef, K>) => KeyFunction<TDef, K> | undefined;

/** The definition whose instances an Items holds, also when it is empty: applyFlow reads the definitions a flow starts
 * with from it, and a tool that writes an Items as data names it by it, so an empty one can be built again. */
export let definitionOf: (items: Items<unknown, unknown>) => AnyDefinition;

/** A key as a path name or an Items' string form prints it: String(key), or "(no string form)" for a key String()
 * throws on (an object with no prototype, a revoked Proxy), so printing a key never throws. */
export function keyString(key: unknown): string {
  try {
    return String(key);
  } catch {
    return "(no string form)";
  }
}

/** An immutable map of nested instances of one definition, or a set keyed by each element. Reads as a ReadonlyMap
 * in insertion order. */
export class Items<TDef, K = string> implements ReadonlyMap<K, InstanceOf<TDef>> {
  readonly #def: AnyDefinition;
  // Set only on a keyed set: the function whose result `with(item)` files an element under.
  readonly #keyOf: KeyFunction<TDef, K> | undefined;
  readonly #map: ReadonlyMap<K, InstanceOf<TDef>>;

  private constructor(
    def: AnyDefinition,
    key: KeyFunction<TDef, K> | undefined,
    map: ReadonlyMap<K, InstanceOf<TDef>>,
  ) {
    this.#def = def;
    this.#keyOf = key;
    this.#map = map;
    Object.defineProperty(this, ITEMS, { value: true, enumerable: false });
    Object.freeze(this);
  }

  // Assigns the engine's operations declared above this class.
  static {
    emptyItems = (def, key) => new Items(def, key, new Map());
    replaceItem = (items, key, item) => new Items(items.#def, items.#keyOf, new Map(items.#map).set(key, item));
    keyFunctionOf = (items) => items.#keyOf;
    definitionOf = (items) => items.#def;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): InstanceOf<TDef> | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<InstanceOf<TDef>> {
    return this.#map.values();
  }

  entries(): MapIterator<[K, InstanceOf<TDef>]> {
    return this.#map.entries();
  }

  forEach(
    cb: (value: InstanceOf<TDef>, key: K, map: ReadonlyMap<K, InstanceOf<TDef>>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#map) {
      cb.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[K, InstanceOf<TDef>]> {
    return this.#map.entries();
  }

  /**
   * A map: a new map with `item` under `key`, at the key's place when it is taken, else last.
   * @throws StateFlowError on a keyed set, which takes `with(item)`, or when `item` is not an instance of this
   *   map's definition.
   */
  with(key: K, item: InstanceOf<TDef>): Items<TDef, K>;
  /**
   * A keyed set: a new set with `item` under its key, at the key's place when it is taken, else last.
   * @throws StateFlowError on a map, which takes `with(key, item)`, or when `item` is not an instance of this
   *   set's definition.
   */
  with(item: InstanceOf<TDef>): Items<TDef, K>;
  with(...args: [K, InstanceOf<TDef>] | [InstanceOf<TDef>]): Items<TDef, K> {
    const keyOf = this.#keyOf;
    if (keyOf === undefined && args.length !== 2) {
      throw new StateFlowError("SF002", `Items of ${String(this.#def)}: a map takes with(key, item)`);
    }
    if (keyOf !== undefined && args.length !== 1) {
      throw new StateFlowError(
        "SF003",
        `Items of ${String(this.#def)}: a keyed set takes with(item) and keys it itself`,
      );
    }
    const item = args.length === 2 ? args[1] : args[0];
    // Checked before the key function runs: it is written for this definition's instances. A variant's DEF is
    // typed without the definition's props and variants, so it is compared as unknown.
    const owner: unknown = isState(item) ? item[VARIANT][DEF] : undefined;
    if (owner !== this.#def) {
      throw new StateFlowError("SF004", `Items of ${String(this.#def)} take its instances only, not ${String(item)}`);
    }
    const key = keyOf === undefined ? (args[0] as K) : keyOf(item);
    return new Items(this.#def, keyOf, new Map(this.#map).set(key, item));
  }

  /** A new map or set without `key`. */
  without(key: K): Items<TDef, K> {
    const map = new Map(this.#map);
    map.delete(key);
    return new Items(this.#def, this.#keyOf, map);
  }

  /** `Items(2){cam=producer.active(...) mic=producer.creating(...)}`. */
  [Symbol.toPrimitive](): string {
    const entries = [...this.#map].map(([key, item]) => `${keyString(key)}=${String(item)}`);
    return `Items(${this.#map.size}){${entries.join(" ")}}`;
  }
}

/** Narrows `v` to an {@link Items}. */
export function isItems(v: unknown): v is Items<unknown, unknown> {
  return v !== null && typeof v === "object" && Reflect.has(v, ITEMS);
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
 *   .name("tagged")
 *   .variant("active", { initial: true })
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
    Object.freeze(this);
  }

  /**
   * @throws StateFlowError Always; `FrozenSet` is immutable.
   */
  add(_value: T): this {
    throw new StateFlowError("SF005", "FrozenSet is immutable; build a new FrozenSet instead of mutating.");
  }

  /**
   * @throws StateFlowError Always; `FrozenSet` is immutable.
   */
  delete(_value: T): boolean {
    throw new StateFlowError("SF005", "FrozenSet is immutable; build a new FrozenSet instead of mutating.");
  }

  /**
   * @throws StateFlowError Always; `FrozenSet` is immutable.
   */
  clear(): void {
    throw new StateFlowError("SF005", "FrozenSet is immutable; build a new FrozenSet instead of mutating.");
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
 * Use `FrozenMap` directly in a state prop to hold immutable key-value collections of data.
 * Construction populates the map; all mutations throw. Read operations (`get`, `has`,
 * `size`, iteration) work as in native `Map`. Nested states go in an `Items` (`def.items()`):
 * a state instance inside a FrozenMap is refused when the instance holding it is built.
 *
 * @example
 * ```ts
 * const state = defineState<{ config: FrozenMap<string, number> }>()
 *   .name("configured")
 *   .variant("idle", { initial: true })
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
    Object.freeze(this);
  }

  /**
   * @throws StateFlowError Always; `FrozenMap` is immutable.
   */
  set(_key: K, _value: V): this {
    throw new StateFlowError("SF006", "FrozenMap is immutable; build a new FrozenMap instead of mutating.");
  }

  /**
   * @throws StateFlowError Always; `FrozenMap` is immutable.
   */
  delete(_key: K): boolean {
    throw new StateFlowError("SF006", "FrozenMap is immutable; build a new FrozenMap instead of mutating.");
  }

  /**
   * @throws StateFlowError Always; `FrozenMap` is immutable.
   */
  clear(): void {
    throw new StateFlowError("SF006", "FrozenMap is immutable; build a new FrozenMap instead of mutating.");
  }
}
