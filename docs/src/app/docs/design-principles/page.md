---
title: Design Principles
description: Core philosophy and design decisions behind StateFlow
---

StateFlow's architecture is built on fundamental principles that address common pitfalls in state management. Understanding these principles will help you build more predictable, maintainable, and debuggable applications. {% .lead %}

## The Three Pillars

StateFlow is built on three foundational principles that work together to create a robust state management system:

### 1. Guaranteed State Consistency

**Problem**: Traditional state management systems allow mutations from anywhere, leading to race conditions and unpredictable behavior.

**Solution**: StateFlow enforces immutability at both the type level and runtime, making inconsistent states impossible.

```typescript
// Traditional mutable approach (problematic)
const user = { name: 'Alice', email: 'alice@example.com' };
user.name = 'Bob'; // Silent mutation - who changed this and when?
someAsyncFunction(user); // What if this modifies user?

// StateFlow approach (guaranteed consistency)
const userState = defineState<{ name: string; email: string }>()
  .name("user")
  .signals(signals)
  .variant("active", true)
  .build();

const user = userState.active({ name: 'Alice', email: 'alice@example.com' });
// user.name = 'Bob'; // TypeError: Cannot assign to read only property

// Only way to change state is through signals
await using send = await lock(app);
await send(signals.updateName({ name: 'Bob' })).done();
```

**Benefits**:
- **No race conditions**: Only one transition can happen at a time
- **Predictable updates**: All changes go through defined flows
- **Time-travel debugging**: Previous states remain unchanged
- **Safe concurrency**: Multiple observers can safely read state

### 2. Explicit Feedback on Every Operation

**Problem**: Most state systems silently ignore invalid operations or fail without clear feedback.

**Solution**: Every signal dispatch returns an explicit Result that categorizes the outcome.

```typescript
// Traditional approach (silent failures)
store.dispatch(action); // Did this work? Was it ignored? Did it fail?

// StateFlow approach (explicit feedback)
try {
  await using send = await lock(app);
  await send(signals.login({ email, password }))
    .expect(ResultKind.OK, ResultKind.Ignored)
    .done();
  console.log('Login successful');
} catch (error) {
  // A failed expectation throws a StateFlowError whose message describes the
  // outcome (its message contains "was rejected").
  if (error instanceof StateFlowError) {
    console.log(`Login not accepted: ${error.message}`);
  } else {
    console.error(`Login failed: ${error}`);
  }
}
```

**Benefits**:
- **No silent failures**: Every operation provides feedback
- **Clear error messages**: Know exactly what went wrong
- **Async operation tracking**: Monitor long-running transitions
- **Debugging clarity**: Understand system behavior immediately

### 3. Complete State Visibility

**Problem**: Complex applications make it difficult to understand current state and track changes.

**Solution**: StateFlow provides comprehensive introspection tools and human-readable representations.

```typescript
// Built-in state visibility
const mediaState = defineState<{ 
  position: number; 
  duration: number 
}>()
  .name("media")
  .signals(signals)
  .variant("playing")
  .variant("paused", true)
  .stringRepr(s => `${s.position}/${s.duration}s`)
  .build();

const media = mediaState.playing({ position: 30, duration: 180 });
console.log(`${media}`); // "media.playing(30/180s)"
console.log(String(stateVar(media))); // "media.playing"

// Observer patterns for tracking changes
observe(app, [mediaState.playing], (state) => {
  console.log(`Playback position: ${state.position}s`);
});
```

**Benefits**:
- **Clear debugging**: Human-readable state representations
- **Change tracking**: Observers for specific state transitions
- **State introspection**: Know exactly which variant is active
- **Logging integration**: Built-in support for comprehensive logging

## Core Design Decisions

### Immutability by Default

StateFlow chooses immutability as the default because it eliminates an entire class of bugs:

```typescript
// Deep immutability: state is deep-frozen on construction (sealProps)
const state = mediaState.playing({ position: 30, duration: 180 });
Object.isFrozen(state); // true

// Nested objects/arrays are frozen too, automatically — no custom parser needed
const complexState = defineState<{
  user: { id: string; preferences: { theme: string } };
  sessions: Array<{ id: string; active: boolean }>;
}>()
  .name("app")
  .signals(signals)
  .variant("loaded", true)
  .build();

Object.isFrozen(complexState); // true
Object.isFrozen(complexState.user); // true — nested objects are frozen too
```

