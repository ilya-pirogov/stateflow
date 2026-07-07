import { describe, expect, it } from "vitest";

import { applyFlow, defineFlow, defineSignal, defineState, lock, observe, serializeDebug } from "..";
import { Box, isBox } from "../box";
import { VARIANT } from "../symbols";

class MediaStream {} // stand-in live resource

describe("Box", () => {
  it("derefs to the exact reference outside a reducer", () => {
    const s = new MediaStream();
    const box = Box.of(s);
    expect(box.deref()).toBe(s);
    expect(Object.isFrozen(box)).toBe(true);
    expect(Reflect.has(box, VARIANT)).toBe(false);
    expect(box[Symbol.toStringTag]).toBe("Box");
  });

  it("equals is pure identity across re-wrapping", () => {
    const s = new MediaStream();
    expect(Box.of(s).equals(Box.of(s))).toBe(true);
    expect(Box.of(s).equals(Box.of(new MediaStream()))).toBe(false);
    expect(Box.of(s).equals(42)).toBe(false);
    expect(Box.of(s).equals(null)).toBe(false);
  });

  it("resolves displayName by precedence", () => {
    expect(Box.of(new MediaStream()).displayName).toBe("MediaStream");
    expect(Box.of(new MediaStream(), { displayName: "cam" }).displayName).toBe("cam");
    expect(Box.of(Object.create(null)).displayName).toBe("Box");
  });

  it("serializes single-line, token-safe, length-capped", () => {
    class WeirdName {}
    Object.defineProperty(WeirdName, "displayName", { value: "a b\n{c}=[d] very long name overflowing cap" });
    const line = serializeDebug({ box: Box.of(new WeirdName()) });
    expect(line).not.toContain("\n"); // single-line
    expect(line.startsWith("box=Box(")).toBe(true);
    const boxRender = line.slice("box=".length); // strip the `box=` wrapper key before checking sanitization
    expect(boxRender).not.toMatch(/[\n{}[\]=]/);
  });

  it("isBox narrows only genuine Boxes", () => {
    expect(isBox(Box.of({}))).toBe(true);
    expect(isBox({})).toBe(false);
    expect(isBox(null)).toBe(false);
  });

  it("deref throws inside a reducer, works in effects and observers", async () => {
    const bump = defineSignal("bump");
    const st = defineState<{ box: Box<MediaStream> }>().name("hasbox").signals({ bump }).variant("idle", true).build();
    let reducerThrew = false;
    let effectSaw: MediaStream | null = null;
    defineFlow(st.idle, {
      bump: (state) => {
        try {
          state.box.deref(); // illegal in a reducer
        } catch {
          reducerThrew = true;
        }
        return st.idle(state);
      },
    });
    const s = new MediaStream();
    const target = { hasbox: st.idle({ box: Box.of(s) }) };
    applyFlow(target, [st], () => {});
    using _o = observe(target, [st.idle], (state) => {
      effectSaw = state.box.deref(); // legal in an observer
    });
    await using send = await lock(target);
    await send(bump()).done();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(reducerThrew).toBe(true);
    expect(effectSaw).toBe(s);
  });
});
