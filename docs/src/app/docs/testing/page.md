---
title: Testing
description: Testing strategies and patterns for StateFlow applications
---

Testing StateFlow applications requires understanding how to verify state transitions, signal handling, and asynchronous operations. This guide covers comprehensive testing strategies from unit tests to integration testing. {% .lead %}

{% callout title="Illustrative excerpts" %}
Many snippets below are excerpts that build on shared setup — identifiers like `signals`, `app`, `userState`/`playerState`/`connectionState`, types like `MyApp`/`AuthService`, and helpers like `useStateFlow` are assumed from earlier examples or your own test harness, and `vi` comes from `vitest`. They illustrate a pattern rather than compile standalone.
{% /callout %}

## Testing Philosophy

StateFlow's deterministic design makes testing straightforward:

- **State transitions are pure functions** - Easy to test in isolation
- **The reducer decides** - validation and resolution live in the pure flow, so you can assert invalid → `Rejected` and redundant → no-op with no real side effects
- **Signals provide explicit feedback** - Clear assertions on results
- **Immutable states** - No side effects to worry about
- **Type safety** - Compile-time guarantees reduce runtime test complexity

## Unit Testing State Definitions

### Testing State Builders

Start by testing your state definitions are constructed correctly:

```typescript
import { describe, test, expect } from 'vitest';
import { defineState } from '@state-flow/core';

describe('UserState', () => {
  test('should build state with correct variants', () => {
    const userState = defineState<{ id: string; name: string }>()
      .name("user")
      .signals(signals)
      .variant("guest", true)
      .variant("authenticated")
      .variant("admin")
      .build();

    // Test state factory functions exist
    expect(typeof userState.guest).toBe('function');
    expect(typeof userState.authenticated).toBe('function');
    expect(typeof userState.admin).toBe('function');

    // Test state creation
    const guestUser = userState.guest({ id: '', name: 'Guest' });
    expect(guestUser.id).toBe('');
    expect(guestUser.name).toBe('Guest');
  });

  test('should freeze state instances', () => {
    const userState = defineState<{ name: string }>()
      .name("user")
      .signals(signals)
      .variant("active", true)
      .build();

    const user = userState.active({ name: 'Alice' });
    
    // Should be frozen
    expect(Object.isFrozen(user)).toBe(true);
    expect(() => {
      (user as any).name = 'Bob';
    }).toThrow();
  });
});
```

### Testing Signal Definitions

Verify your signals are created with correct types and parameters:

```typescript
describe('UserSignals', () => {
  const signals = {
    login: defineSignal<{ email: string; password: string }>("login"),
    logout: defineSignal("logout"),
    updateProfile: defineSignal<{ name?: string; email?: string }>("updateProfile")
  };

  test('should create parameterized signals correctly', () => {
    const loginSignal = signals.login({ 
      email: 'test@example.com', 
      password: 'secret' 
    });

    expect(loginSignal[Symbol.toStringTag]).toBe('login');
    expect(loginSignal.email).toBe('test@example.com');
    expect(loginSignal.password).toBe('secret');
  });

  test('should create parameterless signals correctly', () => {
    const logoutSignal = signals.logout();
    
    expect(logoutSignal[Symbol.toStringTag]).toBe('logout');
  });
});
```

## Testing State Flows

### Unit Testing Flow Handlers

Test your flow logic in isolation:

```typescript
import { applyFlow, defineFlow, lock, Result, ResultKind, stateVar } from '@state-flow/core';

const signals = {
  login: defineSignal<{ email: string; password: string }>("login"),
  failedLogin: defineSignal("failedLogin")
};

const userState = defineState<{
  id: string;
  email: string;
  loginAttempts: number;
}>()
  .name("user")
  .signals(signals)
  .variant("guest", true)
  .variant("authenticated")
  .variant("locked")
  .build();

defineFlow(userState.guest, {
  login: (state, signal) => {
    // Mock authentication
    if (signal.password === 'correct') {
      return userState.authenticated({
        id: 'user123',
        email: signal.email,
        loginAttempts: 0
      });
    }
    return Result.reject('Invalid credentials');
  },
  failedLogin: (state) => {
    const newAttempts = state.loginAttempts + 1;
    if (newAttempts >= 3) {
      return userState.locked({ ...state, loginAttempts: newAttempts });
    }
    return { ...state, loginAttempts: newAttempts };
  }
});

describe('UserFlow', () => {
  // Flows are exercised by dispatching signals against an applied flow object.
  // applyFlow seeds the initial variant; lock() gives a queued `send()` dispatcher.
  function createApp() {
    const app = { user: { id: '', email: '', loginAttempts: 0 } };
    applyFlow(app, [userState], () => {});
    return app;
  }

  test('should handle successful login', async () => {
    const app = createApp();

    await using send = await lock(app);
    const result = await send(signals.login({
      email: 'test@example.com',
      password: 'correct'
    })).done();

    expect(result.kind).toBe(ResultKind.OK);
    expect(String(stateVar(app.user))).toBe('user.authenticated');
    expect(app.user.id).toBe('user123');
    expect(app.user.email).toBe('test@example.com');
  });

  test('should reject invalid login', async () => {
    const app = createApp();

    await using send = await lock(app);
    const result = await send(signals.login({
      email: 'test@example.com',
      password: 'wrong'
    })).done();

    expect(result.kind).toBe(ResultKind.Rejected);
    expect(result.message).toBe('Invalid credentials');
  });

  test('should handle account locking', async () => {
    const app = createApp();

    await using send = await lock(app);

    await send(signals.failedLogin()).done();
    expect(app.user.loginAttempts).toBe(1);

    await send(signals.failedLogin()).done();
    await send(signals.failedLogin()).done();
    expect(String(stateVar(app.user))).toBe('user.locked');
  });
});
```

### Testing the Reducer's Decisions

Because the reducer holds the decision logic — validate, resolve, redundancy/readiness (see
*Reducer Decides, Handler Applies* in the Architecture Guide) — every branch is a pure function
you can assert with no real side effects. Test the *decision* on the `Result` and the *effect*
separately:

```typescript
test('setQuality rejects an unknown quality once the list is loaded', async () => {
  const app = { player: { qualities: [{ name: 'hd' }], preferredQuality: null, pendingSourceUrl: null } };
  applyFlow(app, [playerState], () => {});

  await using send = await lock(app);
  const r = await send(signals.setQuality({ name: 'does-not-exist' })).done();

  expect(r.kind).toBe(ResultKind.Rejected);     // invalid selection → rejected by the FLOW
  expect(String(stateVar(app.player))).toBe('player.playing'); // nothing changed
});

test('a redundant setQuality fires no effect (the handler stays thin)', async () => {
  const applied = vi.fn();
  applyFlow(app, [playerState], (sm) =>
    sm.addUpdateHandler(playerState.playing, (state) => {
      if (state.pendingSourceUrl != null) applied(state.pendingSourceUrl); // thin: apply only
      return Result.ok();
    }),
  );

  await using send = await lock(app);
  await send(signals.setQuality({ name: currentlyAppliedName })).done();

  expect(applied).not.toHaveBeenCalled();        // reducer resolved no pending value → no effect
});
```

That is the payoff of the pattern: the *decision* is asserted on the Result/state, and the
*effect* is asserted to fire only when the reducer resolved a real change — the two halves test
independently.

## Integration Testing

### Testing Full Application Flow

Test complete scenarios with `applyFlow`:

```typescript
import { applyFlow, lock, sync } from '@state-flow/core';

describe('User Authentication Flow', () => {
  let app: { user: UserProps };
  let mockAuthService: AuthService;

  beforeEach(() => {
    app = {
      user: { id: '', email: '', loginAttempts: 0 }
    };

    mockAuthService = {
      authenticate: vi.fn(),
      logout: vi.fn()
    };

    applyFlow(app, [userState], (sm) => {
      sm.addEnterHandler(userState.authenticated, (state) => {
        return Result.transition(async () => {
          await mockAuthService.authenticate(state.email);
          return Result.ok();
        }, 1000);
      });

      sm.addExitHandler(userState.authenticated, (state) => {
        mockAuthService.logout();
        return Result.ok();
      });
    });
  });

  test('should complete full login flow', async () => {
    // Mock successful authentication
    mockAuthService.authenticate.mockResolvedValue({ token: 'abc123' });

    // Dispatch login signal and wait for completion
    await using send = await lock(app);
    await send(signals.login({
      email: 'test@example.com',
      password: 'correct'
    })).expect(ResultKind.OK).done();

    // Verify state change
    expect(String(stateVar(app.user))).toBe('user.authenticated');
    expect(app.user.email).toBe('test@example.com');

    // Verify side effect was called
    expect(mockAuthService.authenticate).toHaveBeenCalledWith('test@example.com');
  });

  test('should handle authentication failure', async () => {
    // Mock authentication failure
    mockAuthService.authenticate.mockRejectedValue(new Error('Auth failed'));

    // The guest.login flow handler returns Result.reject synchronously for a bad
    // password, so assert the Rejected result directly (mirroring 'should reject
    // invalid login'); the mocked authenticate is never reached.
    await using send = await lock(app);
    const r = await send(signals.login({
      email: 'test@example.com',
      password: 'wrong'
    })).done();
    expect(r.kind).toBe(ResultKind.Rejected);
    expect(r.message).toBe('Invalid credentials');

    expect(String(stateVar(app.user))).toBe('user.guest');
  });
});
```

## Testing Async Operations

### Testing State Transitions with Timeouts

```typescript
describe('Async State Transitions', () => {
  test('should handle timeout in async operations', async () => {
    const connectionState = defineState<{ url: string }>()
      .name("connection")
      .signals(signals)
      .variant("disconnected", true)
      .variant("connecting")
      .variant("connected")
      .build();

    const app = { connection: { url: '' } };

    applyFlow(app, [connectionState], (sm) => {
      sm.addEnterHandler(connectionState.connecting, (state) => {
        return Result.transition(async () => {
          // Simulate long operation
          await new Promise(resolve => setTimeout(resolve, 2000));
          return Result.ok();
        }, 100); // Short timeout
      });
    });

    // The transition times out and resolves to an Error result; expect(ResultKind.OK)
    // makes done() throw so the rejection can be asserted.
    await using send = await lock(app);
    await expect(
      send(signals.connect({ url: 'wss://test.com' })).expect(ResultKind.OK).done()
    ).rejects.toThrow(/timeout/);
  });

  test('should wait for all transitions with sync()', async () => {
    // Queue multiple async operations under a lock so the second dispatch waits
    // instead of throwing while the first transition is still in flight.
    await using send = await lock(app);
    await send(signals.action1()).done();
    await send(signals.action2()).done();

    // Wait for all to complete using sync
    await sync(app);
  });
});
```

## Testing State Observers

### Testing Observer Behavior

```typescript
describe('State Observers', () => {
  test('should call observer on state changes', async () => {
    const mockObserver = vi.fn();
    const app = { counter: { count: 0 } };

    applyFlow(app, [counterState], () => {});

    using observer = observe(app, [counterState.active], mockObserver);

    // Dispatch state change and wait for completion
    await using send = await lock(app);
    await send(signals.increment()).done();

    expect(mockObserver).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1 })
    );
  });

  test('should respect custom comparison function', async () => {
    const mockObserver = vi.fn();
    const app = { user: { id: '123', name: 'Alice', lastSeen: Date.now() } };

    using observer = observe(
      app,
      [userState.active],
      mockObserver,
      (prev, curr) => prev.name !== curr.name // Only observe name changes
    );

    // Update lastSeen (should not trigger observer)
    await using send = await lock(app);
    await send(signals.updateLastSeen({ timestamp: Date.now() })).done();
    expect(mockObserver).not.toHaveBeenCalled();

    // Update name (should trigger observer)
    await send(signals.updateName({ name: 'Bob' })).done();
    expect(mockObserver).toHaveBeenCalled();
  });
});
```

## Testing Error Conditions

### Testing Error Scenarios

