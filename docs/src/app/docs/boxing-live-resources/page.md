---
title: Boxing Live Resources
description: Holding live resources in flat state with Box, and the reducer no-deref rule
---

State is flat: every prop holds deep-frozen data, a nested state, or a `Box`, an opaque handle to a live resource such as a `MediaStream`, a socket or a DOM element. A `DisposableBox` is a Box whose resource the engine disposes once the committed states no longer hold it. {% .lead %}

## Flat state

Building an instance freezes its props deeply, every plain object and array at any depth, so no part of a committed state changes afterwards. An observer, a subscriber or a view may keep a reference to any part of it.

```typescript
const playerState = defineState<{
  source: { url: string; bitrate: number };
  chapters: Array<{ id: string; start: number }>;
}>()
  .name("player")
  .variant("loaded", { initial: true })
  .build();

const state = playerState.loaded({
  source: { url: "https://example.com/video.mp4", bitrate: 4000 },
  chapters: [{ id: "intro", start: 0 }],
});

Object.isFrozen(state); // true
Object.isFrozen(state.source); // true
Object.isFrozen(state.chapters[0]); // true
```

What the freeze leaves alone, and what it refuses:

- A `Box` is frozen itself; the resource inside stays live.
- A value that is frozen already, such as a `FrozenSet` or a `FrozenMap`, is trusted as immutable: the freeze only looks inside it for nested states.
- An `Error`, a `RegExp`, a `URL` or a DOM event is frozen in place and kept.
- Any other class instance, a raw `Set` or `Map` included, is refused: building the instance throws a `StateFlowError`.
- A nested state goes directly in a prop, as an instance or an `Items`. One inside an array, a plain object, a `FrozenMap` or a `FrozenSet` is refused.

## Box

`Box.of(resource)` wraps a live value so that state can hold it unfrozen. `deref()` returns it:

```typescript
const camera = Box.of(mediaStream);

camera.deref().getTracks().forEach((track) => track.stop());
```

