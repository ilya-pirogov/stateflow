---
title: State Consistency
description: How StateFlow guarantees consistent state through immutability and type safety
---

StateFlow prevents state inconsistency through a combination of compile-time type safety and runtime immutability enforcement. This dual-layer protection makes it virtually impossible to create invalid or corrupted states in your application. {% .lead %}

## The Consistency Problem

Traditional state management systems suffer from several consistency issues that StateFlow eliminates by design.

### Race Conditions

In mutable state systems, concurrent modifications can lead to race conditions where the final state depends on the order of operations rather than business logic. StateFlow prevents this through immutability and atomic state transitions. Every state change creates a new immutable snapshot, ensuring that concurrent operations cannot interfere with each other.

### Partial Updates

Mutable systems often allow partial state updates that can leave the application in an inconsistent state if an error occurs mid-update. StateFlow requires complete state objects for every transition, making partial updates impossible. If a transition fails, the original state remains unchanged.

### Type Violations

JavaScript's dynamic nature allows runtime type violations that can corrupt state. StateFlow leverages TypeScript's type system at compile time and enforces structure at runtime, creating a robust barrier against type-related inconsistencies.

## Immutability Enforcement

StateFlow enforces immutability at multiple levels to ensure state consistency.

### Runtime Freezing

Every state instance is frozen using Object.freeze() upon creation:

```typescript
const state = playbackState.playing({ 
  position: 30, 
  duration: 180 
});

// Runtime error - state is frozen
state.position = 45; // TypeError: Cannot assign to read only property
```

State instances are **deep-frozen** on construction (`sealProps`): top-level props AND nested plain objects/arrays are recursively frozen, so no part of a committed state can be mutated. Live resources that cannot be frozen are wrapped in an opaque [`Box`](/docs/boxing-live-resources) and skipped; raw `Set`/`Map` should be `FrozenSet`/`FrozenMap`.

### Type-Level Immutability

TypeScript's type system provides compile-time protection:

```typescript
type PlaybackState = {
  readonly position: number;
  readonly duration: number;
};

// Compile error - cannot assign to readonly property
const updatePosition = (state: PlaybackState) => {
  state.position = 45; // Error: Cannot assign to 'position' because it is a read-only property
};
```

### Immutable Transitions

State transitions always create new instances rather than modifying existing ones:

```typescript
defineFlow(playbackState.playing, {
  seek: (state, signal) => ({
    ...state, // Spread existing state
    position: signal.position // Override specific field
  })
});

// Original state remains unchanged
const before = playbackState.playing({ position: 30, duration: 180 });
await using send = await lock(app);
await send(signals.seek({ position: 60 })).done();
console.log(before.position); // Still 30 - original unchanged
```

## Atomic State Transitions

StateFlow ensures that state transitions are atomic operations that either complete fully or fail without side effects.

### Transaction Boundaries

Each dispatch operation forms a transaction boundary. Within this boundary, all state changes are collected and validated before being applied:

```typescript
// Multiple states change atomically
await using send = await lock(app);
const result = send(signals.startPlayback());

if (result.kind === ResultKind.OK) {
  // All states transitioned successfully
  // playbackState: paused -> playing
  // bufferState: empty -> buffering
  // uiState: idle -> active
} else {
  // No states changed - all remain in original state
}
```

### Rollback Mechanism

When a transition fails, StateFlow provides rollback handlers to ensure consistency:

```typescript
applyFlow(app, [playbackState], (sm) => {
  sm.addEnterHandler(playbackState.playing, (state) => {
    // Async work must be wrapped in Result.transition() — handlers
    // return a Result synchronously, never a Promise.
    return Result.transition(async () => {
      const result = await startMediaPlayback();
      if (!result.success) {
        return Result.reject("Playback initialization failed");
      }
      return Result.ok();
    });
  });

  sm.addRollbackHandler(playbackState.playing, (state) => {
    // Clean up any partial initialization
    stopMediaResources();
    return Result.ok();
  });
});
```

### Enqueue Chain Rollback

When using `Result.enqueue()` to chain signals, the entire chain is atomic. If any enqueued signal fails, all state changes — including the original dispatch — are rolled back to the state before the chain started:

```typescript
sm.addEnterHandler(orderState.confirmed, () => {
  return Result.enqueue(signals.chargePayment());
});

// If chargePayment fails:
// 1. orderState rolls back to its pre-dispatch state
// 2. All intermediate state changes are undone
// 3. The error result from the failed signal is returned
```

