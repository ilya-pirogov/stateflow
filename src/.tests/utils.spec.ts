import { describe, expect, it } from "vitest";

import { serializeDebug } from "../utils"; // Adjust import path as needed

describe("serializeDebug", () => {
  describe("Basic types", () => {
    it("should serialize numbers", () => {
      expect(serializeDebug({ count: 42 })).toBe("count=42");
    });

    it("should serialize strings without quotes", () => {
      expect(serializeDebug({ status: "ok" })).toBe("status=ok");
    });

    it("should serialize strings with spaces using single quotes", () => {
      expect(serializeDebug({ message: "hello world" })).toBe("message='hello world'");
    });

    it("should abbreviate booleans by default", () => {
      expect(serializeDebug({ active: true, disabled: false })).toBe("active=T disabled=F");
    });

    it("should abbreviate null and undefined", () => {
      expect(serializeDebug({ a: null, b: undefined })).toBe("a=N b=U");
    });
  });

  describe("Strings with special characters", () => {
    it("should quote strings with spaces", () => {
      expect(serializeDebug({ withSpaces: "hello world" })).toBe("withSpaces='hello world'");
    });

    it("should quote strings with equals sign", () => {
      expect(serializeDebug({ withEquals: "a=b" })).toBe("withEquals='a=b'");
    });

    it("should quote strings with brackets", () => {
      expect(serializeDebug({ withBrackets: "a[0]" })).toBe("withBrackets='a[0]'");
    });

    it("should escape single quotes in strings", () => {
      expect(serializeDebug({ withQuote: "it's great" })).toBe("withQuote='it\\'s great'");
    });

    it("should not quote simple strings", () => {
      expect(serializeDebug({ simple: "test" })).toBe("simple=test");
    });
  });

  describe("Arrays", () => {
    it("should serialize arrays with space separators", () => {
      expect(serializeDebug({ arr: [1, 2, 3] })).toBe("arr=[1 2 3]");
    });

    it("should inline single primitive arrays by default", () => {
      expect(serializeDebug({ tags: ["typescript"] })).toBe("tags=typescript");
    });

    it("should not inline single object arrays", () => {
      expect(serializeDebug({ items: [{ id: 1 }] })).toBe("items=[id=1]");
    });

    it("should serialize array of objects without braces for single property", () => {
      expect(serializeDebug({ items: [{ id: 1 }, { id: 2 }] })).toBe("items=[id=1 id=2]");
    });

    it("should serialize array of objects with braces for multiple properties", () => {
      expect(
        serializeDebug({
          items: [
            { id: 1, name: "first" },
            { id: 2, name: "second" },
          ],
        }),
      ).toBe("items=[{id=1 name=first} {id=2 name=second}]");
    });

    it("should truncate long arrays", () => {
      const longArray = Array.from({ length: 30 }, (_, i) => i);
      expect(serializeDebug({ nums: longArray })).toBe("nums=[0 1 2 3 4 5 6 7 8 9 …+20]");
    });
  });

  describe("Objects", () => {
    it("should serialize simple objects with space separators", () => {
      expect(serializeDebug({ a: 1, b: 2, c: 3 })).toBe("a=1 b=2 c=3");
    });

    it("should serialize nested objects", () => {
      expect(serializeDebug({ a: 1, b: { c: 2, d: 3 } })).toBe("a=1 b={c=2 d=3}");
    });

    it("should flatten single-property nested objects", () => {
      expect(serializeDebug({ user: { profile: { name: "John" } } })).toBe("user.profile.name=John");
    });

    it("should flatten deeply nested single-property objects", () => {
      expect(serializeDebug({ a: { b: { c: 42 } } })).toBe("a.b.c=42");
    });

    it("should not flatten multi-property objects", () => {
      expect(serializeDebug({ user: { name: "John", age: 30 } })).toBe("user={name=John age=30}");
    });
  });

  describe("Complex nested structures", () => {
    it("should handle mixed arrays and objects", () => {
      const data = {
        status: "ok",
        updates: [{ foo: "bar" }, { a: { b: 42 } }, { arr: [1, 2, 3] }],
        active: true,
        count: null,
        message: "hello world",
      };
      expect(serializeDebug(data)).toBe(
        "status=ok updates=[foo=bar a.b=42 arr=[1 2 3]] active=T count=N message='hello world'",
      );
    });

    it("should handle arrays with nested objects", () => {
      expect(
        serializeDebug({
          a: 1,
          b: { c: 2, d: 3 },
          e: [4, 5],
          items: [
            { id: 1, name: "first" },
            { id: 2, name: "second" },
          ],
        }),
      ).toBe("a=1 b={c=2 d=3} e=[4 5] items=[{id=1 name=first} {id=2 name=second}]");
    });
  });

  describe("Depth limiting", () => {
    it("should limit depth to maxDepth (default 3)", () => {
      const deepObj = {
        level1: {
          level2: {
            level3: {
              level4: {
                tooDeep: "won't show",
              },
            },
          },
        },
      };
      expect(serializeDebug(deepObj)).toBe("level1.level2.level3={...}");
    });

    it("should limit depth in arrays", () => {
      const data = {
        items: [
          {
            a: {
              b: {
                c: {
                  d: "too deep",
                },
              },
            },
          },
        ],
      };
      expect(serializeDebug(data)).toBe("items=[a.b={...}]");
    });

    it("should handle multiple deep items in arrays", () => {
      const data = {
        items: [{ a: { b: { c: { d: 1 } } } }, { x: { y: { z: { w: 2 } } } }],
      };
      expect(serializeDebug(data)).toBe("items=[a.b={...} x.y={...}]");
    });
  });

  describe("Date objects", () => {
    it("should serialize Date as ISO string", () => {
      const date = new Date("2023-11-30T18:00:00.000Z");
      expect(serializeDebug({ created: date })).toBe("created=2023-11-30T18:00:00.000Z");
    });

    it("should handle multiple dates", () => {
      const data = {
        created: new Date("2024-01-01T12:30:00.000Z"),
        updated: new Date("2024-01-02T14:45:00.000Z"),
      };
      expect(serializeDebug(data)).toBe("created=2024-01-01T12:30:00.000Z updated=2024-01-02T14:45:00.000Z");
    });
  });

  describe("Custom objects", () => {
    it("should show class name for custom classes", () => {
      class CustomClass {
        constructor(public value: number) {}
      }
      const obj = new CustomClass(123);
      expect(serializeDebug({ custom: obj })).toBe("custom={CustomClass}");
    });

    it("should use Symbol.toPrimitive if available", () => {
      const withToPrimitive = {
        [Symbol.toPrimitive](hint: string) {
          return hint === "string" ? "CustomValue" : 42;
        },
      };
      expect(serializeDebug({ primitive: withToPrimitive })).toBe("primitive=CustomValue");
    });

    it("should handle Error objects as name(message)", () => {
      const error = new Error("test error");
      expect(serializeDebug({ error })).toBe("error=Error(test error)");
    });

    it("should handle RegExp objects as their literal form", () => {
      const regex = /test/gi;
      expect(serializeDebug({ pattern: regex })).toBe("pattern=/test/gi");
    });
  });

  describe("String truncation", () => {
    it("should truncate long strings", () => {
      const longStr = "A".repeat(100);
      expect(serializeDebug({ msg: longStr })).toBe("msg=AAAAAAAAAAAAAAAAAAAAAAAAA…");
    });

    it("should not truncate strings within limit", () => {
      const shortStr = "Hello World";
      expect(serializeDebug({ msg: shortStr })).toBe("msg='Hello World'");
    });
  });

  describe("Array truncation", () => {
    it("should not truncate arrays within limit", () => {
      const shortArray = [1, 2, 3];
      expect(serializeDebug({ nums: shortArray })).toBe("nums=[1 2 3]");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty objects", () => {
      expect(serializeDebug({})).toBe("");
    });

    it("should handle empty arrays", () => {
      expect(serializeDebug({ arr: [] })).toBe("arr=[]");
    });

    it("should handle objects with only null values", () => {
      expect(serializeDebug({ a: null, b: null })).toBe("a=N b=N");
    });

    it("should handle mixed types in arrays", () => {
      expect(serializeDebug({ mixed: [1, "two", true, null, { id: 5 }] })).toBe("mixed=[1 two T N id=5]");
    });

    it("should handle nested empty objects", () => {
      expect(serializeDebug({ outer: { inner: {} } })).toBe("outer.inner={}");
    });

    it("should handle circular-like deep nesting", () => {
      const deep = { a: { b: { c: { d: { e: { f: "deep" } } } } } };
      expect(serializeDebug(deep)).toBe("a.b.c={...}");
    });
  });

  describe("inlineSingleArrays option", () => {
    it("should inline single primitive arrays when true", () => {
      expect(serializeDebug({ tags: ["typescript"] })).toBe("tags=typescript");
    });

    it("should not inline single object arrays even when true", () => {
      expect(serializeDebug({ items: [{ id: 1 }] })).toBe("items=[id=1]");
    });
  });
});

