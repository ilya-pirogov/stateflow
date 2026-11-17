---
title: Design Principles
description: Core philosophy and design decisions behind StateFlow
---

StateFlow rests on a few decisions: state is immutable and changes only through signals, every signal gets an explicit result, reducers decide while handlers only apply, and every change can be seen. {% .lead %}

## The Three Pillars

### 1. Consistent State

State is deep-frozen and changes only through signals. A target takes one dispatch at a time through its lock, and each step commits whole or not at all.

```typescript
const profileSignals = { rename: defineSignal<{ name: string }>("rename") };

const profileState = defineState<{ name: string; email: string }>()
  .name("profile")
  .signals(profileSignals)
  .variant("active", { initial: true })
  .build();

defineFlow(profileState.active, { rename: (s, { name }) => ({ ...s, name }) });

const user = profileState.active({ name: "Alice", email: "alice@example.com" });
// user.name = "Bob"; // a type error, and a TypeError at run time

// The only way to change it is a signal.
{
  await using send = await lock(app);
  await send(profileSignals.rename({ name: "Bob" })).done();
}
```

### 2. Explicit Feedback

Every send returns a `Result`: `OK`, `Ignored`, `Rejected`, `Error`, or `InTransition` while a declared transition runs. `expect(...kinds)` names the kinds the caller accepts and throws a `StateFlowError` for any other; on a pending result it applies to the outcome, at `done()`.

```typescript
const userSignals = { login: defineSignal<{ email: string; password: string }>("login") };

const userState = defineState<{ id: string; email: string }>()
  .name("user")
  .signals(userSignals)
  .variant("guest", { initial: true })
  .variant("authenticated")
  .build();

try {
  await using send = await lock(app);
  await send(userSignals.login({ email, password })).expect(ResultKind.OK).done();
} catch (error) {
  // The message says what the result was: "... was rejected: Message: invalid email".
  console.warn(`login not accepted: ${error}`);
}
```

### 3. Visibility

Every instance prints as `<state>.<variant>(<props>)`, each dispatch writes log entries with its changes and each handler's result, and observers, watches, events and subscribers are told of each commit.

```typescript
const mediaState = defineState<{ position: number; duration: number }>()
  .name("media")
  .variant("paused", { initial: true })
  .variant("playing")
  .stringRepr((s) => `${s.position}/${s.duration}s`)
  .build();

const media = mediaState.playing({ position: 30, duration: 180 });
String(media); // "media.playing(30/180s)"
String(stateVar(media)); // "media.playing"

using playing = observe(app, [mediaState.playing], (state) => console.log(`at ${state.position}s`));
```

## Core Design Decisions

### Immutability by Default

Building an instance freezes its props deeply. State is also flat: every prop holds frozen data, a nested state, or a [`Box`](/docs/boxing-live-resources), an opaque handle to a live resource that cannot be frozen. Reducers may place a Box but never read it: `deref()` throws inside a reducer, as dispatching does.

```typescript
const accountState = defineState<{
  user: { id: string; preferences: { theme: string } };
  sessions: Array<{ id: string; active: boolean }>;
}>()
  .name("account")
  .variant("loaded", { initial: true })
  .build();

const loaded = accountState.loaded({
  user: { id: "u1", preferences: { theme: "dark" } },
  sessions: [{ id: "s1", active: true }],
});
Object.isFrozen(loaded.user.preferences); // true
```

The price: every change builds new objects, usually by spreading the old props.

### Dispatch Through `lock()` and `send()`

A caller takes the target's lock and sends through it. Locks are served in the order they were asked for, and while a declared transition is pending, the holder's sends queue behind it:

```typescript
{
  await using send = await lock(app);
  await send(mediaSignals.play()).expect(ResultKind.OK).done();
  await send(mediaSignals.seek({ position: 30 })).done(); // same critical section, in order
} // the lock is released at the end of the scope, once no transition is pending
```

- **`expect()` is applied at `done()`** on a pending result, so a send that may declare a transition chains `.done()`: `await send(signal).expect(...).done()`.
- **`dispatch` is deprecated.** It throws under a held lock or a pending transition, and stays for what a lock cannot do: a synchronous teardown, a dispatch before any lock exists, and the abort of a transition that another caller's lock holds (`{ abort: true }` skips the lock).
- **A follow-up on the same target belongs to the same dispatch:** every state a signal concerns has its own reducer for it, a parent decides its nested states, and an entry that waits for the world is a declared transition. A follow-up on another target takes that target's lock.

### The Reducer Decides, the Handler Applies

The decision, what the next state is and whether a request is allowed, lives in the pure reducers. A handler only applies an approved state to the world, and it cannot choose the next state: a synchronous dispatch to its own target throws, and a declared transition's work only succeeds or refuses, while its reducer named both ends.

