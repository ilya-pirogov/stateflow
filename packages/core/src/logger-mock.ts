import { expect } from "vitest";

import type { StateFlowLogEntry, StateFlowLogHandler } from "./logger";
import { ResultKind } from "./result";
import type { SignalDefinition } from "./signal";
import type { StateVariant } from "./state";

export class MockStateFlowLogger {
  private entries: StateFlowLogEntry[] = [];

  /**
   * Creates a log handler that can be passed to applyFlow
   */
  createHandler(): StateFlowLogHandler {
    return (entry: StateFlowLogEntry) => {
      this.entries.push(entry);
    };
  }

  /**
   * Clears all recorded log entries
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Creates a chainable assertion context for the logs
   */
  get should(): MockStateFlowLoggerAssertions {
    return new MockStateFlowLoggerAssertions(this.entries);
  }
}

class MockStateFlowLoggerAssertions {
  constructor(private entries: StateFlowLogEntry[]) {}

  /**
   * Asserts that at least one log entry has the specified result kind
   */
  haveResult(kind: ResultKind): this {
    const found = this.entries.some((entry) => {
      const resultStr = entry.finalResult;
      return resultStr.startsWith(ResultKind[kind]);
    });

    expect(found, `Expected to find result of kind ${ResultKind[kind]}`).toBe(true);
    return this;
  }

  /**
   * Asserts that a signal was logged, optionally with a specific result
   */
  haveSignal(signal: SignalDefinition<any>, result?: string): this {
    const name = signal[Symbol.toStringTag];
    const found = this.entries.some((entry) => {
      if (!entry.signal.startsWith(name)) {
        return false;
      }
      return !(result != null && !entry.finalResult.includes(result));
    });

    const message = result
      ? `Expected to find signal "${name}" with result containing "${result}"`
      : `Expected to find signal "${name}"`;

    expect(found, message).toBe(true);
    return this;
  }

  /**
   * Asserts that a log entry contains the specified message
   */
  haveMessage(message: string): this {
    const found = this.entries.some((entry) => entry.message.includes(message) || entry.finalResult.includes(message));

    expect(found, `Expected to find message containing "${message}"`).toBe(true);
    return this;
  }

  /**
   * Asserts that a state change occurred between the specified states
   */
  haveStateChange(from: StateVariant, to: StateVariant): this {
    const found = this.entries.some((entry) =>
      entry.stateChanges.some(
        (change) => String(change.oldState).includes(String(from)) && String(change.newState).includes(String(to)),
      ),
    );

    expect(found, `Expected to find state change from "${from}" to "${to}"`).toBe(true);
    return this;
  }

  /**
   * Asserts that a specific handler was called with an optional result check
   */
  haveHandler(
    state: unknown,
    type: "enter" | "exit" | "update" | "rollback",
    handlerName: string,
    result?: string,
  ): this {
    console.log(this.entries[0].handlerResults);
    const found = this.entries.some((entry) =>
      entry.handlerResults.some(
        (handler) =>
          handler.stateName === String(state) &&
          handler.type === type &&
          handler.handlerName === handlerName &&
          (!result || handler.result.includes(result)),
      ),
    );

    const message = result
      ? `Expected to find ${type} handler "${handlerName}" for "${state}" with result containing "${result}"`
      : `Expected to find ${type} handler "${handlerName}" for "${state}"`;

    expect(found, message).toBe(true);
    return this;
  }
}

export const createMockLogger = () => new MockStateFlowLogger();
