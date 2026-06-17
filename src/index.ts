import packageJson from "./package-json";

// `dispatch` is a deprecated escape hatch — prefer `lock()` + `send()`. It stays exported
// only for synchronous teardown / pre-lock bootstrap (see its JSDoc); all other code should
// acquire a lock so signals queue instead of throwing under a held lock / active transition.
export { applyFlow, DispatchFn, dispatch, disposeFlow, lock, observe, StateManager, sync } from "./flow";
export {
  addGlobalLogHandler,
  consoleLogHandler,
  StateFlowLogEntry,
  StateFlowLogHandler,
  setConsoleLogSilenced,
  setGlobalDispatchContextProvider,
} from "./logger";
export { Result, ResultCollector, ResultKind } from "./result";
export { defineSignal, Signal, StateSignal } from "./signal";
export {
  defineFlow,
  defineState,
  isState,
  StateDefinition,
  StateInstance,
  StateResult,
  StateVariant,
  stateVar,
} from "./state";
export { PARSER, SIGNALS, STRING_REPR, VARIANT } from "./symbols";
export { Infer, StateFlowError, serializeDebug } from "./utils";

declare global {
  // eslint-disable-next-line no-var
  var __STATE_FLOW__: { version: string };
}

// Exposes the running version on the global object so it can be inspected from the
// browser/node console without importing the package — e.g. `globalThis.__STATE_FLOW__.version`.
globalThis.__STATE_FLOW__ ??= {
  version: `${packageJson.version} (${packageJson.branch} <${packageJson.commit}>)`,
};
