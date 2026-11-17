import type { SignalDefinition } from "./signal";
import type { StateDefinition, StateVariant } from "./state";
import { FROZEN, VARIANT } from "./symbols";

// Compact stacktrace format types

// URL array element in compact format
export type CompactUrlArray = string[];

// Single frame in compact format [urlIndex, line, column]
export type CompactFrame = [number, number, number];

// Array of compact frames
export type CompactFrameArray = CompactFrame[];

// Complete compact stacktrace format
export type CompactStackTrace = [CompactUrlArray, CompactFrameArray];

export type Infer<T> =
  T extends StateDefinition<infer TProps, infer _TVariants, infer _TSignals, infer _TName>
    ? TProps
    : T extends StateVariant<infer TProps, infer _TVariants, infer _TSignals, infer _TName>
      ? TProps
      : T extends SignalDefinition<infer TArgs>
        ? TArgs
        : never;

export function truncate(key: PropertyKey, value: unknown): unknown {
  if (typeof value === "string" && value.length > 15) {
    return `${value.substring(0, 15)}...`;
  }

  if (Array.isArray(value) && value.length > 3) {
    return `[array: ${value.length}] items]`;
  }

  if (typeof value === "object" && value != null && Object.keys(value).length > 5) {
    return `[object: ${Object.keys(value).length} props]`;
  }
  return value;
}

// biome-ignore lint/complexity/noBannedTypes: Utility function accepts any function type
export function buildName(ctx: unknown, func?: Function): string {
  let fnName: unknown = null;
  let ctxName: unknown = null;

  if (func != null) {
    fnName =
      Symbol.toStringTag in func && func[Symbol.toStringTag] !== "AsyncFunction" ? func[Symbol.toStringTag] : func.name;
  }

  if (ctx != null && typeof ctx === "object") {
    ctxName = Symbol.toStringTag in ctx ? ctx[Symbol.toStringTag] : ctx.constructor.name;
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

export class StateFlowError extends Error {
  constructor(message: string, inner: Error | null = null) {
    super(message);
    this.name = "StateFlowError";

    if (inner != null) {
      this.stack = inner.stack;
    }
  }
}

// URL regex - captures file URL, line number, and column number
const urlRegex = /(https?:\/\/[^:]+(?::\d+)?(?:\/[^:]*)*?):(\d+):(\d+)/g;
/**
 * Simplified function that converts a standard stacktrace to a compact format
 * using direct regex parsing instead of adapters
 *
 * @example Input: "Error: Something went wrong\n at https://localhost:8899/static/js/bundle.js:12124:33"
 * @example Output: [["https://localhost:8899/static/js/bundle.js"], [[0, 12124, 33]]]
 */
export function parseCompactStacktrace(stacktrace: string | null): CompactStackTrace | null {
  if (stacktrace == null) {
    return null;
  }

  // Extract unique URLs and their frames
  const urlMap = new Map<string, number>();
  const urls: string[] = [];
  const compactFrames: CompactFrame[] = [];

  // Find all matches in the stacktrace
  const matches = stacktrace.matchAll(urlRegex);

  for (const match of matches) {
    const [, url, lineStr, columnStr] = match;

    // Add URL to the list if it's not already there
    if (!urlMap.has(url)) {
      urlMap.set(url, urls.length);
      urls.push(url);
    }

    // Create a compact frame
    // biome-ignore lint/style/noNonNullAssertion: the `if (!urlMap.has(url))` block directly above sets url in urlMap when absent, so by this line urlMap always has url and get() returns a defined index.
    const urlIndex = urlMap.get(url)!;
    const line = parseInt(lineStr, 10);
    const column = parseInt(columnStr, 10);

    compactFrames.push([urlIndex, line, column]);
  }

  if (compactFrames.length === 0) {
    return null;
  }

  return [urls, compactFrames];
}
const maxArrayItems = 10;
const maxStringLen = 25;
const abbreviate = true;
const inlineSingleArrays = true;
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

function getClassName(val: object): string {
  const proto = Object.getPrototypeOf(val);
  if (proto?.constructor?.name != null) {
    return proto.constructor.name;
  }
  return "Object";
}

export function isUrlLike(val: object): boolean {
  return getClassName(val) === "URL" && typeof (val as { href?: unknown }).href === "string";
}

// DOM Event duck-check: state-flow compiles DOM-lib-free, so no `instanceof Event` — a string
// `type` plus an `*Event` constructor name identifies one.
export function isEventLike(val: object): boolean {
  return typeof (val as { type?: unknown }).type === "string" && getClassName(val).endsWith("Event");
}

/**
 * True for values that are safe to hold in flat state by freezing them IN PLACE (shallow) —
 * `Error`/`RegExp`/URL-like/Event-like, plus anything already `Object.isFrozen`, plus the
 * `FROZEN`-branded collections. Shared with `sealProps` so the carve-out list cannot drift.
 * NOTE: the already-frozen branch TRUSTS the caller's deep-immutability claim — it does not verify.
 */
export function isImmutableValueLike(val: unknown): boolean {
  if (val === null || typeof val !== "object") {
    return false;
  }
  if (Object.isFrozen(val)) {
    return true;
  }
  if (Reflect.has(val, FROZEN)) {
    return true;
  }
  if (val instanceof Error || val instanceof RegExp) {
    return true;
  }
  return isUrlLike(val) || isEventLike(val);
}

function flattenPath(val: unknown, path: string[] = [], depthBudget: number = maxDepth): FlattenResult {
  if (isPlainObject(val) && depthBudget > 0) {
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
    return abbreviate ? "N" : "null";
  }
  if (val === undefined) {
    return abbreviate ? "U" : "undefined";
  }

  // Boolean
  if (typeof val === "boolean") {
    return abbreviate ? (val ? "T" : "F") : String(val);
  }

  // Number
  if (typeof val === "number") {
    return String(val);
  }

  // String
  if (typeof val === "string") {
    let str = val;

    // Truncate if too long
    if (maxStringLen && str.length > maxStringLen) {
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
    if (inlineSingleArrays && val.length === 1) {
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
    if (maxArrayItems && val.length > maxArrayItems) {
      items = val.slice(0, maxArrayItems);
      truncated = true;
    }

    const serialized = items.map((item) => {
      if (isPlainObject(item)) {
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

    // Check for Symbol.toPrimitive BEFORE plain object check
    if (Reflect.has(val, Symbol.toPrimitive) && !Reflect.has(val, VARIANT)) {
      return String(val);
    }

    // Native containers/objects — previously collapsed to an opaque {ClassName}.
    if (val instanceof Map) {
      if (depth >= maxDepth) {
        return `Map(${val.size}){...}`;
      }
      let entries = [...val.entries()];
      const dropped = maxArrayItems ? entries.length - maxArrayItems : 0;
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
      const dropped = maxArrayItems ? items.length - maxArrayItems : 0;
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
      if (maxStringLen && message.length > maxStringLen) {
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
