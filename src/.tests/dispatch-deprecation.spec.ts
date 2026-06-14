import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { dispatch, lock } from "../flow";

/**
 * P0.B — Deprecate bare dispatch().
 *
 * dispatch() stays EXPORTED (two documented, genuinely-safe exception sites exist in
 * consumers: synchronous page-unload teardown and pre-lock constructor bootstrap), but
 * its JSDoc must steer all other code to lock()+send(). These are source-level guards:
 * the only thing this task changes is documentation metadata, so we assert on the
 * @deprecated marker and the corrected guidance rather than runtime behavior (which is
 * intentionally unchanged).
 */
describe("dispatch() deprecation (P0.B)", () => {
  // Read the engine source directly so the assertion is on the shipped JSDoc, not a
  // runtime side effect. flow.ts sits next to this spec in src/.
  const flowSrc = readFileSync(fileURLToPath(new URL("../flow.ts", import.meta.url)), "utf8");

  // Isolate the dispatch() JSDoc block: the doc comment immediately preceding the
  // `export function dispatch(` declaration.
  const dispatchDoc = (() => {
    const declIdx = flowSrc.indexOf("export function dispatch(");
    expect(declIdx).toBeGreaterThan(-1);
    const before = flowSrc.slice(0, declIdx);
    const docStart = before.lastIndexOf("/**");
    expect(docStart).toBeGreaterThan(-1);
    return before.slice(docStart);
  })();

  it("keeps dispatch and lock exported (escape hatch must remain callable)", () => {
    // The two exception sites can't use an async lock, so the export must survive.
    expect(typeof dispatch).toBe("function");
    expect(typeof lock).toBe("function");
  });

  it("marks dispatch() JSDoc with an @deprecated tag", () => {
    expect(dispatchDoc).toMatch(/@deprecated/);
  });

  it("@deprecated guidance points callers to lock()+send()", () => {
    // Must name the sanctioned replacement pattern.
    expect(dispatchDoc).toMatch(/await\s+using\s+send\s*=\s*await\s+lock\(/);
    expect(dispatchDoc).toMatch(/send\(/);
  });

  it("@deprecated guidance names the two genuine exceptions (teardown / bootstrap)", () => {
    expect(dispatchDoc).toMatch(/teardown/i);
    expect(dispatchDoc).toMatch(/bootstrap/i);
  });

  it("primary JSDoc example no longer presents bare dispatch() as the pattern to copy", () => {
    // The old example led with `const result = dispatch(player, signals.play())` as the
    // primary, copy-this pattern. After deprecation the example must lead with
    // lock()+send() instead.
    expect(dispatchDoc).not.toMatch(/const\s+result\s*=\s*dispatch\(player,\s*signals\.play\(\)\)/);
  });
});
