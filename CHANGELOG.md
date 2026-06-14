# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ilya-pirogov/stateflow/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ilya-pirogov/stateflow/releases/tag/v1.0.0
