# StateFlow

Type-safe, immutable state management for TypeScript, built on **signals**, **flows**, and frozen **state snapshots**.

[![npm version](https://img.shields.io/npm/v/@state-flow/core.svg)](https://www.npmjs.com/package/@state-flow/core)
[![CI](https://github.com/ilya-pirogov/stateflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ilya-pirogov/stateflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

StateFlow models your application state as a set of explicit, named variants and the
transitions between them. Every change goes through a **signal**, every transition is
described by a pure **flow** function, and every state instance is a frozen, immutable
snapshot. The result is state logic that is predictable, traceable, and fully type-checked
end to end.

## Why StateFlow

- **Signals are the only path to change.** State can never be mutated directly — you
  dispatch a typed signal and the flow decides what happens. Every change is tracked.
- **Deeply-immutable snapshots.** State instances are deep-frozen on construction — nested
  objects and arrays included, not just the top level. Live resources that can't be frozen
  (a `MediaStream`, a socket) are held in an opaque `Box` and skipped by the freeze.
- **Flat state + `Box`.** Every state prop is either deep-frozen value data or an opaque
  `Box` handle. `Box.deref()` reads the live resource in effects/observers but throws
  inside a pure reducer. `FrozenSet`/`FrozenMap` hold set/map-shaped data immutably.
- **Pure, synchronous transitions.** `defineFlow` handlers are synchronous and return a
  new state or a `Result` (`ok` / `ignore` / `reject` / `error`) — the right place to
  validate input. Side effects and async work live in `applyFlow` handlers via
  `Result.transition`.
- **First-class type safety.** Signals, state variants, and flow handlers are all inferred
  and checked. Illegal transitions are compile errors, not runtime surprises.
- **Tiny footprint.** No framework lock-in; the only runtime dependency is `events`.

## Installation

```bash
npm install @state-flow/core
# or
yarn add @state-flow/core
# or
pnpm add @state-flow/core
```

**Requirements.** The published package is downleveled to ES2020 and ships a `Symbol.dispose` /
`Symbol.asyncDispose` polyfill, so it runs on Node.js 18+ and modern browsers with no special
runtime support. The examples below use `await using` (explicit resource management) for
ergonomic cleanup — that syntax is optional and requires TypeScript 5.2+ with an ES2022+
target. You can always dispose manually instead (e.g. `observer[Symbol.dispose]()`).

## Quick start

```typescript
import {
  defineSignal,
  defineState,
  defineFlow,
  applyFlow,
  lock,
  observe,
  Result,
  ResultKind,
  type Infer,
} from "@state-flow/core";

// 1. Signals — the only way to request a state change.
const signals = {
  play: defineSignal("play"),
  pause: defineSignal("pause"),
  seek: defineSignal<{ position: number }>("seek"),
};

// 2. State — immutable, frozen snapshots with named variants.
const playback = defineState<{ position: number; duration: number }>()
  .name("playback")
  .signals(signals)
  .variant("paused", true) // the initial variant
  .variant("playing")
  .stringRepr((s) => `pos=${s.position}/${s.duration}`)
  .build();

// 3. Flow — how each variant responds to signals (must be synchronous).
defineFlow(playback.paused, {
  play: (state) => playback.playing(state),
  seek: (state, signal) => {
    if (signal.position < 0 || signal.position > state.duration) {
      return Result.reject("Invalid seek position");
    }
    return { ...state, position: signal.position };
  },
});

defineFlow(playback.playing, {
  pause: (state) => playback.paused(state),
});

// 4. Bind the flow to an object and register side-effect handlers.
type Player = { playback: Infer<typeof playback> };
const player: Player = { playback: { position: 0, duration: 180 } };

applyFlow(player, [playback], (sm) => {
  sm.addEnterHandler(playback.playing, () => Result.ok());
});

// 5. Observe state changes (the only thing mutable after setup).
const observer = observe(
  player,
  [playback.playing, playback.paused],
  (state) => console.log("playback ->", String(state)),
);

// 6. Drive it: acquire a lock, then send signals — queued and type-safe.
async function main() {
  await using send = await lock(player);
  await send(signals.play()).expect(ResultKind.OK, ResultKind.Ignored).done();
  await send(signals.seek({ position: 30 })).done();

  observer[Symbol.dispose]();
}

main();
```

For a full walkthrough — including asynchronous transitions, observers, result merging,
testing, and architecture — see the [documentation](#documentation).

## Core concepts

| Concept | What it is |
| --- | --- |
| **Signal** | A typed message that requests a state change. Created with `defineSignal`. |
| **State** | An immutable definition with one or more named variants. Created with `defineState`. |
| **Flow** | The synchronous mapping from a variant + signal to a new state or `Result`. Created with `defineFlow`. |
| **Result** | The outcome of a transition: `ok`, `ignore`, `reject`, `error`, or an async `transition`. |
| **`applyFlow`** | Binds state definitions to a target object and registers enter/update/exit/rollback handlers. |
| **`lock` / `send`** | Acquire an async-disposable lock, then dispatch signals so they queue safely instead of throwing during an active transition. |
| **`observe`** | Subscribe to variant changes for UI updates and side effects. |
| **`subscribeFlow`** | Observation-only subscription to every state change on a flow (post-commit, one macrotask per change); receives the real, frozen prev/next state instances — cannot dispatch, enqueue, or mutate state. |
| **`Box` / `isBox`** | An opaque, owned handle for a live resource in state — deref in effects/observers (throws in reducers), compare by identity. |
| **`FrozenSet` / `FrozenMap`** | Immutable, throw-on-mutate collections for set/map-shaped state props. |

## Documentation

Full documentation lives at **[stateflow.dev](https://stateflow.dev)** — core concepts, the
signal system, state consistency and visibility, the API reference, a complete media-player
example, testing, and the architecture guide.

The site's source is in [`docs/`](./docs) (a Next.js app). To run it locally:

```bash
cd docs
yarn install
yarn dev
```

## Development

```bash
npm install      # install dependencies
npm test         # run the test suite (vitest)
npm run build    # bundle (tsup) + emit type declarations (tsc)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © Ilya Pirogov
