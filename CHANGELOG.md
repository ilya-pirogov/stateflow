# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `Box` / `isBox` — an opaque, owned handle for live resources (MediaStream, sockets, DOM
  elements) that must live in state without being deep-frozen. `Box.deref()` returns the
  wrapped reference in effect/observer scope and **throws inside a reducer**; `equals`
  compares by identity; the wrapper serializes as `Box(<name>#<id>)`.
- `FrozenSet` / `FrozenMap` — immutable, throw-on-mutate collections usable directly in state
  props (e.g. `capacities: FrozenSet<string>`).
- **Flat-state enforcement** — every constructed state now deep-freezes its plain-data props
  (nested objects/arrays included), not just the top-level container. `Box`es are skipped
  (their interior stays live); a raw live class instance in a prop is dev-warned.
- **Reducer-access rule** — dispatching from inside a reducer now throws a `StateFlowError`
  (reducers are pure — no side effects, no dispatch).

### Fixed

- `Infer` / `ExtractName` — corrected an over-narrow type constraint that made
  `Infer<typeof builtState>` resolve to `never` (and broke multi-state `applyFlow` with
  strongly-typed targets). Both now wildcard-infer, so `Infer` recovers the real props from a
  built `StateDefinition`/`StateVariant` and `ExtractName` recovers the real state name. The
  `SignalDefinition` branch (`Infer<typeof someSignal>`) is unchanged.

## [1.1.0] - 2026-07-01

### Added

- `subscribeFlow(target, subscriber)` — observation-only per-flow subscription
  delivering `FlowChange` (with real prev/next state instances) once per changed
  state, post-commit and isolated. Exposes `FlowChange` and `FlowSubscriber` types.

## [1.0.1] - 2026-06-16

### Fixed

- Export the `StateDefinition` and `StateInstance` types from the public entry
  point. They were already part of the public surface by inference —
  `defineState().build()` returns a `StateDefinition`, and the exported
  `StateResult` / `StateVariant` reference `StateInstance` — but were not
  nameable, so consumers re-exporting those results in their own `.d.ts` hit
  TypeScript's TS2883 portability error. Exposing them by name repairs the
  declaration surface. No runtime or behavioral change.

## [1.0.0] - 2026-06-13

### Added

- Initial public release of **StateFlow** — type-safe, immutable state
  management built on signals, flows, and frozen state snapshots.
- Public API: `defineSignal`, `defineState`, `defineFlow`, `applyFlow`,
  `lock` / `send`, `observe`, `dispatch` (deprecated escape hatch), `sync`,
  `disposeFlow`, and `StateManager`.
- `Result` / `ResultKind` / `ResultCollector` for explicit, type-safe
  transition outcomes (`ok` / `ignore` / `reject` / `error` / `transition` /
  `enqueue`).
- Logging utilities: `addGlobalLogHandler`, `consoleLogHandler`,
  `setConsoleLogSilenced`, `setGlobalDispatchContextProvider`, and the
  `StateFlowLogEntry` / `StateFlowLogHandler` types.
- Helpers and types: `Infer`, `StateFlowError`, `serializeDebug`, `isState`,
  `stateVar`, and the public symbols `PARSER`, `SIGNALS`, `STRING_REPR`,
  `VARIANT`.

[Unreleased]: https://github.com/ilya-pirogov/stateflow/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ilya-pirogov/stateflow/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/ilya-pirogov/stateflow/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ilya-pirogov/stateflow/releases/tag/v1.0.0
