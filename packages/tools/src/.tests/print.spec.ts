import {
  applyFlow,
  Box,
  DisposableBox,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FrozenMap,
  FrozenSet,
  type Items,
} from "@state-flow/core";
import { describe, expect, it } from "vitest";
import { recordingWorld, Session } from "../../../core/examples/examples";
import { printStates } from "..";

// note: props the test chooses, the engine's default string form (it truncates). hidden: a string form of its own.
const note = defineState<{ [key: string]: unknown }>().name("note").variant("kept", { initial: true }).build();
const hidden = defineState<{ secret: string }>()
  .name("hidden")
  .variant("kept", { initial: true })
  .stringRepr(() => "-")
  .build();
// A collection of nested states.
const leaf = defineState<{ text: string }>().name("leaf").variant("on", { initial: true }).build();
const tree = defineState<{ tags: Items<typeof leaf> }>().name("tree").variant("on", { initial: true }).build();
/** A target whose flow starts `def` from `props`, which sit under the state's name. */
function target(def: object, props: object): Record<string, unknown> {
  const made = { [String(def)]: props };
  applyFlow(made, [def], () => {});
  return made;
}
const noted = (props: { [key: string]: unknown }) => printStates(target(note, props));
const tagged = (tags: Items<typeof leaf>) => printStates(target(tree, { tags }));
/** `levels` calls of `wrap`, each on the one before, from 0. */
function nest(levels: number, wrap: (next: unknown) => unknown): unknown {
  let value: unknown = 0;
  for (let i = 0; i < levels; i++) {
    value = wrap(value);
  }
  return value;
}
const go = defineSignal("go");
/**
 * Whether the engine, under equalAnswers "value", holds two results of `make` equal: a flow started from one whose
 * reducer answers with another keeps its instance.
 */
