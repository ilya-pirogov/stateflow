---
title: Installation
description: Get started with StateFlow in your project
---

StateFlow is designed to integrate seamlessly into modern TypeScript projects. This guide will walk you through installation, configuration, and your first setup. {% .lead %}

## Package Installation

StateFlow is available through npm and other package managers:

{% callout type="note" %}
StateFlow uses ES2023 explicit resource management (`using` / `await using`), so it requires TypeScript 5.2+ and a runtime that supports it (or appropriate transpilation). `Symbol.dispose` / `Symbol.asyncDispose` are polyfilled when missing.
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

StateFlow leverages advanced TypeScript features for type safety. Ensure your `tsconfig.json` includes these settings:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2023", "ESNext.Disposable", "DOM"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "moduleResolution": "Bundler"
  }
}
```

`ESNext.Disposable` in `lib` is what enables the `using` / `await using` syntax, so keep it. The library itself is built with `target: "es2019"`; `ES2020` shown here is simply a safe default for consumers, set it to whatever your runtime supports. `DOM` is only needed for browser applications — omit it for Node-only projects.

### Recommended Compiler Options

- **`strict: true`** (required): Enables all strict type checking — this is the only option StateFlow itself requires (the library's own `tsconfig.json` sets just this).
- **`exactOptionalPropertyTypes: true`** (optional): Prevents `undefined` assignment to optional properties. Best-practice, not required to consume the package.
- **`noUncheckedIndexedAccess: true`** (optional): Adds `undefined` to unchecked index signatures. Best-practice, not required to consume the package.

## Framework Integration

StateFlow works with any TypeScript application, but here are specific integration patterns for popular frameworks:

### React Integration

StateFlow integrates naturally with React through custom hooks:

```typescript
import { useState, useEffect } from 'react';
import { observe, lock, stateVar } from '@state-flow/core';
import type { StateVariant } from '@state-flow/core';
import type { MyApp } from './app-state';
import { playbackState, signals } from './app-state';

// `observe`'s handler receives a STATE INSTANCE (the immutable props snapshot),
// and `compareFn` receives the PROPS. `StateInstance` is not exported, so we type
// the hook around the props shape `T` — a state instance is assignable to it.
function useStateFlow<T>(
  app: MyApp,
  states: StateVariant<T>[],
  compareFn?: (prev: T, curr: T) => boolean
) {
  const [state, setState] = useState<T | null>(null);

  useEffect(() => {
    using observer = observe(app, states, setState, compareFn);
    return () => observer[Symbol.dispose]();
  }, [app, states, compareFn]);

  return state;
}

// Usage in component
function PlayerControls({ app }: { app: MyApp }) {
  const playback = useStateFlow(
    app,
    [playbackState.playing, playbackState.paused],
    (prev, curr) => prev.position !== curr.position
  );

  if (!playback) return null;

  const togglePlayback = async () => {
    await using send = await lock(app);
    await send(signals.togglePlayback()).done();
  };

  return (
    <button onClick={togglePlayback}>
      {String(stateVar(playback)) === 'playback.playing' ? 'Pause' : 'Play'}
    </button>
  );
}
```

### Vue Integration

Vue's reactivity system works well with StateFlow observers:

```typescript
import { ref, onUnmounted } from 'vue';
import { observe } from '@state-flow/core';

export function useStateFlow<T>(
  app: MyApp,
  states: StateVariant<T>[]
) {
  // observe() hands the handler a state instance (the props snapshot), not a variant.
  const state = ref<T | null>(null);

  const observer = observe(app, states, (newState) => {
    state.value = newState;
  });

  onUnmounted(() => {
    observer[Symbol.dispose]();
  });

  return state;
}
```

### Angular Integration

Angular services provide a clean integration pattern:

```typescript
import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { observe } from '@state-flow/core';

@Injectable({
  providedIn: 'root'
})
export class StateFlowService implements OnDestroy {
  private observers: Array<{ [Symbol.dispose](): void }> = [];

