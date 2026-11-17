import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  disposeFlow,
  HandlerResult,
  lock,
  ResultKind,
  type StateFlowLogEntry,
  StateResult,
  TransitionAborted,
} from "..";
import errorCodes from "../error-codes.json";

const codes = errorCodes as Record<string, { message: string; cause: string; fix: string }>;

/** The text an engine error's message ends with: its code, then the code's short fix. */
function suffix(code: string): string {
  return ` [${code}] ${codes[code].fix}`;
}

/**
 * Every place the engine source names a code: the code, the message argument of the call or construction that
 * names it (the argument right after the code's), and where it is. A message argument is read as a pattern: its
 * literal text, with `.*` for each part the raise fills in at run time (an interpolation, a variable, a call).
 */
function codeSites(): Array<{ code: string; pattern: string; at: string }> {
  const dir = join(__dirname, "..");
  const sites: Array<{ code: string; pattern: string; at: string }> = [];
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patternOf = (node: ts.Expression): string => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return escapeRegExp(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      return (
        escapeRegExp(node.head.text) + node.templateSpans.map((span) => `.*${escapeRegExp(span.literal.text)}`).join("")
      );
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return patternOf(node.left) + patternOf(node.right);
    }
    return ".*";
  };
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const source = ts.createSourceFile(file, readFileSync(join(dir, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && /^SF\d{3}$/.test(node.text)) {
        let call: ts.Node = node;
        while (!ts.isCallExpression(call) && !ts.isNewExpression(call)) {
          call = call.parent;
        }
        const args = [...((call as ts.CallExpression | ts.NewExpression).arguments ?? [])];
        const at = args.findIndex((arg) => arg.pos <= node.pos && node.end <= arg.end);
        const line = source.getLineAndCharacterOfPosition(node.pos).line + 1;
        sites.push({ code: node.text, pattern: patternOf(args[at + 1]), at: `${file}:${line}` });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

/**
 * Error codes: every error the engine raises names a code from one table (src/error-codes.json), its message the
 * text it had before followed by " [<code>] <fix>"; every refusal the engine writes itself names its code on the
 * result. The table is data, so a guide generator and another implementation read it without running the engine.
 */
describe("error codes", () => {
  describe("the table and the source", () => {
    const sites = codeSites();

    it("every code in the table is raised somewhere, and every code the source raises is in the table", () => {
      expect([...new Set(sites.map((site) => site.code))].sort()).toEqual(Object.keys(codes).sort());
    });

    it("every raise of a code has that code's message: the table's text fits the raise's literal parts", () => {
      for (const { code, pattern, at } of sites) {
        expect(codes[code].message, `${code} at ${at}`).toMatch(new RegExp(`^${pattern}$`, "s"));
      }
    });

    it("no code is used for two different messages: the raises of one code have one message, and no two codes share a message", () => {
      const patterns = new Map<string, Set<string>>();
      for (const { code, pattern } of sites) {
        patterns.set(code, (patterns.get(code) ?? new Set()).add(pattern));
      }
      for (const [code, found] of patterns) {
        expect([...found], code).toHaveLength(1);
      }
      const messages = Object.values(codes).map((entry) => entry.message);
      expect(new Set(messages).size).toBe(messages.length);
    });

    it("every code is SF and three digits, and every entry has a message, a cause and a fix", () => {
      for (const [code, entry] of Object.entries(codes)) {
        expect(code).toMatch(/^SF\d{3}$/);
        expect(Object.keys(entry).sort()).toEqual(["cause", "fix", "message"]);
        expect(entry.cause.length * entry.fix.length * entry.message.length).toBeGreaterThan(0);
      }
    });
  });

  const go = defineSignal("go");
  const stop = defineSignal("stop");
  const refuse = defineSignal("refuse");
  const lamp = defineState<{ n: number }>()
    .name("lamp")
    .signals({ go, stop, refuse })
    .variant("off", { initial: true })
    .variant("warming", { transitional: true })
    .variant("on", { async: true })
    .build();
  defineFlow(lamp.off, {
    go: (s) => StateResult.transition(lamp.on(s), lamp.warming(s), lamp.off(s)),
    refuse: () => StateResult.rejected("not now"),
  });
  defineFlow(lamp.warming, {
    // A reducer that returns a promise is an engine error (SF059).
    stop: (() => Promise.resolve()) as never,
  });
  defineFlow(lamp.on, {});

  /** A transition handler that returns no promise, an engine error (SF052). */
  const noPromise = (() => "no promise") as never;

  /** A fresh lamp whose handlers `init` registers, and the entries it logs. */
  function newLamp(init: Parameters<typeof applyFlow>[2] = () => {}) {
    const entries: StateFlowLogEntry[] = [];
    const target = { lamp: { n: 0 } };
    applyFlow(target, [lamp], init, { logHandlers: [(entry) => entries.push(entry)] });
    return { target, entries };
  }

  it("a refusal the engine writes keeps its text and names its code on the result; one a reducer writes has none", async () => {
    const { target } = newLamp();
    await using send = await lock(target);
    disposeFlow(target);
    const disposed = send(go());

    expect(disposed.kind).toBe(ResultKind.Rejected);
    expect(disposed.message).toBe("Object is disposed");
    expect(disposed.code).toBe("SF008");

    const other = newLamp();
    const ignored = dispatch(other.target, stop());
    expect(ignored.message).toBe("no reducer for stop in lamp.off");
    expect(ignored.code).toBe("SF064");
    expect(dispatch(other.target, refuse()).code).toBeNull();
  });

  it("a merge keeps the winner's code, and a merge that joins two messages the first code of the two", () => {
    const { target } = newLamp();
    const ignored = dispatch(target, stop());

    expect(ignored.merge(HandlerResult.ignored("later")).code).toBe("SF064");
    expect(HandlerResult.ignored("earlier").merge(ignored).code).toBe("SF064");
    expect(ignored.merge(HandlerResult.rejected("no")).code).toBeNull();
  });

  it("a merge of two Errors keeps the earlier error's code, whose message leads the merged one", async () => {
    // Two states whose reducers both return a promise: the dispatch merges two engine errors (SF059 each).
    const [left, right] = ["left", "right"].map((name) => {
      const state = defineState<{ n: number }>().name(name).signals({ stop }).variant("off", { initial: true }).build();
      defineFlow(state.off, { stop: (() => Promise.resolve()) as never });
      return state;
    });
    const entries: StateFlowLogEntry[] = [];
    const target = { left: { n: 0 }, right: { n: 0 } };
    applyFlow(target, [left, right], () => {}, { logHandlers: [(entry) => entries.push(entry)] });

    const merged = dispatch(target, stop());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(merged.kind).toBe(ResultKind.Error);
    expect(merged.code).toBe("SF059");
    expect(entries[0].finalResultData?.code).toBe("SF059");
  });

  it("a merge of an uncoded Error and a later engine error names the engine's code", () => {
    const { target } = newLamp((sm) => {
      sm.addEnterHandler(lamp.warming, () => HandlerResult.error(new Error("no bulb")));
      sm.addEnterHandler(lamp.warming, (() => "not a result") as never);
    });
    const merged = dispatch(target, go());

    expect(merged.code).toBe("SF053");
  });

  it("the package's declarations import no JSON file, so a consumer type-checks them without resolveJsonModule", () => {
    const root = join(__dirname, "../..");
    const { config } = ts.readConfigFile(join(root, "tsconfig.dts.json"), ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
    const program = ts.createProgram([join(root, "src/index.ts")], options);
    const importsJson: string[] = [];
    // Emitted to memory only: the write callback collects each declaration file that imports a .json module.
    program.emit(
      undefined,
      (name, text) => {
        if (/from\s+["'][^"']*\.json["']/.test(text)) {
          importsJson.push(name);
        }
      },
      undefined,
      true,
    );

    expect(importsJson).toEqual([]);
  });

  it("the package exports its root only: the table is not a file of the package", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));

    expect(Object.keys(pkg.exports)).toEqual(["."]);
  });

  it("an Error result's code is its error's code when the engine raised it, and null for any other error", () => {
    const coded = newLamp((sm) => sm.addTransitionHandler(lamp.on, noPromise));
    const plain = newLamp((sm) =>
      sm.addEnterHandler(lamp.warming, () => {
        throw new Error("no bulb");
      }),
    );

    expect(dispatch(plain.target, go()).code).toBeNull();
    return dispatch(coded.target, go())
      .done()
      .then((final) => {
        expect(final.kind).toBe(ResultKind.Error);
        expect(final.code).toBe("SF052");
        expect(final.error?.message).toBe(`Transition handler 'noPromise' returned no promise${suffix("SF052")}`);
      });
  });

  it("expect() throws with its own code; the error of the result it refused, when it has one, is the cause", () => {
    const { target } = newLamp((sm) => sm.addEnterHandler(lamp.warming, (() => "not a result") as never));
    const ignored = dispatch(target, stop());
    const refused = dispatch(target, refuse());
    const failed = dispatch(target, go());

    expect(() => failed.expect(ResultKind.OK)).toThrow(expect.objectContaining({ code: "SF066", cause: failed.error }));
    expect(failed.error).toMatchObject({ code: "SF053" });
    // A refusal has no error to point to: expect() on it has no cause.
    expect(() => ignored.expect(ResultKind.OK)).toThrow(expect.not.objectContaining({ cause: expect.anything() }));
    expect(() => ignored.expect(ResultKind.OK)).toThrow(
      expect.objectContaining({
        code: "SF066",
        message: `[SF] Signal 'stop{}' was ignored: Message: no reducer for stop in lamp.off${suffix("SF066")}`,
      }),
    );
    expect(() => refused.expect(ResultKind.OK)).toThrow(
      expect.objectContaining({
        code: "SF066",
        message: `[SF] Signal 'refuse{}' was rejected: Message: not now${suffix("SF066")}`,
      }),
    );
  });

  it("a deferred expect() throws with its own code, the final result's error its cause", async () => {
    const { target } = newLamp((sm) => sm.addTransitionHandler(lamp.on, noPromise));

    const thrown = await dispatch(target, go())
      .expect(ResultKind.OK)
      .done()
      .catch((err: Error) => err);

    // The message embeds the inner error's text with its code, and ends with expect()'s own code and fix.
    expect(thrown).toMatchObject({ code: "SF066", cause: expect.objectContaining({ code: "SF052" }) });
    expect((thrown as Error).message).toContain(`returned no promise${suffix("SF052")}`);
    expect((thrown as Error).message.endsWith(suffix("SF066"))).toBe(true);
  });

  it("a transition that failed aborts its work with its own code, whatever the refusal's", async () => {
    const reasons: unknown[] = [];
    const coded = newLamp((sm) => {
      sm.addTransitionHandler(lamp.on, async (_s, _snapshot, _prev, _key, signal) => {
        signal.addEventListener("abort", () => reasons.push(signal.reason));
        return HandlerResult.ok();
      });
      sm.addTransitionHandler(lamp.on, noPromise);
    });
    await dispatch(coded.target, go()).done();

    const plain = newLamp((sm) => {
      sm.addTransitionHandler(lamp.on, async (_s, _snapshot, _prev, _key, signal) => {
        signal.addEventListener("abort", () => reasons.push(signal.reason));
        return HandlerResult.rejected("no power");
      });
    });
    await dispatch(plain.target, go()).done();

    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toBeInstanceOf(TransitionAborted);
    expect(reasons[0]).toMatchObject({ kind: "failed", code: "SF034" });
    expect(reasons[1]).toMatchObject({ kind: "failed", code: "SF034", message: `failed: no power${suffix("SF034")}` });
  });

  it("an abort whose reducer fails is refused with its own code, the reducer's error its cause", async () => {
    const { target } = newLamp((sm) => sm.addTransitionHandler(lamp.on, () => new Promise(() => {})));
    dispatch(target, go());

    const result = dispatch(target, stop(), { abort: true });

    expect(result.kind).toBe(ResultKind.Error);
    expect(result.code).toBe("SF039");
    expect(result.error?.cause).toMatchObject({ code: "SF059" });
    expect(result.error?.message).toBe(
      `lamp: the reducer of lamp.warming for stop returned a promise; reducers are synchronous${suffix("SF059")}; the transition continues${suffix("SF039")}`,
    );
  });

  it("an accepted abort aborts the work with SF040 and ends the transition Rejected with SF040", async () => {
    const reasons: unknown[] = [];
    const quiet = defineSignal("quiet");
    const bulb = defineState<{ n: number }>()
      .name("bulb")
      .signals({ go, quiet })
      .variant("off", { initial: true })
      .variant("warming", { transitional: true })
      .variant("on", { async: true })
      .build();
    defineFlow(bulb.off, { go: (s) => StateResult.transition(bulb.on(s), bulb.warming(s), bulb.off(s)) });
    defineFlow(bulb.warming, { quiet: (s) => bulb.off(s) });
    defineFlow(bulb.on, {});
    const target = { bulb: { n: 0 } };
    applyFlow(target, [bulb], (sm) =>
      sm.addTransitionHandler(bulb.on, (_s, _snapshot, _prev, _key, signal) => {
        signal.addEventListener("abort", () => reasons.push(signal.reason));
        return Promise.resolve(HandlerResult.ok());
      }),
    );
    const started = dispatch(target, go());
    dispatch(target, quiet(), { abort: true });
    const outcome = await started.done();

    expect(reasons[0]).toMatchObject({ kind: "aborted", code: "SF040", message: `aborted by quiet${suffix("SF040")}` });
    expect(outcome.kind).toBe(ResultKind.Rejected);
    expect(outcome.message).toBe("aborted by quiet");
    expect(outcome.code).toBe("SF040");
  });

  it("a log entry's data names the result's code, null where there is none", async () => {
    const { target, entries } = newLamp((sm) => {
      sm.addEnterHandler(lamp.warming, () => HandlerResult.error(new Error("no bulb")));
      const notAResult = (() => "not a result") as never;
      sm.addEnterHandler(lamp.warming, notAResult);
    });
    dispatch(target, stop());
    dispatch(target, refuse());
    dispatch(target, go());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(entries.map((entry) => entry.finalResultData)).toEqual([
      { kind: "Ignored", message: "no reducer for stop in lamp.off", code: "SF064", errors: [] },
      { kind: "Rejected", message: "not now", code: null, errors: [] },
      {
        kind: "Error",
        message: null,
        code: "SF053",
        errors: [
          { name: "Error", message: "no bulb" },
          { name: "StateFlowError", message: `Handler 'notAResult' did not return a HandlerResult${suffix("SF053")}` },
        ],
      },
    ]);
  });
});