function heldEqual(make: () => { [key: string]: unknown }): boolean {
  const def = defineState<{ [key: string]: unknown }>()
    .name("s")
    .signals({ go })
    .variant("x", { initial: true })
    .build();
  defineFlow(def.x, { go: () => make() });
  const made = { s: make() };
  applyFlow(made, [def], () => {}, { equalAnswers: "value" });
  const before = made.s;
  dispatch(made, go());
  return made.s === before;
}
/** The print of a session driven as the example's scenario starts: open, two tracks, one paused. */
async function playedSession(): Promise<string> {
  const session = new Session(recordingWorld().world);
  await session.open();
  await session.addProducer("cam", { id: "cam" });
  await session.addProducer("mic", { id: "mic" });
  await session.pause("cam");
  return printStates(session);
}
describe("printStates", () => {
  it("prints two runs of one session alike, as a JSON document", async () => {
    const first = await playedSession();
    expect(await playedSession()).toBe(first);
    expect(first).toBe(
      '{"media":{"$state":"media.active","props":{"producers":{"$items":[' +
        '["cam",{"$state":"producer.active","props":{"paused":true,"producer":{"$box":0},"track":{"$box":1}}}],' +
        '["mic",{"$state":"producer.active","props":{"paused":false,"producer":{"$box":2},"track":{"$box":3}}}]],' +
        '"of":"producer"},' +
        '"transport":{"$state":"transport.open","props":{"socket":{"$box":4}}}}}}',
    );
  });
  it("tells apart states that differ only past the engine's truncation limits or behind a string form", () => {
    const long = "x".repeat(30);
    const pairs = [
      [{ text: `${long}a` }, { text: `${long}b` }],
      [{ list: [...Array(10).fill(0), 1] }, { list: [...Array(10).fill(0), 2] }],
      [{ deep: { a: { b: { c: { d: 1 } } } } }, { deep: { a: { b: { c: { d: 2 } } } } }],
    ];
    for (const [a, b] of pairs) {
      expect(String(target(note, a).note)).toBe(String(target(note, b).note));
      expect(noted(a)).not.toBe(noted(b));
    }
    expect(String(target(hidden, { secret: "a" }).hidden)).toBe(String(target(hidden, { secret: "b" }).hidden));
    expect(printStates(target(hidden, { secret: "a" }))).toBe(
      '{"hidden":{"$state":"hidden.kept","props":{"secret":"a"}}}',
    );
  });
  it("keeps the order of a collection of nested states and sorts sets and maps of data", () => {
    const [one, two] = [leaf.on({ text: "1" }), leaf.on({ text: "2" })];
    expect(tagged(leaf.items().with("1", one).with("2", two))).not.toBe(
      tagged(leaf.items().with("2", two).with("1", one)),
    );
    const ab = noted({
      set: new FrozenSet(["a", "b"]),
      map: new FrozenMap([
        ["a", 1],
        ["b", 2],
      ]),
    });
    expect(
      noted({
        set: new FrozenSet(["b", "a"]),
        map: new FrozenMap([
          ["b", 2],
          ["a", 1],
        ]),
      }),
    ).toBe(ab);
    expect(ab).toBe(
      '{"note":{"$state":"note.kept","props":{"map":{"$map":[["a",1],["b",2]]},"set":{"$set":["a","b"]}}}}',
    );
  });
  it("sorts a state's props and a target's states, and keeps the key order of an object of data", () => {
    // The props are given in another order than the print writes them; the data's keys stay as they were written.
    expect(noted({ b: 1, a: { z: 1, y: 2 } })).toBe(
      '{"note":{"$state":"note.kept","props":{"a":{"z":1,"y":2},"b":1}}}',
    );
    const two = { tree: { tags: leaf.items() }, note: {} };
    applyFlow(two, [tree, note], () => {});
    expect(Object.keys(JSON.parse(printStates(two)))).toEqual(["note", "tree"]);
  });
  it("names a variant held as data, and tells a DisposableBox from a Box", () => {
    const owned = DisposableBox.of({ [Symbol.dispose]() {} });
    expect(noted({ kind: leaf.on, owned, plain: Box.of(owned.deref()) })).toBe(
      '{"note":{"$state":"note.kept","props":{"kind":{"$variant":"leaf.on"},"owned":{"$disposableBox":0},"plain":{"$box":0}}}}',
    );
  });
  it("numbers boxes by first appearance and as Box.equals compares them", () => {
    const [camera, shared] = [{}, Box.of({})];
    expect(noted({ a: shared, b: shared })).toBe(
      '{"note":{"$state":"note.kept","props":{"a":{"$box":0},"b":{"$box":0}}}}',
    );
    expect(noted({ a: Box.of(camera), b: Box.of(camera) })).toBe(noted({ a: shared, b: shared }));
    expect(noted({ a: Box.of(camera), b: Box.of({}) })).toBe(
      '{"note":{"$state":"note.kept","props":{"a":{"$box":0},"b":{"$box":1}}}}',
    );
  });
  it("writes what JSON has no form for so that the engine's equal values print alike and only those", () => {
    const fn = () => {};
    const holed: number[] = new Array(3); // [1, <a hole>, 3]: a hole is an index the array does not have
    holed[0] = 1;
    holed[2] = 3;
    expect(noted({ v: -0 })).toBe(noted({ v: 0 }));
    // A function with no prototype chain is still compared by ===, not as an empty plain object.
    expect(noted({ a: Object.setPrototypeOf(() => {}, null) })).toBe(
      '{"note":{"$state":"note.kept","props":{"a":{"$ref":0}}}}',
    );
    expect(noted({ a: fn, b: Symbol("s"), c: new Error("e"), d: fn })).toBe(
      '{"note":{"$state":"note.kept","props":{"a":{"$ref":0},"b":{"$ref":1},"c":{"$ref":2},"d":{"$ref":0}}}}',
    );
    expect(
      noted({ u: undefined, n: Number.NaN, p: Infinity, m: -Infinity, i: BigInt(12), h: holed, $k: "\u0001é\n" }),
    ).toBe(
      '{"note":{"$state":"note.kept","props":{"$$k":"\\u0001é\\n","h":[1,{"$hole":true},3],"i":{"$bigint":"12"},' +
        '"m":{"$number":"-Infinity"},"n":{"$number":"NaN"},"p":{"$number":"Infinity"},"u":{"$undefined":true}}}}',
    );
  });
  it("does not tell apart what its Not told apart lists", () => {
    // Across two prints a box or a reference is told apart only by where it repeats, and NaN equals NaN.
    expect(noted({ a: Box.of({}) })).toBe(noted({ a: Box.of({}) }));
    expect(noted({ a: () => 1 })).toBe(noted({ a: () => 2 }));
    expect(noted({ a: Number.NaN })).toBe(noted({ a: Number.NaN }));
    // The engine holds NaN props and NaN map values different, and NaN set elements and map keys equal.
    expect(heldEqual(() => ({ a: Number.NaN }))).toBe(false);
    expect(heldEqual(() => ({ a: new FrozenMap([["k", Number.NaN]]) }))).toBe(false);
    expect(heldEqual(() => ({ a: new FrozenSet([Number.NaN]) }))).toBe(true);
    expect(heldEqual(() => ({ a: new FrozenMap([[Number.NaN, 1]]) }))).toBe(true);
  });
  it("states its limits", () => {
    // The same two boxes in either order: FrozenSet compares its elements by identity, so the engine holds them equal.
    const [a, b] = [Box.of({}), Box.of({})];
    expect(noted({ s: new FrozenSet([a, b]), t: a })).not.toBe(noted({ s: new FrozenSet([b, a]), t: a }));
    const split = (name: string, variant: string) => {
      const def = defineState<object>().name(name).variant(variant, { initial: true }).build();
      return Object.values(JSON.parse(printStates(target(def, {}))));
    };
    expect(split("a.b", "c")).toEqual(split("a", "b.c"));
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => noted({ cyclic })).toThrow();
    expect(noted({ a: Box.of(Number.NaN), b: Box.of(Number.NaN) })).toBe(
      '{"note":{"$state":"note.kept","props":{"a":{"$box":0},"b":{"$box":0}}}}',
    );
    expect(noted({ [Symbol("s")]: 1 })).toBe(noted({}));
    expect(noted({ v: Object.assign([1], { x: 1 }) })).toBe(noted({ v: [1] }));
    // Built outside the expect, so a throw of the engine's fails the line. States: each is checked as it is made,
    // with the one below as a direct prop, so the engine never walks the whole depth; the print does.
    const tooDeep = { note: nest(20_000, (nested) => note.kept({ nested })) };
    expect(() => printStates(tooDeep)).toThrow(RangeError);
  });
  it("prints plain objects 2000 deep and states 50 deep", () => {
    expect(noted({ deep: nest(2000, (next) => ({ next })) })).toContain('{"next":0}');
    expect(printStates({ note: nest(50, (nested) => note.kept({ nested })) })).toContain('"props":{"nested":0}');
  });
});
