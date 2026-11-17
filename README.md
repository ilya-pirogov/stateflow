# StateFlow

Type-safe, immutable state management for TypeScript, built on **signals**, **flows**, and frozen **state snapshots**.

[![npm version](https://img.shields.io/npm/v/@state-flow/core.svg)](https://www.npmjs.com/package/@state-flow/core)
[![CI](https://github.com/ilya-pirogov/stateflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ilya-pirogov/stateflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

StateFlow models application state as explicit, named variants. Every change is a **signal**, the pure reducers of
a **flow** decide where the state goes, handlers apply that decision to the world, and every state instance is a
frozen snapshot.

## Why StateFlow

- **Signals are the only path to change.** Each is sent under the target's lock, and its result says whether it
  committed, was ignored, was rejected or failed.
- **Reducers decide, handlers apply.** Reducers are pure and synchronous: they return new props, a new instance or a
  `StateResult`, and name where the state goes when entering fails (`failed`). Every side effect lives in a handler
  attached to a variant (enter, exit, update, transition or commit), and a handler never chooses the next state. The
  world's data reaches props only as a handler's named result.
- **Waiting for the world is declared.** `StateResult.transition(next, temp, failed)` enters a variant marked
  `{ async: true }`: temp commits at once, the transition handlers do the work with one `AbortSignal`, then next or
  failed commits. One declared transition per dispatch.
- **No leak from a refused step.** An enter or update handler gets the step's `AbortSignal`, which aborts when the
  step does not commit, and a handler's result carries commit delegates (`onCommit`) that run only once it commits.
- **Deeply immutable snapshots.** Instances are deep-frozen. A live resource sits in an opaque `Box`, whose `deref()`
  throws inside a reducer, or in a `DisposableBox`, which the engine disposes once the state drops it.
- **Observation that cannot break a commit.** Observers, events of the flow, watches and subscribers are told after
  the commit, and `settled()` waits until they all ran.
- **Simulation built in.** With every handler switched off (`setHandlersDisabled`), a flow runs with no handler's
  effect; `mockHandlers` supplies the world's answers in a test.
- **Type safety end to end.** Payloads, reducer keys, named results, sibling reads by name (`ctx.read`, `isIn`) and
  the variants `observe` watches are checked at compile time.
- **Small.** No framework lock-in; the only runtime dependency is `events`.

## Installation

```bash
npm install @state-flow/core
# or
yarn add @state-flow/core
# or
pnpm add @state-flow/core
```

**Requirements.** The types need **TypeScript 5.6+**: the handler adders use `NoInfer` (5.4), and `Items` returns
`MapIterator` (5.6). The package is built for ES2022 and polyfills `Symbol.dispose` and `Symbol.asyncDispose`, so it
runs on Node.js 18+ and current browsers. The examples use `await using`, which needs the `ESNext.Disposable` lib;
disposing by hand works as well (`observer[Symbol.dispose]()`).

## Quick start

```typescript
import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  FAILURE,
  HandlerResult,
  lock,
  observe,
  ResultKind,
  StateResult,
  type Infer,
} from "@state-flow/core";

// 1. Signals: the only way to request a state change.
const signals = {
  play: defineSignal("play"),
  pause: defineSignal("pause"),
  seek: defineSignal<{ position: number }>("seek"),
};

// 2. State: frozen snapshots with named variants.
const playback = defineState<{ position: number; duration: number; reason: string | null }>()
  .name("playback")
  .signals(signals)
  .variant("paused", { initial: true }) // the variant it starts in
  .variant("starting", { transitional: true }) // held only while play is pending
  .variant("playing", { async: true }) // entered only at the end of a transition, after its work
  .stringRepr((s) => `pos=${s.position}/${s.duration}`)
  .build();

type Playback = Infer<typeof playback>;

// 3. Flow: how each variant responds to signals, pure and synchronous.
const seek = (state: Playback, signal: { position: number }) =>
  signal.position < 0 || signal.position > state.duration
    ? StateResult.rejected("invalid seek position")
    : { ...state, position: signal.position };

defineFlow(
  playback.paused,
  {
    // An entry that waits for the world names all three ends: starting commits at once, then playing, or back to
    // paused when the work fails.
    play: (state) =>
      StateResult.transition(
        playback.playing({ ...state, reason: null }),
        playback.starting(state),
        playback.paused(state),
      ),
    seek,
  },
  // Why the work failed reaches paused through the built-in FAILURE result.
  { [FAILURE]: (state, { reason }) => ({ ...state, reason: reason ?? null }) },
);

defineFlow(playback.playing, {
  pause: (state) => playback.paused(state),
  seek,
});

// 4. Put the flow on an object and register its handlers: every side effect lives in one.
const player: { playback: Playback } = { playback: { position: 0, duration: 180, reason: null } };
const video = document.querySelector("video") as HTMLVideoElement;

applyFlow(player, [playback], (sm) => {
  // The work of the transition into playing. Its AbortSignal aborts whenever the work's result will not commit,
  // and the handler then releases what it started.
  sm.addTransitionHandler(playback.playing, async (next, snapshot, prev, key, signal) => {
    signal.addEventListener("abort", () => video.pause(), { once: true });
    await video.play();
    signal.throwIfAborted();
    return HandlerResult.ok();
  });
  sm.addEnterHandler(playback.paused, () => {
    video.pause();
    return HandlerResult.ok();
  });
});

// 5. Observe committed states.
const observer = observe(player, [playback.playing, playback.paused], (state) => console.log(`playback -> ${state}`));

// 6. Drive it: take the lock, then send signals, queued and type-safe.
async function main() {
  await using send = await lock(player);
  const played = await send(signals.play()).done(); // resolves once playing or paused commits
  if (played.kind !== ResultKind.OK) {
    console.warn("play refused:", player.playback.reason);
  }
  await send(signals.seek({ position: 30 })).done();

  observer[Symbol.dispose]();
}

main();
```

The [documentation](#documentation) covers the rest: nested states, events and watches, commit delegates and
`DisposableBox`, result merging, testing, and architecture.

## Core concepts

| Concept | What it is |
| --- | --- |
| **Signal** | A typed command that requests a state change, made with `defineSignal`. A union payload gives one factory. |
| **State** | An immutable definition with named variants, made with `defineState`; `.variant(name, { initial, transitional, async, results })`. `defineState<Props, Defs>()` names the flow's definitions for `ctx.read`. |
| **Flow** | The pure, synchronous reducers of a variant, made with `defineFlow`: from a signal to new props, a new instance or a `StateResult`. A reducer runs for the signal whose name is its key, and reads other states by name with `ctx.read` and `isIn`. |
| **`StateResult` / `HandlerResult`** | What a reducer returns (`ok`, `transition`, `ignored`, `rejected`, `error`) and what a handler returns (`ok`, `ignored`, `rejected`, `error`, or a named result). `send()` returns a `Result`. |
| **Declared transition** | `StateResult.transition(next, temp, failed, options?)`: temp commits at once, the transition handlers of the asynchronous variants the end enters do the work with one `AbortSignal`, then next or failed commits. One per dispatch. |
| **`{ async: true }`** | A variant whose entry waits for the world: a node enters it only as the next of a declared transition, and only it takes transition handlers. |
| **`failed` and `FAILURE`** | Where a node goes when a handler refuses its step or a transition's work fails, and the built-in result that carries the failure's `{ kind, reason, error }` into it. Nothing is rolled back: the step into failed calls the handlers of the nodes it changes, so an exit may run twice in one dispatch. |
| **Named results** | The way the world's data reaches props: an enter, update or transition handler returns `variant.results.<name>(data)`, and result reducers fold it, in its own state and in every other state with a reducer of that name. |
| **Step `AbortSignal` and commit delegates** | An enter or update handler's fifth argument aborts when its step does not commit; `HandlerResult.ok().onCommit(fn)` runs `fn` only once the step commits. |
| **Nested states and `Items`** | A prop holding another state's instance, or an immutable map or keyed set of them (`def.items()`); the parent decides its children. |
| **`applyFlow`** | Puts the states on a target and registers its handlers and events; its config takes log handlers, injectable `timers` and `equalAnswers`. |
| **`lock` / `send`** | An exclusive, queued lock and the `send` that dispatches under it. A bare `dispatch` is deprecated. |
| **`observe` / `watch` / `subscribeFlow`** | Told after each commit, on a later timer turn: an observer of variants, a predicate over the flow's states, a subscriber to every change. |
| **Events** | `sm.defineEvent(name, changed, payload?)`: a public event of the flow, emitted through the target's own `emit`. |
| **`settled`** | Waits until every delivery of the flow ran, the locks they asked for were served, and no transition is pending. |
| **`setHandlersDisabled` / `mockHandlers`** | Switch every handler off for a test, and replace the handlers of one variant with mocks that give the world's answers. |
| **`Box` / `DisposableBox`** | An opaque handle for a live resource in state (`deref` throws in reducers), and one the engine disposes once the state drops it. |
| **`FrozenSet` / `FrozenMap`** | Immutable collections for set- and map-shaped data props. |

## Documentation

Full documentation lives at **[stateflow.dev](https://stateflow.dev)**: core concepts, the signal system, state
consistency and visibility, the API reference, a media-player example, testing, and the architecture guide.

**For coding agents:** the package ships `agent-guide.md` (`node_modules/@state-flow/core/agent-guide.md` once
installed), written for its version.

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
