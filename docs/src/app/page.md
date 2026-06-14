---
title: StateFlow
description: Type-safe, immutable state management with guaranteed signal handling
---

StateFlow is a type-safe state management system that guarantees state consistency through immutability, provides explicit signal feedback, and maintains complete state visibility. {% .lead %}

## Why StateFlow?

Traditional state management suffers from three critical problems:

- **State Inconsistency**: Mutable state leads to race conditions and unpredictable behavior
- **Silent Failures**: Invalid transitions are ignored without feedback  
- **Opaque State**: Difficult to understand current state and debug issues

StateFlow solves these with **immutable states**, **explicit signal results**, and **built-in observability**.

## Core Architecture

StateFlow uses three key concepts:

```typescript
// 1. Signals: Commands that trigger state changes
const signals = {
  play: defineSignal("play"),
  setVolume: defineSignal<{ level: number }>("setVolume")
};

// 2. States: Immutable snapshots with variants
const playbackState = defineState<{ position: number; volume: number }>()
  .name("playback")
  .signals(signals)
  .variant("playing")
  .variant("paused", true) // initial variant
  .build();

// 3. Flows: Pure transition logic
defineFlow(playbackState.paused, {
  play: (state) => playbackState.playing(state),
  setVolume: (state, signal) => ({ ...state, volume: signal.level })
});
```

## Quick Example

Here's a minimal example demonstrating StateFlow's key features:

```typescript
import { defineSignal, defineState, defineFlow, applyFlow, lock } from "@state-flow/core";

// Define your signals
const signals = { increment: defineSignal("increment") };

// Define your state structure
const appState = defineState<{ count: number }>()
  .name("counter")
  .signals(signals)
  .variant("active", true)
  .stringRepr(s => `count=${s.count}`)
  .build();

// Define state transitions
defineFlow(appState.active, {
  increment: (state) => ({ count: state.count + 1 })
});

// Apply to your application
const app = { counter: { count: 0 } };
applyFlow(app, [appState], () => {});

// Dispatch signals with guaranteed feedback
await using send = await lock(app);
await send(signals.increment()).done();
console.log(`${app.counter}`); // "counter.active(count=1)"
```

The `await using` syntax requires TypeScript 5.2+ and an ES2022+ target — see [Installation](/docs/installation) for setup details.

## Next Steps

Explore the core concepts to understand how StateFlow achieves its guarantees, or jump directly to the API reference for detailed usage information.
