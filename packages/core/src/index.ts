import packageJson from "./package-json";

export { Box, BoxOptions, DisposableBox, isBox } from "./box";
export { definitionOf, FrozenMap, FrozenSet, Items } from "./collections";

// `dispatch` is a deprecated escape hatch — prefer `lock()` + `send()`. It stays exported
// only for synchronous teardown / pre-lock bootstrap (see its JSDoc); all other code should
// acquire a lock so signals queue instead of throwing under a held lock / active transition.
export {
  addFlowTap,
  applyFlow,
  DispatchFn,
  DispatchOptions,
  dispatch,
  disposeFlow,
  FlowChange,
  FlowConfig,
  FlowSubscriber,
  FlowTap,
  FlowTapStep,
  listHandlers,
  lock,
  observe,
  settled,
  subscribeFlow,
  sync,
  watch,
} from "./flow";
export {
  ChangePredicate,
  CommitHandler,
  EnterHandler,
  HandlerMocks,
  mockHandlers,
  StateHandler,
  StateManager,
  setHandlersDisabled,
  TransitionHandler,
  UpdateHandler,
} from "./handlers";
export {
  addGlobalLogHandler,
  consoleLogHandler,
  StateFlowLogEntry,
  StateFlowLogHandler,
  setConsoleLogSilenced,
  setGlobalDispatchContextProvider,
} from "./logger";
export {
  HandlerResult,
  Result,
  ResultCollector,
  ResultKind,
  StateResult,
  TransitionOptions,
} from "./result";
// StateSignal is part of an exported type (Signal is `StateSignal & TArgs`): exported so a consumer can name it in its
// own declarations.
export { defineSignal, ReducerContext, Signal, StateSignal } from "./signal";
export {
  defineFlow,
  defineState,
  FailureData,
  FlowSnapshot,
  InstanceOf,
  isIn,
  isState,
  isVariant,
  listStates,
  ReducerReturn,
  StateDefinition,
  StateInstance,
  StateVariant,
  stateVar,
} from "./state";
// PARSER and STRING_REPR key members of an exported type (StateDefinition): exported so a consumer can name them in
// its own declarations.
export { FAILURE, PARSER, SIGNALS, STRING_REPR, VARIANT } from "./symbols";
export { Infer, StateFlowError, serializeDebug, TransitionAborted } from "./utils";

declare global {
  // eslint-disable-next-line no-var
  var __STATE_FLOW__: { version: string };
}

// Exposes the running version on the global object so it can be inspected from the
// browser/node console without importing the package — e.g. `globalThis.__STATE_FLOW__.version`.
globalThis.__STATE_FLOW__ ??= {
  version: `${packageJson.version} (${packageJson.branch} <${packageJson.commit}>)`,
};
