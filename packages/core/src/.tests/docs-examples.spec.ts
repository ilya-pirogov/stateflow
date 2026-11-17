import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The code blocks of the documentation, README.md and every page.md of the docs site, checked against the engine's
 * source.
 *
 * - A fence is ``` or ~~~, of any length and indentation. Every block in `typescript` or `ts` compiles, under the
 *   compiler options of the installation page's tsconfig block, and runs, as below. A block marked
 *   `{% shorthand=true %}` is an API signature in shorthand: it does not compile, every statement in it must declare
 *   an export of the engine by name (a function, class, interface, type or enum), and every member it lists must be
 *   a member of that export. A block marked
 *   `{% unchecked="<reason>" %}`, and a block in another language, is a skipped test here that names its page, its
 *   line and the reason, so the run's summary counts every block it did not check.
 * - A block that imports from "@state-flow/core" or "vitest" is a file of its own. One whose first line is
 *   `// <name>.ts` is that file, which the other blocks import as "./<name>", from any page.
 * - Every other block is a fragment: a page's fragments make one module, in the page's order, with every export of
 *   the engine and of vitest imported and the page's stand-ins below defined.
 * - Every module runs, and the tests it defines run too.
 * - A stated outcome is checked where it runs: a top-level statement followed by a `//` comment that is a string, a
 *   number, `true`, `false` or an array, alone or before a colon, becomes `expect(<statement>).toEqual(<comment>)`.
 *   The comment is the one on the statement's line (`String(media); // "media.playing"`) or, when that line has
 *   none, the comment lines right below it. `console.log` returns here what it would print, its arguments' string
 *   forms joined by a space, so `console.log(x); // "<text>"` is checked the same way.
 * - Not checked: an outcome stated in words (a result's kind, as in `// Rejected: aborted by stop`, included), in a
 *   block comment, in a comment inside a function, or as a value that starts on the statement's line and goes on
 *   below it; a shorthand block's parameters and types.
 *
 * A module written for the compiler keeps its page's line numbers: line N is line N of the page, every line outside
 * its blocks is empty, a fragment module's stand-ins are on line 1 (a page's first line is never inside a block),
 * and the imports a module needs come after the last line (imports hoist).
 */

const repo = join(__dirname, "../../../..");
// Under the repository, so the modules resolve "vitest" and "events" from its node_modules; ignored by git.
const out = join(repo, ".docs-examples");

// Node has no DOM: the element `document.querySelector` returns to the blocks, and `window`.
const element = { addEventListener() {}, removeEventListener() {}, play: async () => {}, pause() {}, duration: 120 };
Object.assign(globalThis, { document: { querySelector: () => element }, window: element });
// A block's `console.log(...)` gives what it would print, for the outcome stated after it.
console.log = (...values: unknown[]) => values.join(" ");

/**
 * What a page names as the application's own code and does not define, by page. A name a page uses that is neither
 * here, in the engine nor on the page fails the check. Each has a value, the smallest one the page's fragments run
 * with: an `app` target is applied to no state, or to one that takes the signals the page sends it and expects OK.
 */
