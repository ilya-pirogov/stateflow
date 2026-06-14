---
title: State Visibility
description: Understanding and debugging application state through comprehensive visibility features
---

StateFlow provides comprehensive visibility into your application's state through built-in string representations, extensive logging capabilities, and observable state changes. This transparency is essential for debugging complex applications and understanding system behavior at runtime. {% .lead %}

## The Visibility Challenge

Complex applications often suffer from opaque state that makes debugging difficult. Developers struggle to understand what state the application is in, how it got there, and why certain behaviors occur. StateFlow addresses these challenges through systematic visibility features built into the core architecture.

Traditional debugging approaches often require extensive console logging, debugger breakpoints, or external tooling. StateFlow integrates visibility directly into the state management system, providing immediate insight without additional instrumentation. This built-in transparency reduces debugging time and helps developers understand application behavior more quickly.

## String Representations

Every state in StateFlow can provide a human-readable string representation, making it immediately clear what state the application is in during debugging sessions.

### Defining String Representations

String representations are defined as part of the state definition using the `stringRepr` method. This method receives the current state instance and returns a formatted string that captures the essential information about that state.

```typescript
const connectionState = defineState<{
  url: string;
  attemptCount: number;
  lastError?: Error;
  connectedAt?: number;
}>()
  .name("connection")
  .signals(connectionSignals)
  .variant("disconnected", true)
  .variant("connecting")
  .variant("connected")
  .variant("failed")
  .stringRepr(state => {
    const baseInfo = `${state.url} (attempts: ${state.attemptCount})`;
    
    if (state.lastError) {
      return `${baseInfo} - Error: ${state.lastError.message}`;
    }
    
    if (state.connectedAt) {
      const duration = Date.now() - state.connectedAt;
      return `${baseInfo} - Connected for ${Math.round(duration / 1000)}s`;
    }
    
    return baseInfo;
  })
  .build();
```

### Automatic String Conversion

StateFlow automatically uses these representations when converting states to strings, making debugging output immediately useful:

```typescript
const state = connectionState.connecting({
  url: "wss://api.example.com",
  attemptCount: 2
});

console.log(String(state));
// Output: "connection.connecting(wss://api.example.com (attempts: 2))"

// The format includes:
// - State definition name: "connection"
// - Current variant: "connecting"
// - Custom string representation in parentheses
```

### Value Truncation

StateFlow automatically truncates long values in string representations to maintain readability:

```typescript
const dataState = defineState<{
  payload: string;
  items: any[];
  metadata: Record<string, any>;
}>()
  .name("data")
  .signals(dataSignals)
  .variant("loaded")
  .build();

const state = dataState.loaded({
  payload: "x".repeat(50), // Long string
  items: new Array(100).fill(0), // Large array
  metadata: Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`key${i}`, i])
  ) // Large object
});

console.log(String(state));
// The default serializer (serializeDebug) abbreviates long values:
// - Strings > 25 chars are truncated and suffixed with "…"
// - Arrays > 10 items show the first 10 followed by " …+N"
// - Nested objects/arrays deeper than the depth limit collapse to "{...}"
```

## Comprehensive Logging

StateFlow provides detailed logging for every state transition, signal dispatch, and handler execution. This logging system captures the complete flow of state changes through your application.

### Log Entry Structure

Each state flow operation generates a comprehensive log entry containing all relevant information about the operation:

```typescript
interface StateFlowLogEntry {
  // Operation identification
  flowName: string;        // Name of the flow (e.g., "mediaPlayer")
  signal: string;          // Signal that triggered the operation
  message: string;         // Formatted message suitable for logging
  startTime: number;       // Timestamp when operation began
  duration?: number;       // Duration for async operations
  
  // State information
  finalStates: Record<string, string>;  // All states after operation
  stateChanges: Array<{                 // Detailed state transitions
    stateName: string;
    oldState: string;
    newState: string;
  }>;
  
  // Handler execution details
  handlerResults: Array<{
    type: "enter" | "exit" | "update" | "rollback";
    handlerName: string;
    stateName: string;
    result: string;
  }>;
  
  // Observer notifications
  observers: Array<{
    observerName: string;
    stateName: string;
    needObserve: boolean;
  }>;
  
  // Signals enqueued by handlers during this operation
  enqueuedSignals: Array<{
    signal: string;
    fromHandler: string;
  }>;
  
  // Result information
  finalResult: string;     // Final operation result
  isAsync: boolean;        // Whether operation was asynchronous
  // CompactStackTrace is an internal type and is not exported from the
  // package; treat entry.stacktrace as opaque in handler code.
  stacktrace: CompactStackTrace | null; // Stack trace for errors
  
  // Optional diagnostics set by the engine
  dispatchOrder?: number;     // Monotonic per-page dispatch-start order
  duringTransition?: boolean; // Dispatch started during an unresolved async transition
  groupLabel?: string;        // Set under a labeled lock(target, label)
  dispatchContext?: string;   // Snapshot from a registered dispatch-context provider
}
```

