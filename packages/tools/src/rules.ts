/**
 * Static rules about using StateFlow, read from a file's syntax alone: no types, no data flow.
 *
 * What the rules cannot see:
 * - An engine function is seen only when called by its own bare name, so an import under another name and a namespace
 *   call (`sf.dispatch(...)`) are not seen.
 * - Another library's function of an engine function's name (a two-argument `dispatch`, a `lock`, a `defineFlow`, a
 *   method named like a handler adder) is checked as the engine's.
 * - A local function named `lock` or `dispatch` is checked as the engine's.
 * - unnamed-handler judges only a function written in the call, so a handler passed through a variable is not seen.
 * - clock-in-reducer reads only defineFlow's arguments, so a reducer kept in a const and named there is not seen.
 * - catch-around-lock does not see a lock inside a function the try only calls, since whether its refusal reaches the
 *   catch is data flow; nor a catch on the lock's own promise chain (`lock(t).then(...).catch(...)`).
 * - bare-dispatch cannot tell a synchronous teardown from other code, so it reports a teardown's dispatch, which the
 *   reader keeps.
 * - import-in-state-file knows a relative import's file only when it is given, by its path with the extension cut, so
 *   it passes one of a file not given or named as a folder (`./track` for track/index.ts); it reports a path alias
 *   (`@/signals`) and a package of the workspace as any package. It passes any value of a file that calls defineState,
 *   defineFlow or defineSignal, so a state file reaches the world through such a file that also exports a device. It
 *   sees a state file only by a bare call (the first limit), and no dynamic import(), require, `import x = require()`
 *   or re-export (`export ... from`).
 *
 * Candidates tried and not shipped, as syntax cannot tell them from correct code:
 * - A send's outcome read before its `done()`: a queued send and a send that declares a transition both answer
 *   InTransition at once, and expect() asserts nothing on those two, so whether a read comes too early is data flow.
 * - A clock read anywhere in a file that calls defineFlow: such a file holds code that is no reducer, such as a spec's
 *   helper that stamps a log entry with Date.now(), so clock-in-reducer reads only defineFlow's arguments.
 */
import { dirname, resolve } from "node:path";
import ts from "typescript";

/** One place in a source file where a rule found a mistake in using StateFlow. `line` counts from 1. */
export interface Finding {
  rule: string;
  file: string;
  line: number;
  fix: string;
}

/** A call of a function of one of `names` by its bare name: `name(...)`, not `x.name(...)`. */
function isCallOf(node: ts.Node, ...names: string[]): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text);
}

/** The name an expression ends in: `Date` for `Date` and `window.Date`, `init` for `init` and `this.init`. */
function lastName(expression: ts.Expression): string {
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.getText();
}

/**
 * The names of the setups the file of `node` passes to applyFlow by name, `init` or `this.init`; a setup written in
 * place adds its own text, which names no function.
 */
function setupNames(node: ts.Node): string[] {
  return isCallOf(node, "applyFlow") && node.arguments[2] !== undefined
    ? [lastName(node.arguments[2])]
    : node.getChildren().flatMap(setupNames);
}

/** Whether `node` or a node under it calls a function of one of `names` by its bare name. */
function calls(node: ts.Node, ...names: string[]): boolean {
  return isCallOf(node, ...names) || node.getChildren().some((child) => calls(child, ...names));
}

