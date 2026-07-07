---
title: Core Concepts
description: Understanding StateFlow's fundamental architecture
---

StateFlow uses four key concepts that work together to provide guaranteed state consistency and explicit feedback. Understanding these concepts is essential for effective StateFlow usage. {% .lead %}

_The snippets below are illustrative fragments that share a common setup; some identifiers (e.g. `userSignals`, `connectionState`, the `loadProfile` handler) are defined in another section or omitted for brevity._

## States: Immutable Data Snapshots

States represent your application's data at a specific point in time. They are immutable snapshots with variants representing different phases:

```typescript
const userState = defineState<{
  id: string;
  email: string;
  loginAttempts: number;
}>()
  .name("user")
  .signals(userSignals) // required: the signals this state responds to
  .variant("guest", true) // initial variant
  .variant("authenticated")
  .variant("locked")
  .stringRepr(s => `${s.email} (${s.loginAttempts} attempts)`)
  .build();

// Create state instance (deep-frozen on construction)
const guest = userState.guest({
  id: '',
  email: '',
  loginAttempts: 0
});
// guest.email = 'modified'; // TypeError: Cannot assign to read only property
```

**Key Points:**
- States are **deep-frozen** on construction (nested objects/arrays included), preventing mutation; live resources go in an opaque [`Box`](/docs/boxing-live-resources)
- Variants represent different phases (guest, authenticated, locked)
- Each variant shares the same data structure
- String representations aid debugging

## Signals: Commands for State Changes

Signals are the only way to request state changes. They are type-safe command objects that trigger state transitions:

```typescript
const userSignals = {
  // Simple parameterless signal
  logout: defineSignal("logout"),
  
  // Parameterized signal with validation
  login: defineSignal<{ email: string; password: string }>("login"),
  
  // Complex signal with multiple parameters
  updateProfile: defineSignal<{ 
    name?: string; 
    email?: string; 
    avatar?: string 
  }>("updateProfile"),

  // Loads the user's profile after authentication
  loadProfile: defineSignal<{ userId: string }>("loadProfile")
};

// Usage: Create signal instances
const loginSignal = userSignals.login({ 
  email: 'user@example.com', 
  password: 'secret' 
});
```

**Key Points:**
- Signals centralize all state change requests
- Type-safe parameters prevent runtime errors
- Immutable command objects with unique identifiers

## Flows: Pure State Transition Logic

Flows define how state variants respond to signals. They are pure functions that return new states or Results:

```typescript
defineFlow(userState.guest, {
  login: (state, signal) => {
    // Validation logic
    if (!signal.email || !signal.password) {
      return Result.reject('Email and password required');
    }
    
    // State transition
    return userState.authenticated({
      id: generateId(),
      email: signal.email,
      loginAttempts: 0
    });
  }
});

defineFlow(userState.authenticated, {
  logout: (state) => userState.guest({
    id: '',
    email: '',
    loginAttempts: state.loginAttempts
  }),
  
  updateProfile: (state, signal) => ({
    ...state,
    email: signal.email || state.email
  })
});
```

**Flow Rules:**
- Pure functions only (no side effects)
- Must return synchronously  
- Each variant has one flow definition
- Unhandled signals are ignored

## Results: Explicit Operation Feedback  

Every signal dispatch returns a Result that explicitly indicates what happened, eliminating silent failures:

```typescript
// Modern pattern - dispatch through lock() + send(), then .expect() and .done()
try {
  await using send = await lock(app);
  await send(userSignals.login({ email, password }))
    .expect(ResultKind.OK)
    .done();
  console.log('Login successful');
} catch (error) {
  console.error('Login failed:', error);
}

// Result types:
// Result.ok() - Success
// Result.reject('message') - Validation failed
// Result.error(error) - Exception occurred
// Result.ignore('reason') - Signal not applicable
// Result.enqueue(signal) - Success + chain a follow-up signal (atomic)
//
// Note: Result.transition(asyncFn, timeout) is ONLY valid inside applyFlow
// enter/update/exit handlers. A defineFlow handler is synchronous and cannot
// return a transition — doing so is converted into an error.
```

**Key Points:**
- Results provide explicit feedback for every operation
- Use `.expect()` to validate expected result types
- Use `.done()` to handle both sync and async operations

## Application Integration

Connect StateFlow to your application using `applyFlow` for side effects and resource management:

```typescript
const app = {
  user: { id: '', email: '', loginAttempts: 0 },
  connection: { status: 'disconnected', url: '' }
};

applyFlow(app, [userState, connectionState], (sm) => {
  // Side effects when entering states
  sm.addEnterHandler(userState.authenticated, (state) => {
    localStorage.setItem('userId', state.id);
    return Result.ok();
  });
  
  // Async operations with timeout
  sm.addEnterHandler(connectionState.connecting, (state) => {
    return Result.transition(async () => {
      await connectToServer(state.url);
      return Result.ok();
    }, 5000);
  });
  
  // Cleanup when leaving states
  sm.addExitHandler(userState.authenticated, (state) => {
    localStorage.removeItem('userId');
    return Result.ok();
  });
});
```

**Handler Types:**
- `addEnterHandler` - Called when entering a state
- `addExitHandler` - Called when leaving a state
- `addUpdateHandler` - Called when state data changes
- `addRollbackHandler` - Called when transitions fail

## Lock: The Dispatch Pathway

`lock()` + `send()` is the standard way to dispatch — not just for multiple signals. A bare
`dispatch()` throws if a lock is held or a transition is in flight, so it is reserved for
synchronous teardown (e.g. `beforeunload`) or pre-lock bootstrap. Acquire an exclusive lock with
`await using`:

```typescript
await using send = await lock(app);
await send(userSignals.login({ email, password })).done();
await send(userSignals.loadProfile({ userId })).done();
// lock released automatically
```

The lock ensures no other code can dispatch signals while your critical section is running. If another caller tries to `lock()`, it waits in queue. If `dispatch()` is called while a lock is held, it throws.

## Signal Chaining with Result.enqueue

Handlers can return `Result.enqueue(signal)` to chain a follow-up signal dispatch. The entire chain is atomic — if any enqueued signal fails, all state changes roll back:

```typescript
sm.addEnterHandler(userState.authenticated, (state) => {
  // After successful authentication, automatically load the profile
  return Result.enqueue(userSignals.loadProfile({ userId: state.id }));
});
```

## Observability: State Monitoring

StateFlow provides built-in mechanisms for monitoring state changes:

```typescript
// Observe specific state variants
const subscription = observe(
  app,
  [connectionState.connected, connectionState.failed],
  (state) => {
    updateUIConnectionStatus(state);
  }
);

// Custom comparison for fine-grained updates
observe(
  app,
  [connectionState.connecting],
  (state) => updateRetryCounter(state.retryCount),
  (prev, curr) => prev.retryCount !== curr.retryCount
);

// Cleanup when done
subscription[Symbol.dispose]();
```

To observe an entire flow at once — rather than a specific list of variants — use
`subscribeFlow()`. It is observation-only (the subscriber cannot dispatch, enqueue, or mutate
state) and delivers one `FlowChange` per changed state, post-commit, on its own macrotask:

```typescript
using sub = subscribeFlow(app, (change) => {
  console.log(`${change.stateName}: ${change.prevVariant} -> ${change.nextVariant}`);
});
```

These concepts work together to create a state management system that is predictable, debuggable, and type-safe, while providing explicit feedback for every operation.
