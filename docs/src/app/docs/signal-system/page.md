---
title: Signal System
description: Guaranteed handling and comprehensive feedback through StateFlow's signal architecture
---

StateFlow's signal system provides the exclusive pathway for state modifications, ensuring that every state change request receives explicit feedback. This architecture eliminates silent failures and provides comprehensive tracking of all state transitions. {% .lead %}

## Signal Architecture

The signal system operates on a fundamental principle that distinguishes StateFlow from traditional state management approaches. Rather than allowing direct state mutations, all state changes must flow through signals, which act as validated commands with guaranteed handling and explicit results.

### Signal as Commands

Signals represent intent to change state rather than direct mutations. This distinction is crucial for maintaining system integrity. When you dispatch a signal, you are requesting a state change, not demanding it. The system evaluates this request against current state and business rules before deciding how to proceed.

```typescript
// Traditional approach - direct mutation with no feedback
state.volume = 0.8; // What if this fails? What if it's invalid?

// StateFlow approach - a signal sent through a lock, with guaranteed feedback
await using send = await lock(app);
const result = await send(signals.setVolume({ level: 0.8 })).done();
if (result.kind === ResultKind.Rejected) {
  console.error(`Volume change rejected: ${result.message}`);
}
```

### Dispatching: `lock()` + `send()`

Always send signals through a lock. A bare `dispatch()` throws if a lock is held or a transition
is in flight, so once any flow uses async transitions it becomes a race. `lock()` acquires an
exclusive, FIFO‑queued handle (after draining pending transitions) and returns a `send` you use
for every dispatch in that critical section:

```typescript
await using send = await lock(app);
await send(signals.play()).expect(ResultKind.OK).done();
await send(signals.seek({ position: 30 })).done(); // ordered, same lock
// released automatically at scope exit

// ⚠️ Bare dispatch() is deprecated — reserve it only for synchronous teardown
//    (e.g. `beforeunload`) or pre-lock bootstrap, where an async lock cannot be acquired.
```

`.expect()` is enforced at `.done()`: on an async (`InTransition`) result the expectation is
checked when the transition resolves, so an async dispatch **must** chain `.done()` for the
expectation to hold. Write `await send(sig).expect(...).done()`.

### Type-Safe Signal Parameters

Signals leverage TypeScript's type system to ensure parameter correctness at compile time. This prevents a entire class of runtime errors related to incorrect signal data.

```typescript
const authSignals = {
  login: defineSignal<{
    username: string;
    password: string;
    rememberMe?: boolean;
  }>("login"),
  
  logout: defineSignal("logout"),
  
  updateProfile: defineSignal<{
    displayName?: string;
    email?: string;
    avatarUrl?: string;
  }>("updateProfile")
};

// Type checking prevents errors
await using send = await lock(app);
send(authSignals.login({ 
  username: "user@example.com"
  // Error: Property 'password' is missing
}));
```

## Guaranteed Handling

Every signal dispatched through StateFlow receives explicit handling, even if that handling is to ignore the signal. This guarantee eliminates the uncertainty of whether a state change request was processed.

### Explicit Results

StateFlow's Result type system ensures that every signal dispatch provides clear feedback about what occurred:

```typescript
async function performAction() {
  await using send = await lock(app);
  const result = await send(signals.play()).done();
  
  // Exhaustive handling ensures no case is missed
  switch (result.kind) {
    case ResultKind.OK:
      updateUI("Playing");
      break;
      
    case ResultKind.Ignored:
      // Signal was not applicable to current state
      console.log("Already playing or signal not handled");
      break;
      
    case ResultKind.Rejected:
      showError(`Cannot play: ${result.message}`);
      break;
      
    case ResultKind.Error:
      logError(result.error);
      showError("An unexpected error occurred");
      break;
      
    case ResultKind.InTransition:
      showLoading();
      handleAsyncResult(result);
      break;
  }
}
```

### Signal Routing

StateFlow automatically routes signals to the appropriate handlers based on current state. This routing is deterministic and type-safe:

```typescript
defineFlow(mediaState.paused, {
  play: (state) => mediaState.playing(state),
  stop: (state) => mediaState.stopped({ ...state, position: 0 })
  // 'pause' signal is not defined - will be Ignored
});

defineFlow(mediaState.playing, {
  pause: (state) => mediaState.paused(state),
  stop: (state) => mediaState.stopped({ ...state, position: 0 })
  // 'play' signal is not defined - will be Ignored
});

// Signal routing based on current state
await using send = await lock(app);
await send(signals.play()).done();   // Handled if paused, ignored if playing
await send(signals.pause()).done();  // Handled if playing, ignored if paused
```

## Comprehensive Feedback

The signal system provides detailed feedback mechanisms that support debugging, monitoring, and error recovery.

### Result Metadata

Results carry contextual information about signal processing:

```typescript
await using send = await lock(app);
const result = await send(signals.connect()).done();

// Results can be inspected for debugging
if (result.kind === ResultKind.Error) {
  console.error("Error:", result.error);
  console.error("Stack:", result.stacktrace);
} else if (result.kind === ResultKind.Rejected) {
  console.error("Message:", result.message);
}

// Timing is also available on every result. `finishedAt` is only meaningful
// after `await result.done()`: for an async (InTransition) result it stays equal
// to `startedAt` until the transition resolves.
console.log("Started at:", result.startedAt);
console.log("Finished at:", result.finishedAt);
```

### Result Merging

When multiple states handle a signal, their results are merged according to strict priority rules:

```typescript
// Consider an application with multiple states
const app = {
  auth: { /* ... */ },
  data: { /* ... */ },
  ui: { /* ... */ }
};

// When a signal affects multiple states
const result = dispatch(app, signals.logout());

// Results are merged with priority:
// 1. Error - any error stops processing
// 2. Rejected - validation failures take precedence  
// 3. InTransition - async operations are awaited
// 4. OK - successful handling
// 5. Ignored - lowest priority

// The final result reflects the highest priority outcome
```

### Asynchronous Signal Handling

Signals can trigger asynchronous operations while maintaining feedback guarantees:

```typescript
applyFlow(app, [dataState], (sm) => {
  sm.addEnterHandler(dataState.loading, (state) => {
    return Result.transition(async () => {
      try {
        const data = await fetchData(state.query);
        // Enqueue a same-target follow-up signal to run after this transition commits.
        // A bare dispatch() here would throw ("States are in transitioning").
        return Result.enqueue(signals.dataLoaded({ data }));
      } catch (error) {
        return Result.error(error);
      }
    }, 10000); // 10 second timeout
  });
});

// Async feedback handling
async function loadData(query: string) {
  await using send = await lock(app);
  const result = send(signals.startLoading({ query }));
  
  if (result.kind === ResultKind.InTransition) {
    showLoadingSpinner();
    const finalResult = await result.done();
    hideLoadingSpinner();
    
    if (finalResult.kind === ResultKind.OK) {
      displayData();
    } else {
      showError(finalResult);
    }
  }
}
```

## Signal Validation

The signal system supports comprehensive validation at multiple levels to ensure system integrity.

### Parameter Validation

Signal handlers can validate parameters before processing:

```typescript
defineFlow(formState.editing, {
  submit: (state, signal) => {
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(signal.email)) {
      return Result.reject("Invalid email format");
    }
    
    // Password strength validation
    if (signal.password.length < 8) {
      return Result.reject("Password must be at least 8 characters");
    }
    
    // Business rule validation
    if (state.submitCount >= 3) {
      return Result.reject("Too many submission attempts");
    }
    
    return formState.submitting({
      ...state,
      formData: signal,
      submitCount: state.submitCount + 1
    });
  }
});
```

### Cross-State Validation

Signals can be validated against the broader application context:

```typescript
defineFlow(orderState.draft, {
  submit: (state, signal, context) => {
    // Validate against user state
    if (!context.user.isVerified) {
      return Result.reject("Account must be verified to place orders");
    }
    
    // Validate against inventory state
    const available = context.inventory[state.productId];
    if (available < state.quantity) {
      return Result.reject(`Only ${available} items in stock`);
    }
    
    // Validate against payment state
    if (context.payment.method === null) {
      return Result.reject("Payment method required");
    }
    
    return orderState.processing(state);
  }
});
```

## Signal Patterns

Common patterns emerge when working with StateFlow's signal system that promote clean, maintainable code.

### Command and Query Separation

Signals should represent commands (state changes) rather than queries (state reads):

```typescript
// ✅ Good - signals for state changes
const signals = {
  startRecording: defineSignal("startRecording"),
  stopRecording: defineSignal("stopRecording"),
  setQuality: defineSignal<{ quality: 'high' | 'medium' | 'low' }>("setQuality")
};

// ❌ Avoid - signals for queries
const badSignals = {
  getRecordingStatus: defineSignal("getRecordingStatus"), // Use direct state access
  isRecording: defineSignal("isRecording") // Use state observation
};
```

### Signal Composition

Complex operations can be composed from simpler signals:

```typescript
async function saveAndClose(data: FormData) {
  // Compose multiple signals under ONE held lock so they stay safely ordered
  await using send = await lock(app);
  const saveResult = await send(signals.save({ data })).done();

  if (saveResult.kind === ResultKind.OK) {
    return await send(signals.close()).done();
  }

  return saveResult;
}
```

### Follow-up Signals with `Result.enqueue`

A flow handler can request a small same-target follow-up *state change* to run after the current
dispatch commits, using `Result.enqueue`:

```typescript
// The `loading` enter handler advances to `paused` once async init succeeds.
sm.addEnterHandler(driverState.loading, (state) =>
  Result.transition(async () => {
    await init(state);
    return Result.enqueue(signals.loaded()); // one trivial follow-up
  })
);
```

Rules:

- **At most one `Result.enqueue` per handler**, and don't have two different handlers each enqueue
  in the same dispatch cycle — the engine dev-warns that case.
- It must be a **trivial** same-target state change — never kick off heavy side effects.
- A **self-terminating same-target record chain** is supported and common: an `update` handler
  enqueues a record signal (e.g. `srcLoaded`) whose same-variant transition re-runs the update,
  which re-verifies and settles at a fixed point.
- For a **cross-target** follow-up, use `await using send = await lock(otherTarget)` — that is
  *not* an enqueue.

### Error Recovery Signals

Design signals that support error recovery flows:

```typescript
const recoverySignals = {
  retry: defineSignal<{ attemptNumber: number }>("retry"),
  fallback: defineSignal<{ useCache: boolean }>("fallback"),
  reset: defineSignal("reset")
};

defineFlow(apiState.error, {
  retry: (state, signal) => {
    if (signal.attemptNumber > 3) {
      return Result.reject("Maximum retry attempts exceeded");
    }
    return apiState.fetching({ ...state, attempt: signal.attemptNumber });
  },
  
  fallback: (state, signal) => {
    if (signal.useCache && state.cachedData) {
      return apiState.ready({ ...state, data: state.cachedData });
    }
    return Result.reject("No cached data available");
  },
  
  reset: () => apiState.idle(initialApiState)
});
```

Through these mechanisms, StateFlow's signal system provides a robust foundation for state management that guarantees handling, provides comprehensive feedback, and maintains system integrity throughout the application lifecycle.
