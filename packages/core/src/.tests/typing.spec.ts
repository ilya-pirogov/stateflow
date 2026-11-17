import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  defineState,
  type EnterHandler,
  type HandlerMocks,
  type HandlerResult,
  type InstanceOf,
  type Result,
  type StateHandler,
  StateResult,
  type TransitionHandler,
  type UpdateHandler,
} from "..";
import { type DEF, IS_ASYNC, type VARIANT } from "../symbols";

/**
 * Typing. A claim that something does not compile is pinned by a compile fixture: `fixtures/typing.ts`
 * marks each line that must fail with a trailing `// EXPECT ERROR`, and the fixture compiled through the
 * TypeScript compiler API with the repository's compiler options must report diagnostics on exactly those lines.
 * tsconfig.json leaves the fixtures directory out, so typecheck does not fail on them. Relations that hold are
 * checked with expectTypeOf below.
 */
describe("typing", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

  /** The 1-based lines of `file` with a diagnostic, and those marked `// EXPECT ERROR`, each with its text. */
  function compile(file: string): { diagnosed: Map<number, string>; marked: number[] } {
    const config = ts.readConfigFile(join(repo, "tsconfig.json"), ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, repo);
    const program = ts.createProgram([file], options);
    const source = program.getSourceFile(file);
    if (source === undefined) {
      throw new Error(`the compiler did not read ${file}`);
    }
    const diagnosed = new Map<number, string>();
    for (const diagnostic of ts.getPreEmitDiagnostics(program, source)) {
      const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
      diagnosed.set(line, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    }
    const marked = source.text.split("\n").flatMap((text, i) => (/\/\/ EXPECT ERROR\s*$/.test(text) ? [i + 1] : []));
    return { diagnosed, marked };
  }

  it("the fixture fails to compile exactly on its marked lines", () => {
    const { diagnosed, marked } = compile(join(repo, "src/.tests/fixtures/typing.ts"));

    // The messages of unmarked lines show in the failure, so a wrong typing is readable from it.
    const unexpected = [...diagnosed].filter(([line]) => !marked.includes(line));
    expect(unexpected).toEqual([]);
    expect([...diagnosed.keys()].sort((a, b) => a - b)).toEqual(marked);
    expect(marked.length).toBeGreaterThan(0);
  }, 60_000); // A program over the package's sources takes the compiler a few seconds.

  describe("relations that hold", () => {
    const driver = defineState<{ url: string; manifest: string | null }>()
      .name("driver")
      .variant("idle", { initial: true })
      .variant("active", { async: true, results: { loaded: (data) => data as { manifest: string } } })
      .build();

    it("a variant declared with { async: true } carries true as its mark in its type, every other variant false", () => {
      expectTypeOf(driver.active[IS_ASYNC]).toEqualTypeOf<true>();
      expectTypeOf(driver.idle[IS_ASYNC]).toEqualTypeOf<false>();
    });

    it("a variant's result factory takes the parser's return type and returns a HandlerResult of that variant", () => {
      expectTypeOf(driver.active.results.loaded).parameter(0).toEqualTypeOf<{ manifest: string }>();
      expectTypeOf(driver.active.results.loaded).returns.toEqualTypeOf<HandlerResult<"driver.active">>();
    });

    it("the four plain results fit every handler; a named result fits its variant's enter and update handlers, not its exit handlers", () => {
      expectTypeOf<HandlerResult>().toMatchTypeOf<HandlerResult<"driver.active">>();
      expectTypeOf<HandlerResult>().toMatchTypeOf<ReturnType<StateHandler<typeof driver.active>>>();
      expectTypeOf<HandlerResult>().toMatchTypeOf<ReturnType<UpdateHandler<typeof driver.active>>>();
      expectTypeOf<HandlerResult<"driver.active">>().toMatchTypeOf<ReturnType<EnterHandler<typeof driver.active>>>();
      expectTypeOf<HandlerResult<"driver.active">>().toMatchTypeOf<ReturnType<UpdateHandler<typeof driver.active>>>();
      expectTypeOf<HandlerResult<"driver.active">>().not.toMatchTypeOf<HandlerResult<"driver.idle">>();
      expectTypeOf<HandlerResult<"driver.active">>().not.toMatchTypeOf<
        ReturnType<StateHandler<typeof driver.active>>
      >();
    });

    it("StateResult and HandlerResult are both Results and neither is the other", () => {
      expectTypeOf<StateResult>().toMatchTypeOf<Result>();
      expectTypeOf<HandlerResult>().toMatchTypeOf<Result>();
      expectTypeOf<StateResult>().not.toMatchTypeOf<HandlerResult>();
      expectTypeOf<HandlerResult>().not.toMatchTypeOf<StateResult>();
    });

    it("ok takes an instance and a failed instance of the same type", () => {
      type Driver = ReturnType<typeof driver.idle>;
      type Failed = Parameters<typeof StateResult.ok<Driver>>[1];
      expectTypeOf<Driver>().toMatchTypeOf<Failed>();
      expectTypeOf(StateResult.ok<Driver>).returns.toEqualTypeOf<StateResult>();
    });

    it("handlers get the instance type of their variant", () => {
      expectTypeOf<Parameters<EnterHandler<typeof driver.active>>[0]>().toEqualTypeOf<
        ReturnType<typeof driver.active>
      >();
      expectTypeOf<ReturnType<typeof driver.active>>().toMatchTypeOf<InstanceOf<typeof driver>>();
    });

    it("a definition's call and its variants' calls return one instance type", () => {
      expectTypeOf<ReturnType<typeof driver>>().toEqualTypeOf<ReturnType<typeof driver.idle>>();
      expectTypeOf<InstanceOf<typeof driver>>().toEqualTypeOf<ReturnType<typeof driver.active>>();
    });

    it("an instance's type carries its state's name, through its variant", () => {
      expectTypeOf<
        InstanceOf<typeof driver>[typeof VARIANT][typeof DEF][typeof Symbol.toStringTag]
      >().toEqualTypeOf<"driver">();
    });

    it("an enter, update or transition handler takes five arguments, the last an AbortSignal, an exit handler four; a transition handler returns a promise of its variant's results", () => {
      expectTypeOf<Parameters<EnterHandler<typeof driver.active>>["length"]>().toEqualTypeOf<5>();
      expectTypeOf<Parameters<EnterHandler<typeof driver.active>>[4]>().toEqualTypeOf<AbortSignal>();
      expectTypeOf<Parameters<UpdateHandler<typeof driver.active>>["length"]>().toEqualTypeOf<5>();
      expectTypeOf<Parameters<UpdateHandler<typeof driver.active>>[4]>().toEqualTypeOf<AbortSignal>();
      expectTypeOf<Parameters<StateHandler<typeof driver.active>>["length"]>().toEqualTypeOf<4>();
      expectTypeOf<Parameters<TransitionHandler<typeof driver.active>>["length"]>().toEqualTypeOf<5>();
      expectTypeOf<Parameters<TransitionHandler<typeof driver.active>>[4]>().toEqualTypeOf<AbortSignal>();
      expectTypeOf<ReturnType<TransitionHandler<typeof driver.active>>>().toEqualTypeOf<
        Promise<HandlerResult<"driver.active">>
      >();
      expectTypeOf<Promise<HandlerResult>>().toMatchTypeOf<ReturnType<TransitionHandler<typeof driver.active>>>();
      expectTypeOf<HandlerMocks<typeof driver.active>["transition"]>().toEqualTypeOf<
        TransitionHandler<typeof driver.active> | undefined
      >();
    });
  });
});