State is also **flat**: every prop is either deep-frozen value data or an opaque
[`Box`](/docs/boxing-live-resources) handle for a live resource (a `MediaStream`, a socket)
that cannot be frozen. Reducers may place a `Box` in state but must never `deref()` it — that,
like dispatching from inside a reducer, throws — because reducers must stay pure.

**Trade-offs**:
- ✅ **Pros**: No accidental mutations, safe sharing, predictable behavior
- ⚠️ **Cons**: Memory overhead for large objects, requires object spreading for updates

### Signal-Driven Architecture

All state changes must go through signals, creating a clear audit trail:

```typescript
// Bad: Direct mutation
app.user.loginAttempts++;

// Good: Signal-driven change (dispatch via lock() + send() — see "Dispatching" below)
await using send = await lock(app);
await send(signals.incrementLoginAttempts()).done();
```

**Benefits**:
- **Audit trail**: Every change has a named reason
- **Validation**: Centralized place for business rules
- **Testing**: Easy to simulate any sequence of operations
- **Time travel**: Can replay signals to recreate states

### Dispatching: always `lock()` + `send()`

A single `dispatch()` is a footgun once any flow uses async transitions: it throws if a lock
is held or a transition is in flight, which turns an innocent fire-and-forget into an uncaught
rejection. The canonical, race-free pathway is to acquire the lock and `send` through it:

```typescript
// ✅ The pattern to use everywhere
await using send = await lock(app);
await send(signals.play()).expect(ResultKind.OK).done();
await send(signals.seek({ position: 30 })).done(); // same critical section, FIFO-ordered
// lock released automatically at scope exit

// ⚠️ Deprecated: bare dispatch() — throws under a held lock / active transition.
// Reserve it only for the two cases a lock cannot cover: synchronous teardown
// (e.g. `beforeunload`) and pre-lock bootstrap.
dispatch(app, signals.dispose({ reason: "page unloaded" }));
```

Two rules that follow from this:

- **`.expect()` is enforced at `.done()`.** On an async (`InTransition`) result the
  expectation is checked when the transition resolves, so an async dispatch **must** chain
  `.done()` or the expectation is never asserted. Always write `await send(sig).expect(...).done()`.
- **Cross-target follow-ups use `lock(otherTarget)` + `send`**, never a reach-through. A
  small same-target follow-up *state change* can use `Result.enqueue` (at most one per
  handler — see the Signal System guide).

### Decisions Live in the Flow (Reducer Decides, Handler Applies)

StateFlow's deepest principle: the **decision** — what the next state is, whether a transition
is allowed, resolving an input to a concrete value, redundancy/readiness checks — lives in the
**pure `defineFlow` reducer**. The **effect handler** is a *thin applier* that runs only for an
already-validated state and just performs the real side effect. An invalid request is rejected
by the flow **before any effect runs** — the handler is never called for a state that shouldn't
exist.

```typescript
// ❌ Anti-pattern: a thin reducer that stores a raw value, and a fat handler that
//    does all the validation/resolution AND the side effect.
defineFlow(quality.active, {
  setQuality: (s, sig) => quality.active({ ...s, preferred: sig.name }), // just stores a string
});
sm.addUpdateHandler(quality.active, (state) => {
  const q = state.qualities.find((x) => x.name === state.preferred);
  if (q == null) return Result.ok();          // invalid selection silently swallowed
  if (q.id === state.currentId) return Result.ok(); // redundancy buried in the effect
  player.switchTo(q);                          // decision + effect tangled together
  return Result.ok();
});

// ✅ The reducer decides; the handler only applies.
function resolve(s): Result<{ id: string | null }> {
  const q = s.qualities.find((x) => x.name === s.preferred);
  if (q == null) {
    return s.qualities.length > 0
      ? Result.reject(`unknown quality: ${s.preferred}`) // loaded & absent → invalid
      : Result.ok({ id: null });                          // not loaded yet → buffer, retry later
  }
  if (q.id === s.currentId) return Result.ok({ id: null }); // redundant → no-op
  return Result.ok({ id: q.id });                            // a real, valid change → apply
}

defineFlow(quality.active, {
  setQuality: (s, sig) => {
    const r = resolve({ ...s, preferred: sig.name });
    if (r.kind !== ResultKind.OK) return r;     // invalid → Reject; the effect NEVER runs
    const id = r.data?.id ?? null;              // Result.data is TData | null
    return quality.active({ ...s, preferred: sig.name, pendingId: id });
  },
});
sm.addUpdateHandler(quality.active, (state) => {
  if (state.pendingId != null) player.switchTo(state.pendingId); // thin: apply only
  return Result.ok();
});
```

