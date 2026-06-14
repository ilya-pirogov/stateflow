---
title: API Reference
description: Complete API documentation for StateFlow
---

Complete API documentation for StateFlow functions, types, and patterns. {% .lead %}

## Core Functions

StateFlow's essential functions for state management:

{% callout title="About the examples" %}
The examples below are illustrative fragments. Identifiers such as `taskSignals`,
`taskState`, `uiState`, `userState`, and `signals` are assumed to be defined elsewhere
(e.g. via `defineSignal`/`defineState`) and are not fully scaffolded here.
{% /callout %}

### defineState

Creates a state definition with typed variants using a builder pattern.

```typescript
function defineState<TProps>(): StateBuilder<TProps, "", unknown, "">
```

Builder methods:
- `.name(string)` - Set unique state name
- `.variant(name, isInitial?)` - Add state variant
- `.signals(object)` - Define handled signals
- `.parser(func)` - Custom property parsing
- `.stringRepr(func)` - Custom string representation
- `.build()` - Finalize definition

Example:

```typescript
const taskState = defineState<{
  id: string;
  title: string;
  assignee?: string;
  priority: 'low' | 'medium' | 'high';
}>()
  .name("task")
  .signals(taskSignals)
  .variant("draft", true)
  .variant("assigned")
  .variant("completed")
  .stringRepr(s => `${s.title} (${s.priority})`)
  // `.parser` receives `object`, so cast before reading properties.
  .parser((obj) => {
    const o = obj as Partial<{
      id: string;
      title: string;
      assignee?: string;
      priority: 'low' | 'medium' | 'high';
    }>;
    return {
      id: o.id || crypto.randomUUID(),
      title: o.title || "Untitled",
      assignee: o.assignee,
      priority: o.priority || 'medium'
    };
  })
  .build();
```

### defineSignal

Creates a signal definition for triggering state transitions.

```typescript
function defineSignal<TArgs extends Record<string, unknown> | void = void>(
  name: string,
  stringRepr?: (args: TArgs) => string
): SignalDefinition<TArgs>
```

Parameters:
- `name` - Unique signal identifier
- `stringRepr` - Optional custom string representation

Returns signal factory function.

Example:

```typescript
// Parameterless signal
const refresh = defineSignal("refresh");
const signal1 = refresh(); // Creates signal instance

// Parameterized signal
const updatePriority = defineSignal<{
  taskId: string;
  priority: 'low' | 'medium' | 'high';
}>("updatePriority");
const signal2 = updatePriority({ 
  taskId: "123", 
  priority: "high" 
});

// Custom string representation
const complexSignal = defineSignal<{
  action: string;
  metadata: Record<string, unknown>;
}>("complexSignal", (args) => `${args.action}:${Object.keys(args.metadata).length} props`);
```

### defineFlow

Defines signal handlers for a state variant.

```typescript
function defineFlow(state: StateVariant, handlers: SignalHandlers): void
```

Handler signature: `(state, signal, context) => StateResult`

Example:

```typescript
defineFlow(taskState.draft, {
  assign: (state, signal) => {
    if (!signal.userId) {
      return Result.reject("User ID required for assignment");
    }
    return taskState.assigned({
      ...state,
      assignee: signal.userId
    });
  },
  
  updatePriority: (state, signal) => ({
    ...state,
    priority: signal.priority
  }),
  
  delete: () => Result.reject("Cannot delete draft tasks")
});
```

### applyFlow

Applies state definitions to an application object and sets up handlers.

```typescript
function applyFlow(target: object, states: StateDefinition[], 
                  initializer: (sm: StateManager) => void,
                  config?: FlowConfig): void
```

StateManager methods:
- `addEnterHandler(state, handler)` - Called when entering state
- `addExitHandler(state, handler)` - Called when leaving state
- `addUpdateHandler(state, handler)` - Called when state data changes
- `addRollbackHandler(state, handler)` - Called on transition failures

Example:

