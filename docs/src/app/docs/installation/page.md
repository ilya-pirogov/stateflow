---
title: Installation
description: Get started with StateFlow in your project
---

Install the package, set up TypeScript, and run a first flow. {% .lead %}

## Package Installation

{% callout type="note" %}
StateFlow's types need **TypeScript 5.6+**: the handler adders use `NoInfer` (5.4), and `Items` returns
`MapIterator` (5.6). The package is built for ES2020 and polyfills `Symbol.dispose` and `Symbol.asyncDispose`, so it
runs on Node.js 18+ and current browsers. Its only runtime dependency is `events`.
{% /callout %}

### Using npm

```bash
npm install @state-flow/core
```

### Using yarn

```bash
yarn add @state-flow/core
```

### Using pnpm

```bash
pnpm add @state-flow/core
```

## TypeScript Configuration

A `tsconfig.json` for an application that uses StateFlow:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2023", "ESNext.Disposable", "DOM"],
    "strict": true,
    "moduleResolution": "Bundler"
  }
}
```

- **`strict: true`**: the library's sources and the examples on these pages compile under it.
- **`ESNext.Disposable`** provides `Disposable`, `AsyncDisposable` and `Symbol.dispose`, which StateFlow's types and
  the `using` / `await using` syntax of the examples need.
- **`ES2022`** as the target is this example's choice. The published bundle is ES2020, so an application may target
  anything from ES2020 up without a bundler that downlevels dependencies. `ESNext` modules allow the top-level `await`
  of the minimal example below.
- **`DOM`** is for browser applications only.

## Framework Integration

StateFlow needs no adapter: a UI subscribes with `observe()` (or `watch()`, or an event of the flow) and sends
signals through `lock()`. `observe()` checks its variants against the target's type, so each helper below names the
state it watches. The helpers share an `app-state` module:

```typescript
// app-state.ts
import { applyFlow, defineFlow, defineSignal, defineState, type Infer } from "@state-flow/core";

export const signals = { play: defineSignal("play"), pause: defineSignal("pause") };

export const playbackState = defineState<{ position: number }>()
  .name("playback")
  .signals(signals)
  .variant("paused", { initial: true })
  .variant("playing")
  .build();

defineFlow(playbackState.paused, { play: (p) => playbackState.playing(p) });
defineFlow(playbackState.playing, { pause: (p) => playbackState.paused(p) });

export type MyApp = { playback: Infer<typeof playbackState> };

export function createApp(): MyApp {
  const app: MyApp = { playback: { position: 0 } };
  applyFlow(app, [playbackState], () => {});
  return app;
}
```

### React Integration

```tsx {% unchecked="needs React, which this repository does not install" %}
import { useEffect, useState } from "react";
import { isIn, lock, observe, type InstanceOf } from "@state-flow/core";
import { playbackState, signals, type MyApp } from "./app-state";

type Playback = InstanceOf<typeof playbackState>;

function usePlayback(app: MyApp): Playback | null {
  const [playback, setPlayback] = useState<Playback | null>(null);

  useEffect(() => {
    // Not `using`: that would dispose the observer as soon as this callback returns.
    const observer = observe(app, [playbackState.playing, playbackState.paused], setPlayback);
    return () => observer[Symbol.dispose]();
  }, [app]);

  return playback;
}

export function PlayerControls({ app }: { app: MyApp }) {
  const playback = usePlayback(app);
  if (playback === null) {
    return null;
  }

  const toggle = async () => {
    await using send = await lock(app);
    await send(isIn(playback, "playing") ? signals.pause() : signals.play()).done();
  };

  return <button onClick={toggle}>{isIn(playback, "playing") ? "Pause" : "Play"}</button>;
}
```

### Vue Integration

```typescript {% unchecked="needs Vue, which this repository does not install" %}
import { onUnmounted, ref } from "vue";
import { observe, type InstanceOf } from "@state-flow/core";
import { playbackState, type MyApp } from "./app-state";

export function usePlayback(app: MyApp) {
  const playback = ref<InstanceOf<typeof playbackState> | null>(null);

  const observer = observe(app, [playbackState.playing, playbackState.paused], (state) => {
    playback.value = state;
  });
  onUnmounted(() => observer[Symbol.dispose]());

  return playback;
}
```

### Angular Integration

```typescript {% unchecked="needs Angular and RxJS, which this repository does not install" %}
import { Injectable, type OnDestroy } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { observe, type InstanceOf } from "@state-flow/core";
import { playbackState, type MyApp } from "./app-state";

@Injectable({ providedIn: "root" })
export class PlaybackService implements OnDestroy {
  private readonly observers: Disposable[] = [];

  observePlayback(app: MyApp): BehaviorSubject<InstanceOf<typeof playbackState> | null> {
    const subject = new BehaviorSubject<InstanceOf<typeof playbackState> | null>(null);
    this.observers.push(observe(app, [playbackState.playing, playbackState.paused], (state) => subject.next(state)));
    return subject;
  }

  ngOnDestroy(): void {
    for (const observer of this.observers) {
      observer[Symbol.dispose]();
    }
  }
}
```

## Bundlers

The package ships an ES module (`dist/index.mjs`), a CommonJS build (`dist/index.js`) and type declarations, all
for ES2020. A bundler that targets ES2020 or later takes it as it is.

## First Steps Checklist

{% callout type="note" title="Quick Start Checklist" %}
1. Install the package
2. Configure TypeScript 5.6+ with `strict` and `ESNext.Disposable`
3. Define signals and a state
4. Define its reducers with `defineFlow`
5. Put it on a target with `applyFlow`, registering its handlers
6. Send signals through `lock()`
7. Observe the committed states for the UI
{% /callout %}

## Minimal Working Example

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

{
  await using send = await lock(app);
  await send(signals.increment()).done();
}
console.log(`${app.counter}`); // "counter.active(count=1)"
```

## Troubleshooting

- **Type errors in StateFlow's types**: TypeScript older than 5.6, or a `lib` without `ESNext.Disposable`.
- **`State object <name> not found`** from `applyFlow`: the target holds no props under that state's name.
- **`<target> doesn't contain state flows`**: a call on a target that `applyFlow` never set up.
- **`Lock is held`** or **`A transition is pending`** from `dispatch()`: send through `lock()` instead.
- **`Cannot dispatch to <name> from inside its own dispatch`**: a handler sent a signal to its own target; a
  follow-up belongs to the same dispatch (see [Signal system](/docs/signal-system#follow-ups-belong-to-the-same-dispatch)).

## Next Steps

- [Core Concepts](/docs/core-concepts): the model, piece by piece
- [Signal System](/docs/signal-system): signals, results and declared transitions
- [Media Player Example](/docs/media-player-example): a complete application
- [Testing](/docs/testing): simulation with handlers off, mocks and controlled time
