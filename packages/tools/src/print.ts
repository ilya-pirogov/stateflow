import {
  DisposableBox,
  definitionOf,
  Items,
  isBox,
  isState,
  isVariant,
  type StateInstance,
  stateVar,
} from "@state-flow/core";

/** The states `target` holds, by name in ascending order: its own enumerable props that hold a state instance. */
export function statesOf(target: object): Record<string, StateInstance> {
  const names = Object.keys(target).sort();
  return Object.fromEntries(
    names.map((name) => [name, Reflect.get(target, name)] as const).filter(([, value]) => isState(value)),
  );
}
/**
 * The canonical print of the states `target` holds (statesOf), every prop in full, as one JSON text in the format of
 * the package's docs/canonical-print.md. States the engine holds equal print alike, and states that print alike are
 * equal, except where that file lists otherwise. The engine's string forms are not read: they truncate, and a state's
 * own may hide props. It reads each box's value with Box.deref, so it throws inside a reducer, as deref does there.
 */
export function printStates(target: object): string {
  return printValue(statesOf(target));
}
/** `value` as one JSON text in the forms of docs/canonical-print.md, numbered from 0 in this text alone. */
export function printValue(value: unknown): string {
  const out: string[] = [];
  write(value, new Map(), out);
  return out.join("");
}
/**
 * Pushes `value`, as docs/canonical-print.md writes it, onto `out` in pieces that printStates joins once: a text made
 * for each level and joined into the level above would be copied once per enclosing level, quadratic in depth.
 * `numbers` holds the number given, in this print, to each boxed value and each other object, function or symbol met
 * so far.
 */
function write(value: unknown, numbers: Map<unknown, number>, out: string[]): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      out.push(JSON.stringify(value));
      return;
    case "number":
      // JSON.stringify writes -0 as 0, as === holds them equal; NaN and the infinities have no JSON form.
      out.push(Number.isFinite(value) ? JSON.stringify(value) : `{"$number":"${value}"}`);
      return;
    case "bigint":
      out.push(`{"$bigint":"${value}"}`);
      return;
    case "undefined":
      out.push(`{"$undefined":true}`);
      return;
    case "symbol":
    case "function":
      // Here, not with the other objects below: a function's prototype can be null, as a plain object's can. A
      // variant is named: a prop may hold one as data, and a state's parser may require a function there.
      out.push(
        isVariant(value) ? `{"$variant":${JSON.stringify(String(value))}}` : `{"$ref":${numberOf(value, numbers)}}`,
      );
      return;
  }
  if (value === null) {
    out.push("null");
    return;
  }
  if (isBox(value)) {
    // Numbered by the value it wraps: Box.equals holds two boxes of one value equal. The two kinds are told apart:
    // the engine disposes what a DisposableBox wraps, and a state's parser may require one.
    const form = value instanceof DisposableBox ? "$disposableBox" : "$box";
    out.push(`{"${form}":${numberOf(value.deref(), numbers)}}`);
    return;
  }
  if (isState(value)) {
    // Its props by key in ascending order: a state's props are a fixed set, and the order a reducer wrote them in
    // is no data.
    out.push(`{"$state":${JSON.stringify(String(stateVar(value)))},"props":`);
    writeProps(value, Object.keys(value).sort(), numbers, out);
    out.push("}");
    return;
  }
  if (value instanceof Items) {
    // Its [key, state] pairs as an array, in its own order: it sets the order of the nested states' handler calls.
    // Then its definition's name, which an empty one is built again from.
    out.push(`{"$items":`);
    write([...value], numbers, out);
    out.push(`,"of":${JSON.stringify(String(definitionOf(value)))}}`);
    return;
  }
  if (value instanceof Map || value instanceof Set) {
    writeSorted(value, numbers, out);
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    let separator = ""; // none before the first element, a comma before each one after it
    for (let index = 0; index < value.length; index++) {
      out.push(separator);
      separator = ",";
      // A hole is an index the array does not have; the engine tells it from an undefined element.
      if (index in value) {
        write(value[index], numbers, out);
      } else {
        out.push(`{"$hole":true}`);
      }
    }
    out.push("]");
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    // Its own enumerable string-keyed props in its own order, which a reducer can read (Object.keys of a map of data
    // the world gave). A cast: the switch returned for undefined, which TypeScript does not narrow out of unknown
    // there.
    writeProps(value as object, Object.keys(value as object), numbers, out);
    return;
  }
  out.push(`{"$ref":${numberOf(value, numbers)}}`);
}
/** Pushes an object of the values `props` holds under `keys`, in the order given. */
function writeProps(props: object, keys: string[], numbers: Map<unknown, number>, out: string[]): void {
  out.push("{");
  let separator = ""; // none before the first prop, a comma before each one after it
  for (const key of keys) {
    out.push(`${separator}${JSON.stringify(key.startsWith("$") ? `$${key}` : key)}:`);
    separator = ",";
    write(Reflect.get(props, key), numbers, out);
  }
  out.push("}");
}
/**
 * Pushes `entries` (a map's as [key, value]) sorted by their texts onto `out`: the engine compares sets and maps of
 * data without order. Each entry's text is joined, so a set or map nested in another's entries is copied once per
 * such enclosing level. Kept out of write, whose frame each level of nesting stacks, to keep that frame small.
 */
function writeSorted(
  entries: Map<unknown, unknown> | Set<unknown>,
  numbers: Map<unknown, number>,
  out: string[],
): void {
  const texts: string[] = [];
  for (const entry of entries) {
    const text: string[] = [];
    write(entry, numbers, text);
    texts.push(text.join(""));
  }
  out.push(`{"${entries instanceof Map ? "$map" : "$set"}":[${texts.sort().join(",")}]}`);
}
/** The number of `value` in this print: the next one, from 0, at its first appearance. */
function numberOf(value: unknown, numbers: Map<unknown, number>): number {
  const number = numbers.get(value) ?? numbers.size;
  numbers.set(value, number);
  return number;
}
