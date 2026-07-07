import { isBox } from "./box";
import { isImmutableValueLike, isPlainObject, StateFlowError } from "./utils";

function verdict(key: string, value: object): void {
  const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
  const msg =
    `State prop \`${key}\` holds a non-plain class instance \`${name}\`; ` +
    "wrap live resources in `Box(...)` or expose frozen plain data.";
  throw new StateFlowError(msg);
}

function freezeValue(key: string, v: unknown, seen: WeakSet<object>): void {
  if (v === null || typeof v !== "object") {
    return; // primitive
  }
  // Perf mitigation (spec §8): a value that is ALREADY frozen — a Box (frozen in its own
  // constructor), a FrozenSet/FrozenMap (ditto), or a shared frozen default reused
  // by-reference across many state constructions — needs no further walk at all. One native
  // check short-circuits the whole subtree in O(1).
  if (Object.isFrozen(v)) {
    return;
  }
  if (seen.has(v)) {
    return; // cycle guard
  }
  // Plain objects/arrays are the overwhelmingly common case for state props, so check that
  // FIRST (Array.isArray before the pricier isPlainObject, which walks the prototype chain) —
  // `isBox`/`isImmutableValueLike` below cost extra property/prototype look-ups that would
  // otherwise run on every one of them for no reason (measured ~40% construction-bench
  // regression on deeply-nested state before this reorder).
  if (Array.isArray(v) || isPlainObject(v)) {
    seen.add(v);
    for (const k of Object.keys(v)) {
      freezeValue(k, (v as Record<string, unknown>)[k], seen);
    }
    Object.freeze(v);
    return;
  }
  // Box always self-freezes in its constructor, so in practice this is caught by the
  // `Object.isFrozen` check above; kept as a defensive, documented fallback rather than a
  // hard dependency on that internal invariant.
  if (isBox(v)) {
    return; // opaque live handle — never freeze contents
  }
  if (isImmutableValueLike(v)) {
    Object.freeze(v); // Error/RegExp/URL/Event — not already frozen, ruled out above
    return;
  }
  // raw Set/Map OR unfrozen non-plain class instance — the enforcement verdict.
  verdict(key, v);
}

/**
 * Seals a freshly-parsed state instance's own enumerable prop VALUES. Called from `factory()`
 * AFTER the parser and BEFORE the top-level `Object.freeze(inst)`. Does NOT freeze `inst` itself.
 * INVARIANT (enforced by discipline, documented here): anything entering a flat prop must be
 * transitively OWNED by the state — the owning reducer must clone a by-reference caller object
 * (structuredClone / parse-through-schema) before it enters props, or this freeze will lock the
 * caller's live object.
 */
export function sealProps(inst: object): void {
  const seen = new WeakSet<object>();
  for (const key of Object.keys(inst)) {
    freezeValue(key, (inst as Record<string, unknown>)[key], seen);
  }
}