```typescript
describe('Error Handling', () => {
  test('should handle exceptions in flow handlers', async () => {
    defineFlow(userState.authenticated, {
      corruptData: () => {
        throw new Error('Data corruption detected');
      }
    });

    // The thrown error is captured as an Error result; expect(ResultKind.OK)
    // makes done() rethrow it so the rejection can be asserted.
    await using send = await lock(app);
    await expect(
      send(signals.corruptData()).expect(ResultKind.OK).done()
    ).rejects.toThrow('Data corruption detected');
  });

  test('should handle exceptions in state handlers', async () => {
    applyFlow(app, [userState], (sm) => {
      sm.addEnterHandler(userState.authenticated, () => {
        throw new Error('Handler failed');
      });
    });

    // The handler error is captured as an Error result; expect(ResultKind.OK)
    // makes done() rethrow it so the rejection can be asserted.
    await using send = await lock(app);
    await expect(
      send(signals.login({ email: 'test@example.com', password: 'correct' })).expect(ResultKind.OK).done()
    ).rejects.toThrow('Handler failed');
  });
});
```

## Framework-Specific Testing

### React Component Testing

```typescript
import { render, fireEvent, waitFor } from '@testing-library/react';

function UserProfile({ app }: { app: MyApp }) {
  const user = useStateFlow(app, [userState.authenticated, userState.guest]);
  
  if (!user) return null;
  
  return (
    <div>
      <span data-testid="user-name">{user.name}</span>
      <button 
        data-testid="logout"
        onClick={async () => {
          await using send = await lock(app);
          await send(signals.logout()).done();
        }}
      >
        Logout
      </button>
    </div>
  );
}

test('should update UI when user state changes', async () => {
  const app = createTestApp();
  
  const { getByTestId } = render(<UserProfile app={app} />);
  
  // Initial state
  expect(getByTestId('user-name')).toHaveTextContent('Guest');
  
  // Login
  {
    await using send = await lock(app);
    await send(signals.login({ email: 'test@example.com', password: 'correct' })).done();
  }
  
  await waitFor(() => {
    expect(getByTestId('user-name')).toHaveTextContent('test@example.com');
  });
  
  // Logout
  fireEvent.click(getByTestId('logout'));
  
  await waitFor(() => {
    expect(getByTestId('user-name')).toHaveTextContent('Guest');
  });
});
```

## Test Utilities

### Creating Test Helpers

```typescript
// test-utils.ts
import { applyFlow, sync } from '@state-flow/core';
import { vi } from 'vitest';

export function createTestApp(initialState?: Partial<MyApp>): MyApp {
  const app: MyApp = {
    user: { id: '', email: '', loginAttempts: 0 },
    connection: { status: 'disconnected', retryCount: 0 },
    ...initialState
  };

  applyFlow(app, [userState, connectionState], () => {
    // Minimal setup for testing
  });

  return app;
}

export function waitForTransition(app: MyApp): Promise<void> {
  return sync(app);
}

export function getStateString(app: MyApp, stateName: keyof MyApp): string {
  return String(app[stateName]);
}

// Mock services for testing
export const createMockAuthService = (): AuthService => ({
  authenticate: vi.fn().mockResolvedValue({ token: 'test' }),
  logout: vi.fn().mockResolvedValue(void 0)
});
```

## Best Practices

### Testing Strategies

1. **Start with unit tests** for individual flows and state logic
2. **Use integration tests** for complete user scenarios
3. **Test error conditions** explicitly - don't assume happy paths
4. **Mock external dependencies** but test state transitions
5. **Use type checking** to catch issues at compile time
6. **Test async operations** with proper timeout handling

### Common Patterns

```typescript
// Group related tests by state or feature
describe('MediaPlayer', () => {
  describe('PlaybackState', () => {
    // Test playback state flows
  });
  
  describe('VolumeState', () => {
    // Test volume state flows
  });
  
  describe('Integration', () => {
    // Test state coordination
  });
});

// Use descriptive test names
test('should transition to playing state when play signal dispatched from paused state', () => {
  // Test implementation
});

// Test both success and failure cases
describe('when user login', () => {
  test('should authenticate with valid credentials', () => {});
  test('should reject invalid credentials', () => {});
  test('should lock account after repeated failures', () => {});
});
```

This comprehensive testing approach ensures your StateFlow applications are robust, maintainable, and behave predictably under all conditions.