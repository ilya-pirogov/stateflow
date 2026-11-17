import errorCodes from "./error-codes.json";
import type { StateSignal } from "./signal";
import type { StateDefinition, StateVariant } from "./state";
import { VARIANT } from "./symbols";

/**
 * The props of a state definition or variant, or the payload of a signal definition: what its factory takes; unknown
 * for a signal without one. The payload is read from the factory's parameter: matched against SignalDefinition, whose
 * check does not distribute, a union payload would infer never.
 */
export type Infer<T> =
  T extends StateDefinition<infer TProps, infer _TVariants, infer _TSignals, infer _TName, infer _TResults>
    ? TProps
    : T extends StateVariant<
          infer TProps,
          infer _TVariants,
          infer _TSignals,
          infer _TName,
          infer _TVariant,
          infer _TResults
        >
      ? TProps
      : T extends (props: infer TArgs) => StateSignal
        ? TArgs
        : never;

// biome-ignore lint/complexity/noBannedTypes: Utility function accepts any function type
export function buildName(ctx: unknown, func?: Function): string {
  let fnName: unknown = null;
  let ctxName: unknown = null;

  if (func != null) {
    fnName =
      Symbol.toStringTag in func && func[Symbol.toStringTag] !== "AsyncFunction" ? func[Symbol.toStringTag] : func.name;
  }

  if (ctx != null && typeof ctx === "object") {
    // A null-prototype object (Object.create(null)) has no constructor.
    ctxName = Symbol.toStringTag in ctx ? ctx[Symbol.toStringTag] : ctx.constructor?.name;
  }

  if (ctxName == null) {
    return String(fnName);
  } else if (fnName == null) {
    return String(ctxName);
  }

  if (String(fnName).startsWith(String(ctxName))) {
    return String(fnName);
  }
  return `${ctxName}.${fnName}`;
}

/**
 * An error the engine raises. Its message is the text the engine wrote, then always the same form: one space, the
 * message's code in brackets, one space, the short fix of that code's entry in error-codes.json ("Lock has been
 * released [SF020] Send only inside the lock's scope; ..."). `code` is that code. Codes are "SF" and three digits,
 * never reused or renumbered. An error that wraps another (expect(), a transition's failed reason, an abort whose
 * reducer failed) has its own code and fix; the error it wraps, when it was given one as `inner`, is its `cause`.
 * Nothing checks that a code fits its text: a test of the engine's source does.
 */
export class StateFlowError extends Error {
  readonly code: string;

  /**
   * @param code - the code of `message`, a key of error-codes.json, whose fix the message ends with
   * @param inner - an error this one wraps: it becomes this one's cause, and its stack this one's
   */
  constructor(code: string, message: string, inner: Error | null = null) {
    super(`${message} [${code}] ${(errorCodes as Record<string, { fix: string }>)[code].fix}`);
    this.name = "StateFlowError";
    this.code = code;

    if (inner != null) {
      this.cause = inner;
      this.stack = inner.stack;
    }
  }
}

/**
 * Why a transition's AbortSignal aborted: the reason of every abort of the signal its transition handlers get. On
 * every kind the result of the work will not commit, so a handler releases what it acquired:
 * - `aborted`: an abort of the transition (`send(signal, { abort: true })`) was accepted: "aborted by <signal>".
 * - `timeout`: the work outlasted its timeoutMs, and the failed end has run.
 * - `disposed`: disposeFlow ran during the work.
 * - `failed`: a handler of the work refused or failed, or every handler succeeded and the end step did not commit
 *   (a handler refused it, a result reducer failed, a DisposableBox rule broke, or a string form threw while it
 *   was logged), and the failed end has run: "failed: <the refusal's message>".
 */
export class TransitionAborted extends StateFlowError {
  readonly kind: "aborted" | "timeout" | "disposed" | "failed";

  constructor(kind: TransitionAborted["kind"], code: string, message: string) {
    super(code, message);
    this.name = "TransitionAborted";
    this.kind = kind;
  }
}

const maxArrayItems = 10;
const maxStringLen = 25;
const maxDepth = 3;

interface FlattenResult {
  path: string[];
  value: unknown;
}

const SPACES_REGEX = /\s/;
const BRACKETS_REGEX = /[{}[\]=]/;

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

