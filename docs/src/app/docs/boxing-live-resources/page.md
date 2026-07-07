---
title: Boxing Live Resources
description: Holding live resources in flat state with Box, and the reducer no-deref rule
---

StateFlow state is *flat*: every prop is either deeply-frozen value data or an opaque `Box` handle — nothing mutable in between. Live resources that cannot be frozen (a `MediaStream`, a socket, a DOM element) live in a `Box`. {% .lead %}

## Flat state

Every constructed state is **deep-frozen** — nested objects and arrays included, not just the
top-level container. `sealProps` walks a state's props on construction and recursively freezes
every plain object and array it finds, so no part of a committed state can be mutated after the
fact:

```typescript
const state = playerState.loaded({
  source: { url: "https://example.com/video.mp4", bitrate: 4000 },
  chapters: [{ id: "intro", start: 0 }],
});

Object.isFrozen(state); // true
Object.isFrozen(state.source); // true — nested object, frozen too
Object.isFrozen(state.chapters); // true
Object.isFrozen(state.chapters[0]); // true — array elements too
```

This is what makes state genuinely safe to hand out: an observer, a subscriber, or a UI layer
can hold a reference to `state.source` and know it will never change under it.

Deep-freezing only reaches plain objects and arrays. Two kinds of values are exempt by design:

- **`Box`** — an intentionally-unfrozen handle for a live resource. See below.
- **`FrozenSet` / `FrozenMap`** — already-immutable collection types; they are branded and
  skipped rather than walked, since walking a `Set`/`Map` structurally doesn't make sense.

A raw `Set`, `Map`, or live class instance placed directly in a prop is not what you want in
flat state — use `FrozenSet`/`FrozenMap` for collections and `Box` for live resources. StateFlow
dev-warns when it encounters an un-boxed, un-frozen class instance it can't safely freeze.

## Box — an opaque owned handle

`Box.of(resource)` wraps a live value so it can sit in state without being frozen (freezing a
`MediaStream` or a WebSocket would break it). The box itself is frozen and branded; only its
*interior* stays live.

```typescript
import { Box } from "@state-flow/core";

const camera = Box.of(mediaStream);
```

Read the wrapped value with `deref()`:

```typescript
const stream = camera.deref(); // returns the live MediaStream
stream.getTracks().forEach((t) => t.stop());
```

`deref()` is legal from an enter/exit/update handler or an observer — anywhere side effects are
allowed. It **throws a `StateFlowError` inside a reducer**:

```typescript
defineFlow(cameraState.active, {
  stop: (state) => {
    state.stream.deref(); // throws StateFlowError — reducers are pure
  },
});
```

A reducer may still *place* a `Box` in the next state — construction and re-wrapping are fine,
only reading the interior is forbidden. See [The reducer borrow rule](#the-reducer-borrow-rule)
below.

Compare boxes with `equals`, never `===`:

```typescript
camera.equals(otherBox); // reference-identity on the wrapped value
camera === Box.of(mediaStream); // false — Box.of always mints a new wrapper
```

Each box has a stable `id` (`"Box#3"`) and a `displayName` resolved from
`opts.displayName` → `value.constructor.displayName` → `value.constructor.name` → `"Box"`.
Boxes serialize (in logs, template strings, `serializeValue`) as `Box(<displayName>#<n>)`, e.g.
`Box(MediaStream#3)` — never dumping the live resource's contents.

## FrozenSet and FrozenMap

Use `FrozenSet` / `FrozenMap` for set/map-shaped props instead of a raw `Set`/`Map`. They extend
the native classes (so `has`/`get`/`size`/iteration behave normally) but throw on any mutator:

```typescript
import { FrozenSet, FrozenMap } from "@state-flow/core";

const state = deviceState.ready({
  capacities: new FrozenSet(["audio", "video"]),
  limits: new FrozenMap([["bitrate", 4000]]),
});

state.capacities.has("audio"); // true
state.capacities.add("screen"); // throws StateFlowError
state.limits.get("bitrate"); // 4000
state.limits.set("bitrate", 8000); // throws StateFlowError
```

`FrozenSet` additionally exposes `intersection` / `symmetricDifference`, which return plain,
mutable `Set` instances for further manipulation outside of state.

## The reducer borrow rule

Reducers (`defineFlow` handlers) must be pure: given the same state and signal, they always
produce the same result, with no side effects. Two operations that would break that guarantee
are blocked at runtime, regardless of `try`/`catch`:

- **`Box.deref()` inside a reducer throws.** Reading a live resource is a side effect — the
  resource could change between calls, and a reducer's job is to compute a *value*, not to
  react to the outside world. A reducer may still construct or forward a `Box` (`Box.of(x)`, or
  simply place an existing `Box` in the returned state) — it just cannot look inside one.
- **Dispatching from inside a reducer throws.** A reducer that dispatches would recursively
  re-enter the flow it's currently computing a transition for — `dispatch`/`lock`/`send` all
  throw a `StateFlowError` when called synchronously from within a reducer.

Both rules are enforced by the same mechanism: StateFlow tracks "currently running a reducer"
as a module-private flag around the single call site where reducers execute
(`handleSignal`), so the check works regardless of how deep the call stack is — there's no way
to launder a `deref()` or a `dispatch()` through a helper function and have it go unnoticed.

If you need the live value to drive a transition, read it in an `applyFlow` enter/update
handler (or an observer/subscriber) and pass the *result* — not the live resource — into the
signal that triggers the reducer.