const standIns: Record<string, string> = {
  "docs/src/app/docs/api-reference/page.md": `
    const app: any = {};
    applyFlow(app, [], () => {});
    const signals: any = new Proxy({}, { get: (_, name) => defineSignal(String(name)) });
    const fakeManifest: Manifest = { url: "", tracks: [] };
    const mediaStream = { getTracks: () => [] } as unknown as MediaStream;
    function parseLoaded(data: unknown): { manifest: Manifest } { return data as { manifest: Manifest }; }
    async function fetchManifest(url: string, init: { signal: AbortSignal }): Promise<Manifest | null> {
      return fakeManifest;
    }
    function attach(manifest: Manifest): void {}
    function detach(): void {}
    function showError(reason: string | null): void {}
    async function processPayment(total: number, init: { signal: AbortSignal }): Promise<void> {}
    function createProducer(track: Track): RtpProducer { return { close() {} }; }
    function startPoll(url: string): Poll { return { stop() {} }; }
    function openConnection(url: string): Connection { return { send() {}, [Symbol.dispose]() {} }; }`,
  "docs/src/app/docs/architecture-guide/page.md": `
    const sm = new Proxy({}, { get: () => () => {} }) as StateManager;
    const video = document.querySelector("video") as HTMLVideoElement;
    const auth = { token: async (init: { signal: AbortSignal }) => "token" };
    async function openSocket(url: string, token: string, init: { signal: AbortSignal }): Promise<Socket> {
      return { send() {}, onDrop() {}, [Symbol.dispose]() {} };
    }
    async function probeDuration(url: string, init: { signal: AbortSignal }): Promise<number> { return 120; }
    function hideConnectingIndicator(): void {}
    function loadSource(url: string): void {}
    function createDecoder(codec: string): Decoder { return { close() {} }; }
    function renderMedia(state: unknown): void {}`,
  "docs/src/app/docs/boxing-live-resources/page.md": `
    const mediaStream = { getTracks: () => [] } as unknown as MediaStream;
    function openConnection(url: string): Connection { return { send() {}, [Symbol.dispose]() {} }; }
    async function connect(init: { signal: AbortSignal }): Promise<Connection> { return openConnection(""); }`,
  "docs/src/app/docs/core-concepts/page.md": `
    async function upload(text: string, init: { signal: AbortSignal }): Promise<{ revision: number }> {
      return { revision: 1 };
    }
    function showError(reason: string | null): void {}
    function startPoll(url: string): Poll { return { stop() {} }; }
    function subscribe(room: string): Subscription { return { [Symbol.dispose]() {} }; }`,
  "docs/src/app/docs/design-principles/page.md": `
    import { quality } from "./quality";
    const mediaSignals = { play: defineSignal("play"), seek: defineSignal<{ position: number }>("seek") };
    const player = defineState<{ position: number }>()
      .name("player")
      .signals(mediaSignals)
      .variant("on", { initial: true })
      .build();
    defineFlow(player.on, { play: (s) => s, seek: (s, { position }) => ({ position }) });
    const app: any = { player: player.on({ position: 0 }) };
    applyFlow(app, [player], () => {});
    const sm = new Proxy({}, { get: () => () => {} }) as StateManager;
    const email = "alice@example.com";
    const password = "a long password";
    function switchTo(id: string): void {}
    function updateUi(state: unknown): void {}`,
  "docs/src/app/docs/media-player-example/page.md": `
    function showLoadingSpinner(): void {}
    function hideLoadingSpinner(): void {}
    function setBufferingIndicator(stalled: boolean): void {}`,
  "docs/src/app/docs/signal-system/page.md": `
    function parseHits(data: unknown): { hits: readonly Hit[] } { return data as { hits: readonly Hit[] }; }`,
  "docs/src/app/docs/state-consistency/page.md": `
    const sm = new Proxy({}, { get: () => () => {} }) as StateManager;
    function startPoll(url: string): Poll { return { stop() {} }; }
    async function startMediaPlayback(init: { signal: AbortSignal }): Promise<boolean> { return true; }
    function hideSpinner(): void {}
    function showReason(reason: string | null): void {}`,
  "docs/src/app/docs/state-visibility/page.md": `
    const app: any = { connection: { url: "", attempts: 0, lastError: null } };
    const errorReporter = { report(message: string, details: object) {} };`,
  "docs/src/app/docs/testing/page.md": `
    import { driverState, type Manifest } from "./player";
    const fakeManifest: Manifest = { url: "https://example.com/a", tracks: ["video"] };`,
};

/** A fenced code block: the line of its opening fence, counted from 1, and the lines between its fences. */
type Block = { line: number; language: string; marker: string; lines: string[] };

const engine = "../packages/core/src";
const engineExports = ts
  .createSourceFile("index.ts", readFileSync(join(__dirname, "../index.ts"), "utf8"), ts.ScriptTarget.Latest)
  .statements.filter(ts.isExportDeclaration)
  .flatMap((statement) => (statement.exportClause as ts.NamedExports).elements.map((element) => element.name.text));

const pages = [
  "README.md",
  ...readdirSync(join(repo, "docs/src/app"), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith("page.md"))
    .map((path) => `docs/src/app/${path}`)
    .sort(),
];

/** Turns each top-level statement of `text` followed by a stated outcome into an assertion of it, on its own lines. */
function assertStated(text: string): string {
  const source = ts.createSourceFile("module.ts", text, ts.ScriptTarget.Latest);
  let result = text;
  // The line comment on a statement's line or, when it has none, the run of line comments right below it. Sticky
  // (`y`): it matches only at `lastIndex`, the statement's end.
  const after = / *\/\/(.*)|\n((?: *\/\/.*(?:\n|$))+)/y;
  // From the last statement back, so the positions of the earlier ones still hold.
  for (const statement of source.statements.filter(ts.isExpressionStatement).reverse()) {
    after.lastIndex = statement.end;
    const comment = after.exec(text) ?? [];
    const stated = /^ ("[^"]*"|-?\d+|true|false|\[.*\])(:.*)?$/s.exec(
      comment[1] ?? (comment[2] ?? "").replace(/^ *\/\//gm, "").trimEnd(),
    )?.[1];
    if (stated !== undefined) {
      const value = statement.expression.getText(source);
      result = `${result.slice(0, statement.getStart(source))}expectStated(${value}).toEqual(${stated});${result.slice(statement.end)}`;
    }
  }
  return result;
}

/**
 * Writes `blocks` of a page of `pageLines` lines into a module at their own lines, `head` on line 1 and `tail` after
 * the last; an import from the engine's package name imports its source instead.
 */
