import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { dispatch, lock } from "../flow";

/**
 * Bare dispatch() is deprecated. It stays exported for two safe uses (synchronous page-unload teardown and
 * pre-lock bootstrap), and its JSDoc steers all other code to lock()+send(). These guards read the source, so
 * they pin the @deprecated marker and the guidance, not runtime behavior.
 */
describe("dispatch() deprecation", () => {
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

  it("primary JSDoc example does not present bare dispatch() as the pattern to copy", () => {
    // The example leads with lock()+send(), not with `const result = dispatch(player, signals.play())`.
    expect(dispatchDoc).not.toMatch(/const\s+result\s*=\s*dispatch\(player,\s*signals\.play\(\)\)/);
  });
});
