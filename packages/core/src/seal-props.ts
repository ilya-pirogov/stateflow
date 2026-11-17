import { FrozenMap, FrozenSet, isItems } from "./collections";
import { isState } from "./state";
import { isImmutableValueLike, isPlainObject, StateFlowError } from "./utils";

/** Refuses a live value found in a prop's data: a raw Set or Map, or an unfrozen instance of any other class. */
function refuseLiveInstance(key: string, value: object): never {
  const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
  throw new StateFlowError(
    "SF078",
    `State prop \`${key}\` holds a non-plain class instance \`${name}\`; ` +
      "wrap live resources in `Box(...)` or expose frozen plain data.",
  );
}

/**
 * Refuses a state instance or an Items found inside a prop's data. A nested state is an instance or an Items held
 * directly in a prop, where the engine diffs it and runs its handlers; inside an array, an object, a FrozenMap or a
 * FrozenSet it would be data whose handlers never run.
 */
function refuseNestedState(key: string, value: object): never {
  throw new StateFlowError(
    "SF079",
    `State prop \`${key}\` holds ${String(value)} inside its data; ` +
      "a nested state goes directly in a prop, as an instance or in Items (def.items()).",
  );
}

/**
 * The walk over data a caller froze: it only looks for nested states, freezing and judging nothing, because frozen
 * data is trusted as immutable. It goes into arrays, plain objects, FrozenMap keys and values and FrozenSet
 * elements; never into a Box, whose content is a live resource, nor into any other frozen object.
 */
function checkFrozenValue(key: string, v: unknown, seen: WeakSet<object>): void {
  if (v === null || typeof v !== "object" || seen.has(v)) {
    return;
  }
  if (isState(v) || isItems(v)) {
    refuseNestedState(key, v);
  }
  seen.add(v);
  if (v instanceof FrozenMap) {
    for (const [k, item] of v) {
      checkFrozenValue(key, k, seen);
      checkFrozenValue(key, item, seen);
    }
  } else if (v instanceof FrozenSet) {
    for (const item of v) {
      checkFrozenValue(key, item, seen);
    }
  } else if (Array.isArray(v) || isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      checkFrozenValue(key, (v as Record<string, unknown>)[k], seen);
    }
  }
}

function freezeValue(key: string, v: unknown, seen: WeakSet<object>): void {
  if (v === null || typeof v !== "object") {
    return; // primitive
  }
  // A value that is ALREADY frozen — a Box (frozen in its own constructor), a FrozenSet/FrozenMap (ditto), a
  // state instance or an Items, or a shared frozen default reused by-reference across many state constructions —
  // is trusted as immutable: no freeze and no refusal, only the walk that refuses a nested state inside it.
  if (Object.isFrozen(v)) {
    checkFrozenValue(key, v, seen);
    return;
  }
  if (seen.has(v)) {
    return; // cycle guard
  }
  // Plain objects/arrays are the overwhelmingly common case for state props, so they are checked
  // FIRST (Array.isArray before the pricier isPlainObject, which walks the prototype chain):
  // `isImmutableValueLike` below costs prototype look-ups that would otherwise run on every one of
  // them for nothing (the "large nested POD" case of state.bench.ts measures it).
  if (Array.isArray(v) || isPlainObject(v)) {
    seen.add(v);
    for (const k of Object.keys(v)) {
      freezeValue(key, (v as Record<string, unknown>)[k], seen);
    }
    Object.freeze(v);
    return;
  }
  if (isImmutableValueLike(v)) {
    Object.freeze(v); // Error/RegExp/URL/Event — not already frozen, ruled out above
    return;
  }
  refuseLiveInstance(key, v);
}

/**
 * Seals a freshly-parsed state instance's own enumerable prop VALUES. Called from `factory()`
 * AFTER the parser and BEFORE the top-level `Object.freeze(inst)`. Does NOT freeze `inst` itself.
 * A prop that holds a state instance or an Items directly holds nested states, built and sealed
 * already; anywhere deeper in a prop's data, frozen or not, one is refused.
 * INVARIANT (enforced by discipline, documented here): anything entering a flat prop must be
 * transitively OWNED by the state — the owning reducer must clone a by-reference caller object
 * (structuredClone / parse-through-schema) before it enters props, or this freeze will lock the
 * caller's live object.
 */
export function sealProps(inst: object): void {
  const seen = new WeakSet<object>();
  for (const key of Object.keys(inst)) {
    const value = (inst as Record<string, unknown>)[key];
    if (!isState(value) && !isItems(value)) {
      freezeValue(key, value, seen);
    }
  }
}