export function isPlainObject(val: unknown): val is object {
  if (!isObject(val)) {
    return false;
  }

  const proto = Object.getPrototypeOf(val);
  return proto === null || proto === Object.prototype;
}

/** Whether `value` is a promise or any other object with a `then` method, as `await` reads one. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function getClassName(val: object): string {
  const proto = Object.getPrototypeOf(val);
  if (proto?.constructor?.name != null) {
    return proto.constructor.name;
  }
  return "Object";
}

function isUrlLike(val: object): boolean {
  return getClassName(val) === "URL" && typeof (val as { href?: unknown }).href === "string";
}

// DOM Event duck-check: state-flow compiles DOM-lib-free, so no `instanceof Event` — a string
// `type` plus an `*Event` constructor name identifies one.
function isEventLike(val: object): boolean {
  return typeof (val as { type?: unknown }).type === "string" && getClassName(val).endsWith("Event");
}

/**
 * True for the class instances sealProps accepts in a prop by freezing them IN PLACE (shallow):
 * `Error`, `RegExp`, URL-like and Event-like values. sealProps asks only about a value that is not
 * frozen yet: a frozen one, a FrozenSet or FrozenMap included, it trusts as immutable before it gets here.
 */
export function isImmutableValueLike(val: unknown): boolean {
  if (val === null || typeof val !== "object") {
    return false;
  }
  if (val instanceof Error || val instanceof RegExp) {
    return true;
  }
  return isUrlLike(val) || isEventLike(val);
}

/**
 * A plain object or array of data. A state instance is a plain object too, but it prints by its string form (see
 * serializeValue), so the flattening of single-property objects and the inlining of array entries stop at one.
 */
function isPlainData(val: unknown): val is object {
  return isPlainObject(val) && !Reflect.has(val, VARIANT);
}

function flattenPath(val: unknown, path: string[] = [], depthBudget: number = maxDepth): FlattenResult {
  if (isPlainData(val) && depthBudget > 0) {
    const keys = Reflect.ownKeys(val).filter((k): k is string => typeof k === "string");
    if (keys.length === 1) {
      const key = keys[0];
      if (key !== undefined) {
        const nextVal = Reflect.get(val, key);
        return flattenPath(nextVal, [...path, key], depthBudget - 1);
      }
    }
  }
  return { path, value: val };
}