**Benefits**:
- **Invalid requests reject**: `setQuality("does-not-exist")` against a loaded list returns
  `Rejected` — the caller learns it failed and nothing else is touched.
- **Effects can't fire for un-approved state**: a redundant or not-ready selection produces no
  side effect because the reducer set nothing for the handler to apply.
- **Pure and testable in isolation**: supply a state, assert the `Result` — no real work needed.
  The model to copy is a rich reducer (`mediaUpdate`-style) that branches on status and
  validates, not a one-liner that stores a value.

### Type Safety as First-Class Citizen

StateFlow leverages TypeScript's type system to prevent errors at compile time:

```typescript
// Type-safe signal parameters
const updateUser = defineSignal<{
  id: string;
  name?: string;
  email?: string;
}>("updateUser");

// Compile error: missing required 'id' property
// dispatch(app, updateUser({ name: 'Alice' }));

// Compile error: invalid property 'age'
// dispatch(app, updateUser({ id: '123', age: 30 }));

// Correct usage
dispatch(app, updateUser({ id: '123', name: 'Alice' }));
```

**Type Safety Features**:
- **Signal validation**: Parameters checked at compile time
- **State shape enforcement**: State properties match definitions
- **Flow handler signatures**: Automatic type inference for handlers
- **Result type narrowing**: Discriminated unions for result handling

## Architectural Philosophy

### Prefer Composition Over Inheritance

StateFlow encourages building complex behavior through composition of simple states:

```typescript
// Instead of complex inheritance hierarchies
class BasePlayer extends EventEmitter {
  // Complex base class with many responsibilities
}

class VideoPlayer extends BasePlayer {
  // Even more complexity
}

// StateFlow prefers composition
const playbackState = defineState<PlaybackProps>()...;
const volumeState = defineState<VolumeProps>()...;
const qualityState = defineState<QualityProps>()...;

// Composed application
interface MediaPlayer {
  playback: Infer<typeof playbackState>;
  volume: Infer<typeof volumeState>;
  quality: Infer<typeof qualityState>;
}
```

### Explicit Over Implicit

StateFlow makes behavior explicit rather than relying on conventions:

```typescript
// Implicit behavior (hard to understand)
store.subscribe((state) => {
  // When does this run? What triggers it?
  // What if multiple states change?
});

// Explicit behavior (clear intent)
observe(
  app,
  [userState.authenticated, userState.guest], // Specific states
  (state) => updateUI(state), // Clear action
  (prev, curr) => prev.id !== curr.id // Explicit comparison
);
```

### Fail Fast with Clear Messages

StateFlow prefers immediate, clear failures over silent degradation:

```typescript
// Will throw immediately if flow already defined
defineFlow(userState.guest, { /* handlers */ });
defineFlow(userState.guest, { /* different handlers */ }); // StateFlowError

// Will reject with clear message
defineFlow(userState.guest, {
  login: (state, signal) => {
    if (!isValidEmail(signal.email)) {
      return Result.reject("Invalid email format");
    }
    if (signal.password.length < 8) {
      return Result.reject("Password must be at least 8 characters");
    }
    // ... authentication logic
  }
});
```

## StateFlow vs Alternatives

| Feature | Redux | MobX | Zustand | StateFlow |
|---------|-------|------|---------|-----------|
| **Immutability** | Convention | Mutations | Mixed | Enforced |
| **Type Safety** | Setup required | Decorators | Manual | Built-in |
| **Async** | Middleware | runInAction | Manual | Native |
| **Error Feedback** | Silent | Basic | Basic | Explicit |
| **Complexity** | High | Medium | Low | Medium |

## When to Choose StateFlow

**Best for:**
- Complex applications with multiple interacting states
- Teams needing structure and maintainability  
- TypeScript-first development
- Applications requiring comprehensive error handling

**Consider alternatives for:**
- Simple applications with minimal state
- Rapid prototypes
- Teams unfamiliar with TypeScript

## Key Principles in Practice

1. **Design states first** - Define data models and variants before writing flows
2. **Use descriptive signals** - Signal names should clearly indicate their intent  
3. **Dispatch through `lock()` + `send()`** - and chain `.expect(...).done()`; reserve bare `dispatch()` for synchronous teardown / pre-lock bootstrap only
4. **Let the reducer decide** - put validation and resolution in the pure flow; keep effect handlers thin appliers that read the `(state, snapshot)` arguments, never live off `this`
5. **Leverage type safety** - Let TypeScript catch errors at compile time

These principles create applications that are maintainable, debuggable, and predictable over time.