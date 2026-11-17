import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import errorCodes from "../error-codes.json";

/**
 * The agent guide that ships in the package (packages/core/agent-guide.md) ends with the list of error codes, which is
 * the table src/error-codes.json written out: everything after the guide's marker comment is what this test writes,
 * and a run fails while the guide's list differs from the table.
 */
it("the agent guide lists every error code of the table, with its message, cause and fix", async () => {
  const guide = join(__dirname, "../../agent-guide.md");
  const text = readFileSync(guide, "utf8");
  const marker = text.indexOf("<!-- Generated from src/error-codes.json");
  const written = text.slice(0, text.indexOf("\n", marker) + 1);
  const list = Object.entries(errorCodes)
    .map(([code, { message, cause, fix }]) => `\n**${code}** ${message}\n- Cause: ${cause}\n- Fix: ${fix}\n`)
    .join("");
  await expect(written + list).toMatchFileSnapshot(guide);
});

it("the declarations the package ships keep the doc comments the guide sends an agent to", () => {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
  const config = ts.getParsedCommandLineOfConfigFile(join(__dirname, "../../tsconfig.dts.json"), {}, host);
  expect(config?.options.removeComments).toBe(false);
});
