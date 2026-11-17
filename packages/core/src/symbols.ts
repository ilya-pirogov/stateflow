export const SIGNAL = Symbol.for("SIGNAL");
export const DEF = Symbol.for("DEF");
export const IS_INITIAL = Symbol.for("IS_INITIAL");
/** On a variant: whether it is transitional, committed only as the temp of a declared transition. */
export const IS_TRANSITIONAL = Symbol.for("IS_TRANSITIONAL");
/** On a variant: whether its entry is asynchronous, so a node enters it only as the next of a declared transition,
 * whose work is the variant's transition handlers. */
export const IS_ASYNC = Symbol.for("IS_ASYNC");
export const VARIANT = Symbol.for("VARIANT");
export const SIGNALS = Symbol.for("SIGNALS");
/** On a variant: its signal reducers, set once by defineFlow. */
export const SIGNAL_REDUCERS = Symbol.for("SIGNAL_REDUCERS");
/** On a variant: its result reducers, set once by defineFlow, which fold its named results into an entered or updated
 * instance, FAILURE into a failed one, and take other states' named results of their names. */
export const RESULT_REDUCERS = Symbol.for("RESULT_REDUCERS");
/**
 * The key of the result reducer by which a variant takes what led to a failure. A refused step, or the failure of a
 * declared transition, takes nodes to the failed their reducers declared; the engine folds `{ kind, reason, error }`
 * (see FailureData in state.ts) into every node that failed step enters or updates, through this reducer of its
 * variant, if it has one. A symbol, so no result a variant declares by name can be taken for it; and not one from the
 * global registry, so no symbol user code makes, `Symbol.for("FAILURE")` included, can be either.
 */
export const FAILURE = Symbol("FAILURE");
/**
 * Type-only: the key of the optional member that carries a variant's id ("<state>.<variant>") in the types of the
 * variant and of the named results its factories build, so a handler of one variant cannot return another's. No
 * object holds it at run time.
 */
export const VARIANT_ID = Symbol.for("VARIANT_ID");
/** On an Items: its brand, by which the engine finds the nested states a prop holds by key. */
export const ITEMS = Symbol.for("ITEMS");
/** On a reducer's ctx: the frozen snapshot the reducer reads, so a definition called on ctx reads that snapshot. */
export const SNAPSHOT = Symbol.for("SNAPSHOT");
export const STRING_REPR = Symbol.for("STRING_REPR");
export const PARSER = Symbol.for("PARSER");
export const BOX = Symbol.for("BOX");

// small polyfill
if (typeof Symbol.dispose === "undefined") {
  Object.defineProperty(Symbol, "dispose", { value: Symbol.for("dispose") });
}

if (typeof Symbol.asyncDispose === "undefined") {
  Object.defineProperty(Symbol, "asyncDispose", { value: Symbol.for("asyncDispose") });
}
