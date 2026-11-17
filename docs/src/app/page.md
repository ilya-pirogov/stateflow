---
title: StateFlow
description: Type-safe, immutable state management with guaranteed signal handling
---

StateFlow is type-safe state management for TypeScript: every change is a signal, pure reducers decide where the
state goes, handlers apply the decision to the world, and every state is a frozen snapshot. {% .lead %}

## Why StateFlow?

- **Every signal has a result.** A signal commits, is ignored, is rejected or fails, and the caller learns which;
  nothing is dropped silently.
- **One place for each decision.** Reducers are pure and synchronous. Handlers make the effects and only succeed or
  refuse: the reducer has named where the state goes either way.
- **Immutable snapshots.** Every instance is deep-frozen. A live resource sits in a `Box`, or in a `DisposableBox`
  that the engine disposes once the state drops it.
- **Waiting for the world is explicit.** An entry that waits is a declared transition with its three ends named:
  the state held meanwhile, the state reached, and the state taken on failure.
- **Visible and testable.** Every step writes a log entry, and observers, events and watches report each commit.
  With every handler switched off a flow runs with no handler's effect, and mocks supply the world's answers.

## Core Architecture

```typescript
// 1. Signals: commands that ask for a change
const signals = {
  play: defineSignal("play"),
  setVolume: defineSignal<{ level: number }>("setVolume"),
};

// 2. States: immutable snapshots with named variants
const playbackState = defineState<{ position: number; volume: number }>()
  .name("playback")
  .signals(signals)
  .variant("paused", { initial: true })
  .variant("playing")
  .build();

// 3. Flows: the pure reducers of each variant
defineFlow(playbackState.paused, {
  play: (state) => playbackState.playing(state),
  setVolume: (state, { level }) => ({ ...state, volume: level }),
});
```

## Quick Example

```typescript
import { applyFlow, defineFlow, defineSignal, defineState, lock } from "@state-flow/core";

const signals = { increment: defineSignal("increment") };

const counterState = defineState<{ count: number }>()
  .name("counter")
  .signals(signals)
  .variant("active", { initial: true })
  .stringRepr((s) => `count=${s.count}`)
  .build();

defineFlow(counterState.active, { increment: (s) => ({ count: s.count + 1 }) });

const app = { counter: { count: 0 } };
applyFlow(app, [counterState], () => {});

// Signals go through a lock, and every send returns a result.
{
  await using send = await lock(app);
  await send(signals.increment()).done();
}
console.log(`${app.counter}`); // "counter.active(count=1)"
```

The types need TypeScript 5.6+, and `await using` an ES2022+ target; see [Installation](/docs/installation).

## Next Steps

- [Core Concepts](/docs/core-concepts): signals, states, reducers, handlers, transitions and observation
- [API Reference](/docs/api-reference): every export, with its rules