## Type Safety Through Inference

StateFlow leverages TypeScript's type inference to maintain consistency without verbose type annotations.

### State Type Inference

The Infer utility type extracts precise types from state definitions:

```typescript
const connectionState = defineState<{
  url: string;
  status: 'connecting' | 'connected' | 'error';
  errorCount: number;
}>()
  .name("connection")
  .signals(signals)
  .variant("active", true)
  .build();

// Type is automatically inferred
type ConnectionProps = Infer<typeof connectionState.active>;
// { url: string; status: 'connecting' | 'connected' | 'error'; errorCount: number }

// Application structure is type-checked
interface App {
  connection: ConnectionProps;
}
```

### Signal Type Safety

Signals maintain type safety for their parameters:

```typescript
const signals = {
  updateConfig: defineSignal<{
    timeout: number;
    retryLimit: number;
  }>("updateConfig")
};

await using send = await lock(app);

// Type error - missing required field
send(signals.updateConfig({ timeout: 5000 }));
// Error: Property 'retryLimit' is missing

// Type error - wrong type
send(signals.updateConfig({ 
  timeout: "5000", // Error: Type 'string' is not assignable to type 'number'
  retryLimit: 3 
}));
```

## Validation at Transition Time

StateFlow allows validation logic within flow definitions to ensure business rule consistency.

### Input Validation

Flow handlers can validate inputs and reject invalid transitions:

```typescript
defineFlow(audioState.playing, {
  setVolume: (state, signal) => {
    if (signal.level < 0 || signal.level > 1) {
      return Result.reject("Volume must be between 0 and 1");
    }
    
    if (state.muted && signal.level > 0) {
      return Result.reject("Cannot set volume while muted");
    }
    
    return { ...state, volume: signal.level };
  }
});
```

### State Invariants

Complex invariants can be enforced across multiple state properties:

```typescript
defineFlow(gameState.playing, {
  movePlayer: (state, signal) => {
    const newPosition = {
      x: state.player.x + signal.deltaX,
      y: state.player.y + signal.deltaY
    };
    
    // Enforce boundary constraints
    if (newPosition.x < 0 || newPosition.x > state.boardSize ||
        newPosition.y < 0 || newPosition.y > state.boardSize) {
      return Result.reject("Move would place player outside board");
    }
    
    // Check collision with obstacles
    const collision = state.obstacles.some(
      obs => obs.x === newPosition.x && obs.y === newPosition.y
    );
    
    if (collision) {
      return Result.reject("Move blocked by obstacle");
    }
    
    return {
      ...state,
      player: newPosition,
      moveCount: state.moveCount + 1
    };
  }
});
```

## Preventing Common Inconsistencies

StateFlow's design prevents several common state inconsistency patterns.

### No Forgotten Updates

Traditional systems often require updating multiple related states, leading to inconsistencies when developers forget some updates. StateFlow's atomic transitions ensure all related states update together:

```typescript
defineFlow(orderState.pending, {
  confirmOrder: (state) => {
    // All related states must be returned together
    return orderState.confirmed({
      ...state,
      confirmedAt: Date.now(),
      status: 'confirmed',
      // Compiler ensures all required fields are provided
    });
  }
});
```

### No Stale Closures

JavaScript closures can capture stale state values. StateFlow's signal-based architecture ensures handlers always receive the current state:

```typescript
// ❌ Traditional approach - prone to stale closure
let count = 0;
setTimeout(() => {
  count++; // Might use stale value
}, 1000);

// ✅ StateFlow approach - always current
defineFlow(counterState.active, {
  increment: (state) => ({ count: state.count + 1 })
  // 'state' parameter is always the current state
});
```

### No Circular Dependencies

StateFlow's unidirectional data flow prevents circular state dependencies:

```typescript
// States can only be modified through signals
// This prevents State A from directly modifying State B
// which could then modify State A, creating a cycle

defineFlow(stateA.active, {
  update: (state, signal, context) => {
    // Can read other states from context
    const stateB = context.stateB;
    
    // But cannot directly modify them
    // Must return new state for A only
    return { ...state, value: stateB.value + 1 };
  }
});
```

Through these mechanisms, StateFlow provides strong guarantees about state consistency, making it suitable for applications where correctness is critical.