```typescript
const app = {
  task: { id: "", title: "", priority: "medium" as const },
  ui: { loading: false, error: null }
};

applyFlow(app, [taskState, uiState], (sm) => {
  sm.addEnterHandler(taskState.assigned, async (state) => {
    return Result.transition(async () => {
      await notifyUser(state.assignee, state);
      return Result.ok();
    }, 3000);
  });
  
  sm.addExitHandler(uiState.error, (state) => {
    clearErrorDisplay();
    return Result.ok();
  });
});
```

### dispatch

Dispatches a signal to trigger state transitions.

```typescript
function dispatch(target: object, signal: Signal, mute?: boolean): Result
```

**Deprecated for general use.** `dispatch()` throws if a lock is held or a transition is in
flight, so prefer `lock()` + `send()` everywhere (see below). Reserve bare `dispatch()` only for
synchronous teardown (e.g. `beforeunload`) and pre-lock bootstrap, where an async lock cannot be
acquired. Returns a Result; on an async (`InTransition`) result, `.expect()` is enforced at
`.done()`, so an async dispatch must chain `.done()`.

Example:

```typescript
// Basic dispatch with expectation
try {
  await dispatch(app, signals.assign({ userId: "user123" }))
    .expect(ResultKind.OK)
    .done();
  console.log("Task assigned successfully");
} catch (error) {
  console.error(`Assignment failed: ${error}`);
}

// Asynchronous dispatch
await dispatch(app, signals.save()).done();
console.log('Save completed');

// Muted dispatch (no logging)
await dispatch(app, signals.ping(), true).done();

// Multiple expected results
await dispatch(app, signals.optionalAction())
  .expect(ResultKind.OK, ResultKind.Ignored)
  .done();
```

### observe

Watches for changes in specific state variants.

```typescript
function observe(target: object, stateVariants: StateVariant[], 
                handler: (state: StateInstance) => void,
                compareFn?: (prev, curr) => boolean): Disposer
```

Returns disposable observer. Use `[Symbol.dispose]()` for cleanup.

Example:

```typescript
// Basic observation
const observer = observe(
  app,
  [taskState.assigned, taskState.completed],
  (state) => updateTaskDisplay(state)
);

// With custom comparison
const priorityObserver = observe(
  app,
  [taskState.assigned],
  (state) => highlightHighPriority(state),
  (prev, curr) => prev.priority !== curr.priority
);

// Using the using keyword (Explicit Resource Management (`using`) —
// requires TypeScript 5.2+ and the ESNext.Disposable lib)
function watchTasks() {
  using observer = observe(app, [taskState.assigned], updateUI);
  // Observer automatically disposed when scope exits
}

// Manual disposal
const sub = observe(app, [taskState.completed], logCompletion);
// Later...
sub[Symbol.dispose]();
```

### lock

Acquires an exclusive lock on the target for dispatching multiple signals in sequence. Uses `await using` for automatic cleanup.

```typescript
async function lock(target: object, label?: string): Promise<DispatchFn>
```

Returns a callable `DispatchFn` that dispatches signals while holding the lock. The function also implements `Symbol.asyncDispose` for automatic release.

- Acquires the lock first, then awaits `sync(target)` to drain any in-flight transitions
- If another lock is held, waits in queue until released
- `dispatch()` throws if called while a lock is held — use `lock()` instead

Example:

```typescript
// Multiple dispatches in one critical section
await using send = await lock(app);
await send(signals.activate()).done();
await send(signals.configure({ setting: "value" })).done();
// lock released automatically at scope exit

// Locks queue — second caller waits for the first
async function operationA() {
  await using send = await lock(app);
  send(signals.step1());
  send(signals.step2());
}

async function operationB() {
  await using send = await lock(app); // waits for operationA's lock
  send(signals.step3());
}
```

### sync

Waits for all pending async transitions to complete.

```typescript
async function sync(target: object): Promise<void>
```

Essential before operations requiring stable state.

Example:

```typescript
async function performComplexOperation() {
  // Ensure no transitions are pending
  await sync(app);

  // Use lock for multiple dispatches
  await using send = await lock(app);
  await send(signals.startBatch()).done();
  await send(signals.process({ id: "1" })).done();
  await send(signals.finalizeBatch()).done();
}
```