  observeState<T>(
    app: MyApp,
    states: StateVariant<T>[]
  ): BehaviorSubject<T | null> {
    // observe() hands the handler a state instance (the props snapshot), not a variant.
    const subject = new BehaviorSubject<T | null>(null);
    
    const observer = observe(app, states, (state) => {
      subject.next(state);
    });
    
    this.observers.push(observer);
    return subject;
  }

  ngOnDestroy() {
    this.observers.forEach(observer => observer[Symbol.dispose]());
  }
}
```

## Build Tool Configuration

### Vite Setup

StateFlow works out-of-the-box with Vite. For optimal performance, consider these configurations:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2020'
  },
  optimizeDeps: {
    include: ['@state-flow/core']
  }
});
```

### Webpack Configuration

For Webpack projects, ensure proper module resolution:

```javascript
// webpack.config.js
module.exports = {
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  }
};
```

## Development Setup

### ESLint Configuration

Enhance your development experience with these ESLint rules:

```json
{
  "extends": ["@typescript-eslint/recommended"],
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/prefer-readonly": "warn",
    "@typescript-eslint/explicit-function-return-type": "warn"
  }
}
```

### IDE Integration

For VS Code, install the TypeScript extension and add these settings:

```json
{
  "typescript.preferences.strictFunctionTypes": true,
  "typescript.preferences.strictNullChecks": true,
  "typescript.preferences.noImplicitAny": true
}
```

## First Steps Checklist

{% callout type="installation" %}
**Quick Start Checklist**

1. ✅ Install StateFlow package
2. ✅ Configure TypeScript with strict mode
3. ✅ Set up your first state definition
4. ✅ Define signal handlers with `defineFlow`
5. ✅ Initialize with `applyFlow`
6. ✅ Test signal dispatch and state transitions
7. ✅ Add observers for UI updates
{% /callout %}

## Minimal Working Example

Here's a complete minimal setup to verify your installation:

```typescript
// app.ts
import { 
  defineState, 
  defineSignal, 
  defineFlow, 
  applyFlow, 
  lock 
} from '@state-flow/core';

// 1. Define signals
const signals = {
  increment: defineSignal("increment")
};

// 2. Define state
const counterState = defineState<{ count: number }>()
  .name("counter")
  .signals(signals)
  .variant("active", true)
  .stringRepr(s => `count=${s.count}`)
  .build();

// 3. Define flow
defineFlow(counterState.active, {
  increment: (state) => ({ count: state.count + 1 })
});

// 4. Create application
const app = {
  counter: { count: 0 }
};

// 5. Apply flow
applyFlow(app, [counterState], () => {
  console.log('StateFlow initialized');
});

// 6. Test dispatch
{
  await using send = await lock(app);
  await send(signals.increment()).done();
}
console.log(`${app.counter}`); // "counter.active(count=1)"
```

Run this example to confirm StateFlow is working correctly in your environment.

## Troubleshooting

### Common Issues

**TypeScript Errors**: Ensure you're using TypeScript 5.2+ (required for `using` / explicit resource management) with strict mode enabled.

**Module Resolution**: If you encounter import errors, check that your bundler supports ES2020 modules.

**Runtime Errors**: Verify that all state variants have corresponding flow definitions before dispatching signals.

### Getting Help

If you encounter issues not covered here:

1. Check the [Core Concepts](/docs/core-concepts) for fundamental understanding
2. Review the [API Reference](/docs/api-reference) for detailed function signatures
3. Examine the [Architecture Guide](/docs/architecture-guide) for complex application patterns

## Next Steps

Now that StateFlow is installed and configured, explore:

- [Core Concepts](/docs/core-concepts) - Understand StateFlow's architecture
- [Signal System](/docs/signal-system) - Learn advanced signal patterns  
- [Media Player Example](/docs/media-player-example) - See a complete implementation
- [Testing](/docs/testing) - Set up testing for your StateFlow application