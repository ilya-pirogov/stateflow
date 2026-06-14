export const SIGNAL = Symbol.for("SIGNAL");
export const DEF = Symbol.for("DEF");
export const IS_INITIAL = Symbol.for("IS_INITIAL");
export const VARIANT = Symbol.for("VARIANT");
export const SIGNALS = Symbol.for("SIGNALS");
export const HANDLERS = Symbol.for("HANDLERS");
export const STRING_REPR = Symbol.for("STRING_REPR");
export const PARSER = Symbol.for("PARSER");

// small polyfill
if (typeof Symbol.dispose === "undefined") {
  Object.defineProperty(Symbol, "dispose", { value: Symbol.for("dispose") });
}

if (typeof Symbol.asyncDispose === "undefined") {
  Object.defineProperty(Symbol, "asyncDispose", { value: Symbol.for("asyncDispose") });
}