## Result API

Results provide explicit feedback for all operations with type-safe handling.

### Result Types

```typescript
enum ResultKind {
  OK, Ignored, InTransition, Rejected, Error
}

class Result<TData = unknown> {
  readonly kind: ResultKind;
  readonly data: TData | null;
  get error(): Error | null;
  get message(): string | null;

  in(...kinds: ResultKind[]): boolean;
  done(): Promise<Result>;
  expect(...kinds: ResultKind[]): this;
}
```

### Static Methods

```typescript
Result.ok(data?)           // Success
Result.ignore(message)     // Signal not applicable
Result.reject(message)     // Validation failed
Result.error(error)        // Exception occurred
Result.transition(asyncFn, timeout?) // Async operation
Result.enqueue(signal)     // Success + chain follow-up signal
```

### Result.enqueue

Creates an OK result that chains a follow-up signal for dispatch after the current dispatch completes successfully. The entire chain is atomic — if the enqueued signal fails, all state changes (including the original dispatch) are rolled back.

```typescript
Result.enqueue(signal: StateSignal): Result
```

Example:

```typescript
// In state handlers — enqueue a follow-up signal
sm.addEnterHandler(driverState.active, (state) => {
  return Result.enqueue(signals.updateDriver({ driver: state.driver }));
});

// Calling dispatch(app, signals.activateDriver()) will:
// 1. Execute activateDriver -> enters active state
// 2. Automatically dispatch updateDriver within the same lock
// 3. Return the final result only after both complete
// 4. If updateDriver fails, roll back to state before activateDriver

// A self-terminating same-target record chain is supported: an update enqueues a record
// signal whose same-variant transition re-runs the update, which re-verifies and converges.
sm.addUpdateHandler(driverState.active, (state) => {
  return state.recorded ? Result.ok() : Result.enqueue(signals.record());
});
```

**Rules:** at most one `Result.enqueue` per handler, and don't let two different handlers each
enqueue in the same dispatch cycle (the engine dev-warns it). The supported "chain" is the
self-terminating same-target record pattern above, which converges to a fixed point — not a way
to script arbitrary multi-step workflows. For those, and for any cross-target follow-up, use
`lock()` + `send()` on the target.

### Other Static Methods

```typescript
// In flow handlers
defineFlow(orderState.pending, {
  confirm: (state) => {
    if (!state.paymentVerified) {
      return Result.reject("Payment not verified");
    }

    if (state.items.length === 0) {
      return Result.ignore("No items in order");
    }

    try {
      validateOrder(state);
      return orderState.confirmed(state);
    } catch (error) {
      return Result.error(error);
    }
  }
});

// In state handlers
sm.addEnterHandler(orderState.processing, (state) => {
  return Result.transition(async () => {
    try {
      await processPayment(state);
      await updateInventory(state);
      return Result.ok();
    } catch (error) {
      return Result.error(error);
    }
  }, 10000); // 10 second timeout
});
```

## Type Utilities

TypeScript utilities for extracting type information:

### Infer

Extracts property types from states, variants, or signals.

```typescript
type UserProps = Infer<typeof userState>;        // State properties
type ActiveProps = Infer<typeof userState.active>; // Variant properties  
type SignalArgs = Infer<typeof updateSignal>;    // Signal arguments
```

`Infer` is the only type utility exported from `@state-flow/core`. The following are internal helpers (not re-exported from the package entry point):
- `ExtractVariants<T>` - Get variant names *(internal, not exported)*
- `ExtractSignals<T>` - Get signal types *(internal, not exported)*
- `ExtractName<T>` - Get state name *(internal, not exported)*
- `ArrayToRecord<T>` - Convert state array to record *(internal, not exported)*

## Error Types

StateFlow uses custom errors for framework issues:

```typescript
class StateFlowError extends Error {
  name: "StateFlowError";
}
```

Common errors:
- Redefining flows for same state variant
- Dispatching signals during active transitions  
- Invalid state configuration (missing name/variants)

The StateFlow API provides type-safe, comprehensive feedback for predictable state management.