`deref()` works everywhere except in reducer code: in a signal reducer, a result reducer or the key function of a keyed `Items` it throws a `StateFlowError` (see [The reducer borrow rule](#the-reducer-borrow-rule)). A reducer may still build a Box and place it in the state it returns.

`Box.of` makes a new wrapper on every call, so boxes compare with `equals`, which compares the wrapped values:

```typescript
camera.equals(Box.of(mediaStream)); // true
camera === Box.of(mediaStream); // false
```

Each box has an `id` (`"Box#3"`) and a `displayName`: `opts.displayName`, else the value's `constructor.displayName`, else its `constructor.name`, else `"Box"`. Its string form, in log entries and in `serializeDebug`, is `Box(MediaStream#3)`: it never prints the resource. `isBox(value)` tells a Box from any other value.

## DisposableBox

`DisposableBox.of(value)` boxes a value that has `Symbol.dispose` or `Symbol.asyncDispose`. It is a Box in every other way: a reducer may place it, `deref()` follows the same rule, and `isBox` is true. The engine disposes the value:

- **After every step**, it disposes each box the step carried that no node of the committed states holds after it: those of the instances the step replaced or planned, and those of the named results its handlers returned, as the result's data or in its data's props. After a commit this runs once the step's commit delegates and commit handlers ran, so they still see the resource open. A refused step's boxes go with those of the step into failed after it, once that step's commit delegates and commit handlers ran, or at once when it changes nothing: a box that next and failed both hold stays, since the failed commits it.
- **When a declared transition does not reach its next**, it disposes the boxes of that next and of the work's results that no node holds; the transition handler adds no listener for them (see [World values in props](#world-values-in-props)).
- **At `disposeFlow`**, it disposes every box the final states hold.

It calls `Symbol.dispose`, or else `Symbol.asyncDispose` without awaiting it, once per value; a throw or a rejection goes to `console.error`. The switch `setHandlersDisabled` does not stop this: the disposal is no handler. A box a reducer placed, from a signal's payload say, is disposed too when its step is refused and the failed does not hold it; a dispatch that its reducers or the plan refuse runs no step, and the box stays the caller's.

A handler that replaces a resource therefore leaves both releases to the engine. Here the update handler opens a connection to the new url: the old connection is disposed once the step commits, and the new one when the step does not commit:

```typescript
interface Connection extends Disposable {
  send(data: string): void;
}

function parseConnected(data: unknown): { conn: DisposableBox<Connection> } {
  const conn = (data as { conn?: unknown } | null)?.conn;
  if (!(conn instanceof DisposableBox)) {
    throw new TypeError("connected takes the connection in a DisposableBox");
  }
  return { conn };
}

const linkSignals = {
  connect: defineSignal<{ url: string }>("connect"),
  drop: defineSignal("drop"),
};

const link = defineState<{ url: string; conn: DisposableBox<Connection> | null }>()
  .name("link")
  .signals(linkSignals)
  .variant("down", { initial: true })
  .variant("up", { results: { connected: parseConnected } })
  .build();

defineFlow(link.down, { connect: (s, { url }) => link.up({ url, conn: null }) });
defineFlow(
  link.up,
  {
    connect: (s, { url }) => ({ ...s, url }),
    // Leaving up drops the connection: the engine disposes it once this step commits.
    drop: (s) => link.down({ ...s, conn: null }),
  },
  { connected: (s, { conn }) => ({ ...s, conn }) },
);

const app = { link: { url: "", conn: null } };

applyFlow(app, [link], (sm) => {
  sm.addEnterHandler(link.up, (s) =>
    link.up.results.connected({ conn: DisposableBox.of(openConnection(s.url)) }),
  );
  sm.addUpdateHandler(link.up, (s) =>
    link.up.results.connected({ conn: DisposableBox.of(openConnection(s.url)) }),
  );
});
```

The states hold a box when any node holds it in an own prop, top-level or nested: a box moved to another node, into a nested state or to another key of an `Items` stays open, and so does a value wrapped anew, since two boxes of one value are one box (`equals`). The engine reads each prop's value without calling a getter, and looks neither under a symbol key nor into an array or an object inside a prop: a box there is neither checked nor disposed, so a DisposableBox goes directly in a prop.

Before any handler runs, the plan refuses a dispatch, with an Error that names the places, when one set of states it may commit, taken whole (next, a failed, a declared transition's temp, its next or its failed end):

- holds one box in two places;
- holds a box the engine disposed already;
- for a transition's next or failed end, holds a box the committed states hold and the temp drops: the temp's commit would dispose it.

A step other than a step into failed is refused the same way before its commit, with an Error that names the places, when the named results of its handlers, a transition's work's at its end, fold in and other states take them, and that leaves one box in two places or places a disposed one: two states' result reducers that store one box from one named result, say. A transition's end is checked so even with nothing to fold, since its next stands on the temp as it committed: a box the temp step's fold dropped, which the temp's commit disposed, may stand in next again.

## World values in props

A value the world gives, such as a socket, lives in a prop typed `Box<T> | null` (or `DisposableBox<T> | null`) whose default is `null`. The reducer that declares the entry builds the instance with the default; the handler that gets the value returns it as a named result of the variant it enters; the variant's result reducer puts it into props.

```typescript
function parseOpened(data: unknown): { wire: DisposableBox<Connection> } {
  const wire = (data as { wire?: unknown } | null)?.wire;
  if (!(wire instanceof DisposableBox)) {
    throw new TypeError("opened takes the connection in a DisposableBox");
  }
  return { wire };
}

const transport = defineState<{ wire: DisposableBox<Connection> | null }>()
  .name("transport")
  .signals({ open: defineSignal("open"), close: defineSignal("close") })
  .variant("closed", { initial: true })
  .variant("opening", { transitional: true })
  .variant("open", { async: true, results: { opened: parseOpened } })
  .build();

// The reducer builds next with the default...
defineFlow(transport.closed, {
  open: (t) => StateResult.transition(transport.open({ wire: null }), transport.opening(t), transport.closed(t)),
});
// ...and the result reducer fills it. Leaving open drops the connection, which the engine disposes after the commit.
defineFlow(transport.open, { close: () => transport.closed({ wire: null }) }, { opened: (t, { wire }) => ({ ...t, wire }) });

const connection = { transport: { wire: null } };

applyFlow(connection, [transport], (sm) => {
  sm.addTransitionHandler(transport.open, async (next, snapshot, prev, key, signal) => {
    const wire = await connect({ signal });
    // In a DisposableBox the connection is the engine's: it disposes it at every end that does not commit it, also
    // when this result settles after the signal aborted.
    return transport.open.results.opened({ wire: DisposableBox.of(wire) });
  });
});
```

Once `open` commits, the step that leaves `open` disposes the connection. With a plain `Box`, the work releases the connection itself on every abort of its signal, and an exit handler of `open` releases it: at once, before the commit, so also in a step that a later handler refuses, and once more when the failed step after that one leaves `open` too.

## FrozenSet and FrozenMap

`FrozenSet` and `FrozenMap` extend the native classes, so `has`, `get`, `size` and iteration work as usual, and every mutator throws a `StateFlowError`:

```typescript
const device = defineState<{ capacities: FrozenSet<string>; limits: FrozenMap<string, number> }>()
  .name("device")
  .variant("ready", { initial: true })
  .build();

const ready = device.ready({
  capacities: new FrozenSet(["audio", "video"]),
  limits: new FrozenMap([["bitrate", 4000]]),
});

ready.capacities.has("audio"); // true
ready.limits.get("bitrate"); // 4000
// ready.capacities.add("screen") and ready.limits.set("bitrate", 8000) throw
```

`FrozenSet` also has `intersection` and `symmetricDifference`, which return plain, mutable `Set`s.

## The reducer borrow rule

Reducers are pure: the same state and signal give the same answer, and nothing else happens. Two calls would break that, and both throw a `StateFlowError` inside reducer code (signal reducers, result reducers, the key functions of keyed `Items`):

- **`Box.deref()`.** A live resource can change between two calls, so reading it is not a pure computation. Building a Box and placing one in the next state are allowed.
- **Dispatching.** `dispatch`, a lock's `send` and `disposeFlow` would re-enter the flow whose answer the reducer is computing. On a disposed flow a send answers `Rejected` instead, as it dispatches nothing (see [disposeFlow](/docs/api-reference#dispose-flow)).

The engine marks the time a reducer runs, so a call through a helper function throws too. A throw that leaves the reducer is its Error result, and nothing commits.

When a decision needs a live value, a handler or an observer reads it and passes on the result, not the resource: as a named result's data, or in a signal it sends once its own dispatch has returned (a synchronous dispatch to its own target throws).