- **A handler can only refuse.** An exit, update or enter handler's Rejected or throw refuses the step, and the target goes where its reducer said: to the failed it named, or, without one, nowhere: it stays as it was.
- **Data from the world enters props one way:** a handler returns a named result of the variant it enters or updates, `driverState.active.results.loaded({ manifest })`, and the variant's result reducer folds it into props.
- **Failed is the floor.** The failed step's own handlers cannot stop its commit, and the reason reaches the failed state as the built-in `FAILURE` result (see [Failure States](/docs/state-consistency#failure-states)).
- **Asynchronous entry is declared on the variant.** `.variant("active", { async: true })` says where the state is defined that entering `active` waits for the world. A node enters it only at the end of a declared transition, and only such a variant takes transition handlers.
- **Releases follow the commit.** Enter and update handlers get the step's `AbortSignal`, which aborts when the step does not commit, so they release what they made. What a step replaces is released after the commit, in a commit delegate (`HandlerResult.ok().onCommit(release)`) or by the engine for a `DisposableBox`. Written this way, a refused step leaves the world as it leaves the state.
- **Handlers can be switched off.** `setHandlersDisabled(true)` is read at every handler call: a run then shows what the reducers decide, with no handler touching the world, and `mockHandlers` supplies the world's answers a test needs (see [Testing](/docs/testing)).

```typescript
// quality.ts
import { defineFlow, defineSignal, defineState, StateResult } from "@state-flow/core";

type QualityProps = {
  qualities: Array<{ name: string; id: string }>;
  currentId: string | null;
};

export const qualitySignals = { setQuality: defineSignal<{ name: string }>("setQuality") };

export const quality = defineState<QualityProps>()
  .name("quality")
  .signals(qualitySignals)
  .variant("active", { initial: true })
  .build();

// The decision, pure: the refusal, the state as it is, or the new current quality.
function resolve(s: QualityProps, name: string): QualityProps | StateResult {
  const q = s.qualities.find((x) => x.name === name);
  if (q === undefined) {
    return StateResult.rejected(`unknown quality: ${name}`);
  }
  return q.id === s.currentId ? s : { ...s, currentId: q.id };
}

defineFlow(quality.active, { setQuality: (s, { name }) => resolve(s, name) });
```

```typescript
// The handler applies what the reducer approved, and nothing else.
sm.addUpdateHandler(quality.active, (s) => {
  if (s.currentId !== null) {
    switchTo(s.currentId);
  }
  return HandlerResult.ok();
});
```

An unknown quality is Rejected before any effect runs, and the current one returns the instance the reducer was given, which changes nothing and runs no handler. A rule that several reducers could break, "the player stays paused while the source is not ready", is a plain function that each reducer it concerns calls on the snapshot from before the signal (`ctx.read("source")`).

### Type Safety

Payloads, props, reducers and handlers are typed from the definitions:

```typescript
const updateUser = defineSignal<{ id: string; name?: string; email?: string }>("updateUser");

// updateUser({ name: "Alice" }); // error: id is missing
// updateUser({ id: "123", age: 30 }); // error: age is not a field
const signal = updateUser({ id: "123", name: "Alice" });
```

- A reducer's state and payload are typed by its variant and signal; its answer must be its own state's.
- A handler is typed by its variant, so it can return only that variant's named results.
- `ctx.read("name")` is typed by the flow's definitions when the state declares them (`defineState<Props, Defs>()`), and `isIn(instance, "variant")` checks the variant names.

### Composition Over Inheritance

Behavior is built from small, focused states, each with its own signals, reducers and handlers:

```typescript
const playbackState = defineState<{ position: number }>().name("playback").variant("stopped", { initial: true }).build();
const volumeState = defineState<{ level: number }>().name("volume").variant("audible", { initial: true }).build();

// The target holds one prop per state, under the state's name.
interface MediaPlayer {
  playback: Infer<typeof playbackState>;
  volume: Infer<typeof volumeState>;
}
```

States compose in depth too: a prop may hold another state's instance, or an `Items` of them, and those nested states take signals and run handlers like top-level ones, while their parent decides which of them exist (see [Nested States](/docs/core-concepts#nested-states)).

### Explicit Over Implicit

An observer names the variants it follows and, optionally, what counts as a change; a watch names its predicate over the whole flow:

```typescript
using auth = observe(
  app,
  [userState.authenticated, userState.guest],
  (state) => updateUi(state),
  (prev, cur) => prev.id !== cur.id,
);

using userWatch = watch(
  app,
  (cur, prev) => stateVar(cur.user) !== stateVar(prev.user),
  (cur) => console.log(`user is ${String(stateVar(cur.user))}`),
);
```

### Fail Fast

A misuse fails at once, with a message that names it: a second `defineFlow` for a variant throws, an answer that breaks a rule of the plan is an Error before any handler runs, and a refusal says why:

```typescript
defineFlow(userState.guest, {
  login: (s, { email, password }) => {
    if (!email.includes("@")) {
      return StateResult.rejected("invalid email");
    }
    if (password.length < 8) {
      return StateResult.rejected("the password needs 8 characters");
    }
    return userState.authenticated({ ...s, email });
  },
});
// defineFlow(userState.guest, { ... }); // throws: Flow is already defined: user.guest [SF093] Call defineFlow once per variant, with all its reducers.
```

## Key Principles in Practice

1. **Design the states first:** their props and variants, then the signals each takes.
2. **Name signals for their intent.**
3. **Send through `lock()`,** and chain `.expect(...).done()`.
4. **Let the reducer decide:** validation and resolution in pure reducers; handlers apply, read their `(state, snapshot, prev, key)` arguments rather than the target, and bring the world's data in as named results.
5. **Release after the commit:** a commit delegate or a `DisposableBox` for what a step replaces, the step's `AbortSignal` for what a refused step made.
6. **Let the types work:** declare payloads, props and the flow's definitions, and let the compiler check the rest.