function serializeValue(val: unknown, depth: number = 0): string {
  // Null/undefined
  if (val === null) {
    return "N";
  }
  if (val === undefined) {
    return "U";
  }

  // Boolean
  if (typeof val === "boolean") {
    return val ? "T" : "F";
  }

  // Number
  if (typeof val === "number") {
    return String(val);
  }

  // String
  if (typeof val === "string") {
    let str = val;

    // Truncate if too long
    if (str.length > maxStringLen) {
      str = `${str.slice(0, maxStringLen)}…`;
    }

    // Check if needs quotes - use single quotes for strings with spaces
    const hasSpaces = SPACES_REGEX.test(str);
    const hasSpecialChars = BRACKETS_REGEX.test(str);

    if (hasSpaces || hasSpecialChars) {
      // Use single quotes, escape single quotes inside
      return `'${str.replace(/'/g, "\\'")}'`;
    }

    return str;
  }

  // Array
  if (Array.isArray(val)) {
    // Inline single primitive values
    if (val.length === 1) {
      const first = val[0];
      if (
        first === null ||
        first === undefined ||
        typeof first === "number" ||
        typeof first === "boolean" ||
        typeof first === "string"
      ) {
        return serializeValue(first, depth + 1);
      }
    }

    let items: unknown[] = val;
    let truncated = false;

    // Truncate long arrays
    if (val.length > maxArrayItems) {
      items = val.slice(0, maxArrayItems);
      truncated = true;
    }

    const serialized = items.map((item) => {
      if (isPlainData(item)) {
        // Check depth limit
        if (depth >= maxDepth) {
          return "{...}";
        }

        const depthBudget = maxDepth - depth - 1;
        const entries = Reflect.ownKeys(item)
          .filter((k): k is string => typeof k === "string")
          .map((k) => {
            const v = Reflect.get(item as object, k);
            const { path, value } = flattenPath(v, [], depthBudget);
            const fullPath = path.length > 0 ? `${k}.${path.join(".")}` : k;
            return `${fullPath}=${serializeValue(value, depth + 1 + path.length)}`;
          });
        return entries.length === 1 ? entries[0] : `{${entries.join(" ")}}`;
      }
      return serializeValue(item, depth + 1);
    });

    // Use space separator in arrays
    const result = serialized.join(" ");
    return `[${result}${truncated ? ` …+${val.length - maxArrayItems}` : ""}]`;
  }

  // Object
  if (isObject(val)) {
    // Check if it's a Date
    if (val instanceof Date) {
      return val.toISOString();
    }

    // Check for Symbol.toPrimitive BEFORE plain object check. A nested state instance prints by its string form
    // too; at depth 0 the instance is the one whose string form is being built (serializeDebug is the default
    // stringRepr), so it prints its props instead of calling itself.
    if (Reflect.has(val, Symbol.toPrimitive) && (depth > 0 || !Reflect.has(val, VARIANT))) {
      return String(val);
    }

    // Native containers print their entries, not an opaque {ClassName}.
    if (val instanceof Map) {
      if (depth >= maxDepth) {
        return `Map(${val.size}){...}`;
      }
      let entries = [...val.entries()];
      const dropped = entries.length - maxArrayItems;
      if (dropped > 0) {
        entries = entries.slice(0, maxArrayItems);
      }
      const body = entries.map(([k, v]) => `${serializeValue(k, depth + 1)}=${serializeValue(v, depth + 1)}`);
      return `Map(${val.size}){${body.join(" ")}${dropped > 0 ? ` …+${dropped}` : ""}}`;
    }

    if (val instanceof Set) {
      if (depth >= maxDepth) {
        return `Set(${val.size}){...}`;
      }
      let items = [...val.values()];
      const dropped = items.length - maxArrayItems;
      if (dropped > 0) {
        items = items.slice(0, maxArrayItems);
      }
      const body = items.map((item) => serializeValue(item, depth + 1));
      return `Set(${val.size}){${body.join(" ")}${dropped > 0 ? ` …+${dropped}` : ""}}`;
    }

    if (val instanceof Error) {
      // name(message) with the standard string truncation; parens already delimit,
      // so the message is not re-quoted.
      let message = val.message;
      if (message.length > maxStringLen) {
        message = `${message.slice(0, maxStringLen)}…`;
      }
      return `${val.name}(${message})`;
    }

    if (val instanceof RegExp) {
      return String(val);
    }

    if (val instanceof ArrayBuffer) {
      return `ArrayBuffer(${val.byteLength})`;
    }

    if (ArrayBuffer.isView(val)) {
      const length = (val as { length?: number }).length ?? val.byteLength;
      return `${getClassName(val)}(${length})`;
    }

    // DOM Event duck-check: state-flow compiles DOM-lib-free, so no instanceof
    // Event — a string `type` plus an *Event constructor name identifies one.
    if (isEventLike(val)) {
      return `${getClassName(val)}(${(val as { type: string }).type})`;
    }

    // URL duck-check (same DOM-free constraint): constructor name + href.
    if (isUrlLike(val)) {
      return serializeValue((val as { href: string }).href, depth);
    }

    // Check if it's a plain object or a custom class instance
    if (!isPlainObject(val)) {
      // Custom class - show {ClassName}
      const className = getClassName(val);
      return `{${className}}`;
    }

    // Check depth limit for plain objects
    if (depth >= maxDepth) {
      return "{...}";
    }

    // Plain object - serialize properties
    const depthBudget = maxDepth - depth - 1;
    const entries = Reflect.ownKeys(val)
      .filter((k): k is string => typeof k === "string")
      .map((k) => {
        const v = Reflect.get(val as object, k);
        const { path, value } = flattenPath(v, [], depthBudget);
        const fullPath = path.length > 0 ? `${k}.${path.join(".")}` : k;
        return `${fullPath}=${serializeValue(value, depth + 1 + path.length)}`;
      });

    // Use space separator for all objects
    return depth === 0 ? entries.join(" ") : `{${entries.join(" ")}}`;
  }

  // Fallback for other types
  return String(val);
}

export function serializeDebug(obj: unknown): string {
  if (obj == null) {
    return "";
  }

  return serializeValue(obj);
}