// Each rule is asked about every node of a file, with the paths of the files given that call none of defineState,
// defineFlow and defineSignal (their extension cut, as an import names them); a node it matches is a finding at that
// node's first line.
const rules = [
  {
    name: "unnamed-handler",
    fix: "Register a named function (a declaration, a named function expression or a const holding it), so the log names the handler.",
    // The engine names a handler by its function's name (utils.ts buildName); an arrow or anonymous function has
    // none, in parentheses or under a cast too. An adder is matched by its name, called as a method or destructured,
    // so another API's method of that name (a router's addEnterHandler) is reported too: only types tell them apart.
    matches: (node: ts.Node) => {
      if (!ts.isCallExpression(node) || node.arguments[1] === undefined) {
        return false;
      }
      let handler = node.arguments[1];
      while (ts.isParenthesizedExpression(handler) || ts.isAsExpression(handler) || ts.isSatisfiesExpression(handler)) {
        handler = handler.expression;
      }
      return (
        /(^|\.)add(Enter|Exit|Update|Transition|Commit)Handler$/.test(node.expression.getText()) &&
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
        handler.name === undefined
      );
    },
  },
  {
    name: "catch-around-lock",
    fix: "Take the lock outside any try with a catch: a refused lock or send is the caller's error, and await using releases the lock.",
    // A refused lock is swallowed by the nearest try block with a catch around it. A function in between ends the
    // search, called at once or not: a lock inside a function the try only calls is not seen, since whether its
    // refusal reaches the catch is data flow.
    matches: (node: ts.Node) => {
      if (!isCallOf(node, "lock")) {
        return false;
      }
      // findAncestor (TypeScript's API) returns the nearest node from the one given up that the callback accepts.
      const catcher = ts.findAncestor(
        node.parent,
        (up) =>
          ts.isFunctionLike(up) ||
          (ts.isBlock(up) &&
            ts.isTryStatement(up.parent) &&
            up.parent.tryBlock === up &&
            up.parent.catchClause !== undefined),
      );
      return catcher !== undefined && !ts.isFunctionLike(catcher);
    },
  },
  {
    name: "bare-dispatch",
    fix: "Send under the lock (await using send = await lock(target)), as a bare dispatch throws while another caller holds the lock, unless this is one of the places where dispatch's doc allows it bare: applyFlow's setup, a constructor's dispatch to this, a dispatch with { abort: true }, or a synchronous teardown that cannot await a lock.",
    // dispatch's doc comment (flow.ts) allows it before any lock exists (applyFlow's setup, given in place or by
    // name, and a constructor's dispatch to its own object, as another object's flow can be locked already), in a
    // synchronous teardown and for an abort. A function written inside a setup (a handler, a timer's callback) runs
    // later, so it is reported. Syntax cannot tell a synchronous teardown from other code, so the rule reports a
    // teardown's dispatch and the reader keeps it. A setup by name is matched by its name alone, so a function of
    // that name anywhere in the file is passed. The engine's dispatch takes a target and a signal, so a one-argument
    // dispatch (React's, a lock's send) is someone else's.
    matches: (node: ts.Node) => {
      if (!isCallOf(node, "dispatch") || node.arguments.length < 2) {
        return false;
      }
      const home = ts.findAncestor(node.parent, ts.isFunctionLike);
      const options = node.arguments[2];
      const aborts =
        options !== undefined &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            // A name with a text, an identifier or a quoted key, so `abort` and `"abort"` are the same property.
            "text" in p.name &&
            p.name.text === "abort" &&
            p.initializer.kind === ts.SyntaxKind.TrueKeyword,
        );
      return !(
        aborts ||
        (home !== undefined &&
          ((ts.isConstructorDeclaration(home) && node.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword) ||
            isCallOf(home.parent, "applyFlow") ||
            setupNames(node.getSourceFile()).includes(ts.getNameOfDeclaration(home)?.getText() ?? "")))
      );
    },
  },
  {
    name: "clock-in-reducer",
    fix: "Read the time where the signal is sent and pass it in the payload: a reducer that reads the clock is not pure.",
    // Date.now(), performance.now() or a new Date with no argument, any object's Date or performance too (globalThis,
    // window, self), inside a defineFlow call's arguments, where reducers are written in place; a reducer kept in a
    // const and named there is not seen.
    matches: (node: ts.Node) =>
      ((ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "now" &&
        ["Date", "performance"].includes(lastName(node.expression.expression))) ||
        (ts.isNewExpression(node) && lastName(node.expression) === "Date" && (node.arguments ?? []).length === 0)) &&
      ts.findAncestor(node.parent, (up) => isCallOf(up, "defineFlow")) !== undefined,
  },
  {
    name: "import-in-state-file",
    fix: "A state file, one that calls defineState or defineFlow, imports values only from @state-flow/core and, by a relative path, from a file that calls defineState, defineFlow or defineSignal or one not among those checked; anything else only as types, with `import type`, so no reducer can reach the world through an import.",
    // A file of signals and handlers holds no reducer, so it is not checked and a state file may import its signals.
    // Only `import type` counts as types: `import { type A } from "x"` still loads "x" under verbatimModuleSyntax, and
    // biome's useImportType rewrites an all-type import as `import type`. Every import has a string literal for its
    // module; the check only narrows the type.
    matches: (node: ts.Node, noDefinitionFiles: string[]) =>
      ts.isImportDeclaration(node) &&
      node.importClause?.isTypeOnly !== true &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text.startsWith(".")
        ? noDefinitionFiles.includes(
            resolve(dirname(node.getSourceFile().fileName), node.moduleSpecifier.text).replace(/\.[cm]?[jt]sx?$/, ""),
          )
        : node.moduleSpecifier.text !== "@state-flow/core") &&
      calls(node.getSourceFile(), "defineState", "defineFlow"),
  },
];

/**
 * The findings of every rule in `files`, each a path and its source, the path's extension saying whether it is TSX,
 * in the order given. A relative import is resolved against its file's path, and a relative path against the working
 * folder.
 */
export function checkSources(files: Array<[file: string, text: string]>): Finding[] {
  // A file's name as given, for its findings, and its source, whose fileName TypeScript normalizes (`a\b.ts` is
  // `a/b.ts`), as the name a relative import is resolved against.
  const sources = files.map(
    ([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)] as const,
  );
  const noDefinitionFiles = sources
    .filter(([, source]) => !calls(source, "defineState", "defineFlow", "defineSignal"))
    .map(([, source]) => resolve(source.fileName).replace(/\.[cm]?[jt]sx?$/, ""));
  const findings: Finding[] = [];
  // The file being visited, so that a node's file is not looked up through its parents.
  let file: string;
  let source: ts.SourceFile;
  const visit = (node: ts.Node): void => {
    findings.push(
      ...rules
        .filter((rule) => rule.matches(node, noDefinitionFiles))
        .map((rule) => ({
          rule: rule.name,
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          fix: rule.fix,
        })),
    );
    ts.forEachChild(node, visit);
  };
  for ([file, source] of sources) {
    visit(source);
  }
  return findings;
}