describe("serializeDebug native objects", () => {
  it("serializes a Map with sized header and k=v entries", () => {
    const m = new Map<string, unknown>([
      ["a", 1],
      ["b", true],
    ]);
    expect(serializeDebug({ m })).toBe("m=Map(2){a=1 b=T}");
  });

  it("serializes an empty Map", () => {
    expect(serializeDebug({ m: new Map() })).toBe("m=Map(0){}");
  });

  it("truncates large Maps at maxArrayItems with a remainder marker", () => {
    const m = new Map(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    const out = serializeDebug({ m });
    expect(out).toContain("Map(12){k0=0");
    expect(out).toContain("k9=9 …+2}");
  });

  it("serializes a Set with sized header and space-separated values", () => {
    expect(serializeDebug({ s: new Set(["mp4-hls", "webrtc"]) })).toBe("s=Set(2){mp4-hls webrtc}");
  });

  it("truncates large Sets at maxArrayItems with a remainder marker", () => {
    const s = new Set(Array.from({ length: 13 }, (_, i) => i));
    const out = serializeDebug({ s });
    expect(out).toBe("s=Set(13){0 1 2 3 4 5 6 7 8 9 …+3}");
  });

  it("collapses Map/Set beyond the depth limit but keeps the size", () => {
    const deep = { a: { b: { c: { m: new Map([["x", 1]]), s: new Set([1]) } } } };
    // depth budget exhausted at the same point plain objects print {...}
    expect(serializeDebug(deep)).toBe("a.b.c={...}");
    const atLimit = { a: { b: { m: new Map([["x", 1]]) } } };
    expect(serializeDebug(atLimit)).toBe("a.b.m=Map(1){...}");
  });

  it("serializes Errors as name(message) with string truncation", () => {
    expect(serializeDebug({ e: new TypeError("x is not a function") })).toBe("e=TypeError(x is not a function)");
    const long = new Error("a".repeat(40));
    expect(serializeDebug({ e: long })).toBe(`e=Error(${"a".repeat(25)}…)`);
  });

  it("serializes event-like objects as Ctor(type) without DOM types", () => {
    class FakeEvent {
      readonly type = "pause";
    }
    class PointerEvent {
      readonly type = "click";
      readonly clientX = 10;
    }
    expect(serializeDebug({ ev: new FakeEvent() })).toBe("ev=FakeEvent(pause)");
    expect(serializeDebug({ ev: new PointerEvent() })).toBe("ev=PointerEvent(click)");
  });

  it("keeps non-Event classes as {ClassName}", () => {
    class Whatever {
      readonly type = "pause";
    }
    class NamedEventually {}
    expect(serializeDebug({ v: new Whatever() })).toBe("v={Whatever}");
    expect(serializeDebug({ v: new NamedEventually() })).toBe("v={NamedEventually}");
  });

  it("serializes RegExp, ArrayBuffer and typed arrays", () => {
    expect(serializeDebug({ r: /ab+c/gi })).toBe("r=/ab+c/gi");
    expect(serializeDebug({ b: new ArrayBuffer(16) })).toBe("b=ArrayBuffer(16)");
    expect(serializeDebug({ t: new Uint8Array(1024) })).toBe("t=Uint8Array(1024)");
  });

  it("serializes URL-like objects via href with the standard truncation", () => {
    class URL {
      constructor(readonly href: string) {}
    }
    const u = new URL("https://example.test/very/long/path/manifest.json");
    expect(serializeDebug({ u })).toBe("u=https://example.test/very…");
  });

  it("still respects Symbol.toPrimitive over native handling", () => {
    class FancyMap extends Map {
      [Symbol.toPrimitive]() {
        return "fancy";
      }
    }
    expect(serializeDebug({ m: new FancyMap() })).toBe("m=fancy");
  });
});