function writeModule(file: string, pageLines: number, head: string, blocks: Block[], tail: string): void {
  const lines = new Array<string>(pageLines).fill("");
  lines[0] = head.replaceAll("\n", " ");
  for (const block of blocks) {
    lines.splice(block.line, block.lines.length, ...block.lines);
  }
  const text = lines.join("\n").replaceAll('from "@state-flow/core"', `from "${engine}"`);
  writeFileSync(file, assertStated(`${text}\nimport { expect as expectStated } from "vitest";\n${tail}\n`));
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const files: string[] = [];
const runs: Array<[at: string, file: string]> = [];
// A shorthand block's fence line, and its code parsed alone under its page's name.
const shorthands: Array<[line: number, block: ts.SourceFile]> = [];
const skipped: string[] = [];
for (const page of pages) {
  const text = readFileSync(join(repo, page), "utf8");
  const pageLines = text.split("\n").length;
  // A fence: its indentation, ``` or ~~~ of any length, a language and maybe a marker, then the lines up to the same
  // fence, which Markdown requires to close it.
  const blocks: Block[] = [...text.matchAll(/^( *)(`{3,}|~{3,})(\w*) ?(.*)\n([\s\S]*?)^\1\2$/gm)].map((match) => ({
    line: text.slice(0, match.index).split("\n").length,
    language: match[3],
    marker: match[4],
    lines: match[5]
      .split("\n")
      .slice(0, -1)
      .map((line) => line.slice(match[1].length)),
  }));
  const fragments: Block[] = [];
  for (const block of blocks) {
    const at = `${page}:${block.line}`;
    const code = block.lines.join("\n");
    const unchecked = /^\{% unchecked="([^"]*)" %\}$/.exec(block.marker)?.[1];
    if (!/^(typescript|ts)$/.test(block.language) || unchecked !== undefined) {
      skipped.push(`${at} is not checked: ${unchecked ?? `a ${block.language || "plain"} block`}`);
    } else if (block.marker === "{% shorthand=true %}") {
      shorthands.push([block.line, ts.createSourceFile(page, code, ts.ScriptTarget.Latest)]);
    } else if (/from "(@state-flow\/core|vitest)";$/m.test(code)) {
      const file = join(out, `${/^\/\/ ([\w-]+)\.ts$/.exec(block.lines[0])?.[1] ?? at.replace(/\W/g, "_")}.ts`);
      writeModule(file, pageLines, "", [block], "");
      files.push(file);
      runs.push([at, file]);
    } else {
      fragments.push(block);
    }
  }
  const file = join(out, `${page.replace(/\W/g, "_")}.ts`);
  const imports = `import { ${engineExports.join(", ")} } from "${engine}";`;
  const vitest = 'import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";';
  writeModule(file, pageLines, standIns[page] ?? "", fragments, `${imports}\n${vitest}`);
  files.push(file);
  runs.push([page, file]);
}

// The compiler options of the installation page's tsconfig block.
const installation = readFileSync(join(repo, "docs/src/app/docs/installation/page.md"), "utf8");
const tsconfig = /^```json\n(\{\n {2}"compilerOptions"[\s\S]*?)^```$/m.exec(installation)?.[1] ?? "";
const { options, errors } = ts.convertCompilerOptionsFromJson(JSON.parse(tsconfig).compilerOptions, repo);

describe("the documentation's code blocks", () => {
  it("compile against the engine's source, and their signatures name its exports", () => {
    const program = ts.createProgram(files, options);
    const checker = program.getTypeChecker();
    const index = program.getSourceFile(join(__dirname, "../index.ts")) as ts.SourceFile;
    const exported = new Map(
      checker
        .getExportsOfModule(checker.getSymbolAtLocation(index) as ts.Symbol)
        .map((symbol) => [symbol.name, checker.getAliasedSymbol(symbol)]),
    );
    const misnamed = shorthands.flatMap(([line, block]) =>
      block.statements.flatMap((statement) => {
        // A shorthand function, interface, class, type or enum, by its name; any other statement has none, and fails
        // under its own text.
        const name = (statement as ts.DeclarationStatement).name?.getText(block) ?? statement.getText(block);
        const symbol = exported.get(name);
        const at = `${block.fileName}:${line + 1 + block.getLineAndCharacterOfPosition(statement.getStart(block)).line}`;
        if (symbol === undefined) {
          return [
            `${at}: a shorthand statement is a function, class, interface, type or enum named as an export of the engine; "${name}" is none`,
          ];
        }
        const members = [
          ...checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol)),
          ...(symbol.exports?.values() ?? []),
        ].map((member) => member.name);
        return ((statement as ts.InterfaceDeclaration).members ?? [])
          .map((member) => member.name?.getText(block) ?? "")
          .filter((member) => member !== "" && !members.includes(member))
          .map((member) => `${at}: ${name} has no member ${member}`);
      }),
    );
    const host = ts.createCompilerHost(options);
    const diagnostics = [...errors, ...ts.getPreEmitDiagnostics(program)];
    expect(ts.formatDiagnostics(diagnostics, host) + misnamed.join("\n")).toBe("");
  });

  for (const [at, file] of runs) {
    // vitest awaits an async suite before it runs any test, so a module's tests are collected into this suite. A
    // module that throws, or states an outcome it does not reach, fails the file's collection, and the stack names the
    // module (its page's path) and the page's line. The last test keeps a module without tests from being an empty
    // suite, which fails.
    describe(at, async () => {
      await import(file);
      it("runs to its end", () => {});
    });
  }

  for (const name of skipped) {
    it.skip(name, () => {});
  }
});