### Custom Log Handlers

StateFlow allows custom log handlers to integrate with your preferred logging infrastructure:

```typescript
const customLogHandler: StateFlowLogHandler = (entry) => {
  // Send to external logging service
  if (entry.finalResult.includes("Error")) {
    errorReporter.logError({
      message: entry.message,
      context: {
        signal: entry.signal,
        states: entry.finalStates,
        duration: entry.duration
      },
      stackTrace: entry.stacktrace
    });
  }
  
  // Custom formatting for development
  if (process.env.NODE_ENV === "development") {
    console.group(`🔄 ${entry.signal} → ${entry.finalResult}`);
    entry.stateChanges.forEach(change => {
      console.log(`📊 ${change.stateName}:`, 
        String(change.oldState), "→", String(change.newState)
      );
    });
    console.groupEnd();
  }
};

// Apply custom logging
applyFlow(app, [mediaState], (sm) => {
  // Handler setup
}, {
  logHandlers: [customLogHandler]
});
```

### Structured Logging Output

The built-in `consoleLogHandler` is enabled by default but is silenced under vitest (which sets `process.env.VITEST`); call `setConsoleLogSilenced(false)` to force it on, while custom/structured handlers always still receive every entry. It provides structured output that groups related information:

```
[SF/mediaPlayer] play{} - OK
  State: media.paused(position=0/duration=180) => media.playing(position=0/duration=180)
    enter startPlayback() => OK
    observed by updateUIState() => true
  
  Final States:
    media: media.playing(position=0/duration=180)
    buffer: buffer.active(level=0.2)
```

## State Observation

StateFlow's observation system provides real-time visibility into state changes, enabling reactive UI updates and debugging insights.

### Basic Observation

Observers are notified whenever specified state variants change:

```typescript
const observer = observe(
  app,
  [connectionState.connected, connectionState.failed],
  (state) => {
    console.log(`Connection state changed: ${String(state)}`);
    
    // Update debugging UI
    debugPanel.updateConnectionStatus({
      variant: state[Symbol.toStringTag],
      data: state,
      timestamp: Date.now()
    });
  }
);

// Cleanup when debugging session ends
observer[Symbol.dispose]();
```

### Filtered Observation

Custom comparison functions enable fine-grained observation of specific state changes:

```typescript
// Only notify when specific fields change
observe(
  app,
  [dataState.loaded],
  (state) => {
    console.log(`Page changed to: ${state.currentPage}`);
  },
  (previous, current) => previous.currentPage !== current.currentPage
);

// Monitor error accumulation
observe(
  app,
  [apiState.retrying],
  (state) => {
    if (state.errorCount > 3) {
      console.warn("Multiple API failures detected", state.errors);
    }
  },
  (prev, curr) => curr.errorCount > prev.errorCount
);
```

### Debugging with Observers

Observers can be strategically placed to understand application flow:

```typescript
function enableDebugMode() {
  // Monitor all state transitions
  const allStates = [
    authState.loggedOut, authState.loggingIn, authState.loggedIn,
    dataState.idle, dataState.loading, dataState.loaded, dataState.error
  ];
  
  const debugObserver = observe(
    app,
    allStates,
    (state) => {
      const stateInfo = {
        timestamp: new Date().toISOString(),
        state: String(state),
        variant: state[Symbol.toStringTag],
        data: JSON.stringify(state, null, 2)
      };
      
      // Update debug panel
      debugPanel.addStateTransition(stateInfo);
      
      // Log to console with formatting
      console.log(
        `%c[${stateInfo.timestamp}] ${stateInfo.state}`,
        'color: blue; font-weight: bold'
      );
    }
  );
  
  return debugObserver;
}
```

## Runtime Introspection

StateFlow provides mechanisms for inspecting application state at runtime, useful for debugging tools and development interfaces.

### State Inspection

Current state can be inspected without triggering changes:

```typescript
function inspectApplicationState(app: any) {
  const stateInfo = {};
  
  // Extract all current states
  for (const key in app) {
    const value = app[key];
    if (isState(value)) {
      stateInfo[key] = {
        variant: value[Symbol.toStringTag],
        string: String(value),
        data: { ...value } // Shallow copy of state data
      };
    }
  }
  
  return stateInfo;
}

// Use in debugging console
window.debugStateFlow = () => {
  const info = inspectApplicationState(app);
  console.table(info);
  return info;
};
```

### Signal History Tracking

Track signal dispatch history for debugging:

```typescript
class SignalHistory {
  private history: Array<{
    signal: string;
    timestamp: number;
    result: ResultKind;
    duration?: number;
  }> = [];
  
  createLogHandler(): StateFlowLogHandler {
    return (entry) => {
      this.history.push({
        signal: entry.signal,
        timestamp: entry.startTime,
        result: this.parseResult(entry.finalResult),
        duration: entry.duration
      });
      
      // Keep last 100 entries
      if (this.history.length > 100) {
        this.history.shift();
      }
    };
  }
  
  getHistory() {
    return this.history;
  }
  
  findPattern(pattern: RegExp) {
    return this.history.filter(entry => 
      pattern.test(entry.signal)
    );
  }
  
  private parseResult(result: string): ResultKind {
    if (result.includes("OK")) return ResultKind.OK;
    if (result.includes("Rejected")) return ResultKind.Rejected;
    if (result.includes("Error")) return ResultKind.Error;
    if (result.includes("Ignored")) return ResultKind.Ignored;
    return ResultKind.InTransition;
  }
}
```

## Development Tools Integration

StateFlow's visibility features integrate well with development tools and debugging workflows.

### Browser DevTools Integration

Create custom formatters for browser DevTools:

```typescript
// Enable custom formatters in Chrome DevTools settings
window.devtoolsFormatters = [{
  header: (obj) => {
    if (isState(obj)) {
      return ["div", { style: "color: #880088" }, 
        `StateFlow: ${String(obj)}`
      ];
    }
    return null;
  },
  
  hasBody: (obj) => isState(obj),
  
  body: (obj) => {
    // Object.entries only returns enumerable string keys; StateFlow's
    // symbol-keyed metadata (Symbol.toStringTag, VARIANT, ...) is excluded.
    const props = Object.entries(obj)
      .map(([key, value]) => 
        ["div", { style: "margin-left: 20px" },
          ["span", { style: "color: #0066cc" }, key + ": "],
          ["span", {}, JSON.stringify(value)]
        ]
      );
    
    return ["div", {}, ...props];
  }
}];
```

### Time-Travel Debugging

Build time-travel debugging by tracking state history:

```typescript
class StateHistory {
  private snapshots: Array<{
    timestamp: number;
    signal: string;
    states: Record<string, any>;
  }> = [];
  
  captureSnapshot(entry: StateFlowLogEntry) {
    this.snapshots.push({
      timestamp: entry.startTime,
      signal: entry.signal,
      states: { ...entry.finalStates }
    });
  }
  
  replayToIndex(app: any, index: number) {
    if (index < 0 || index >= this.snapshots.length) {
      throw new Error("Invalid snapshot index");
    }
    
    const snapshot = this.snapshots[index];
    console.log(`Replaying to: ${snapshot.signal} at ${new Date(snapshot.timestamp)}`);
    
    // Note: This is a simplified example
    // Real implementation would need to properly restore state instances
    Object.assign(app, snapshot.states);
  }
}
```

Through these visibility features, StateFlow ensures that developers can always understand what state their application is in, how it got there, and why specific behaviors occur. This transparency is fundamental to building and maintaining complex applications with confidence.
