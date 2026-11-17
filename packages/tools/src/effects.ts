/**
 * The list of effects: one line per handler a file registers, with the members of the world its function uses, read
 * from syntax alone, as rules.ts reads it. Checked in, it shows a new handler or world call as one line of a diff.
 *
 * Not seen: a use outside the handler's own function (in a function it calls, in another file, or on a value it was
 * handed or that the world gave back, `p.producer?.deref().close()`); a use of the world written otherwise than as a
 * name the caller gives followed by `.member`: an alias (`const w = world`), destructuring (`const { light } =
 * world`), an element access (`world["light"]`); a nested member past its first (`world.audio.mute()` is
 * `world.audio`, unless `world.audio` is given too); the function of a handler that is neither written in the call
 * nor a name a top-level statement of the file declares (`this.onEnter`, a bound function, a const inside the
 * constructor or a block), whose line has no uses. A name is looked up among the file's top-level statements only, so
 * a local declaration of the same name is not seen and the top-level one is listed in its place, and a variable
 * assigned after its declaration has no uses. An adder is matched by its method name, so another API's method of that
 * name is listed too.
 */
import ts from "typescript";

/** Every node under `node`, `node` first. */
function nodesOf(node: ts.Node): ts.Node[] {
  return [node, ...node.getChildren().flatMap(nodesOf)];
}

/**
 * What `expression` names: the function or variable of that name a top-level statement of its file declares, so in
 * scope everywhere in the file (one in a block, a loop or a function is not), the last such, which for a function
 * with overloads is the one with the body; else `expression` itself.
 */
function declared(expression: ts.Expression): ts.Node {
  return (
    nodesOf(expression.getSourceFile()).findLast(
      (n) =>
        (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) &&
        n.name?.getText() === expression.getText() &&
        // Above a variable stand its declaration list and its statement; above those, or above a function, the file.
        ts.findAncestor(n.parent, (up) => !ts.isVariableDeclarationList(up) && !ts.isVariableStatement(up))?.kind ===
          ts.SyntaxKind.SourceFile,
    ) ?? expression
  );
}

/** The line of `call` when it registers a handler, as listEffects says; none for any other call. */
function lineOf(call: ts.CallExpression, world: string[]): string[] {
  const kind = /(?:^|\.)add(Enter|Exit|Update|Transition|Commit)Handler$/.exec(call.expression.getText())?.[1];
  // The engine's adders take the variant, then the handler.
  const [variant, handler] = call.arguments;
  if (kind === undefined || variant === undefined || handler === undefined) {
    return [];
  }
  // The engine names a handler by its function's name, "" for an arrow or an anonymous function.
  const name = ts.isFunctionLike(handler) ? (ts.getNameOfDeclaration(handler)?.getText() ?? "") : handler.getText();
  const uses = nodesOf(declared(handler))
    .filter(
      (n): n is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(n) && world.includes(n.expression.getText()),
    )
    // Written without a `?.`, so `world?.light()` and `world.light()` are one use.
    .map((n) => `${n.expression.getText()}.${n.name.text}`);
  return [[`${variant.getText()} ${kind.toLowerCase()} ${name}:`, ...new Set(uses)].join(" ")];
}

/**
 * One line per handler registration in `text`, the source of `file` (whose extension says whether it is TSX), in file
 * order: `<variant> <kind> <name>: <uses>`. The variant is the registration's text (`driverState.active` where the
 * engine names the state `driver`); the kind is as the engine's listHandlers gives it; the name is the handler's
 * function's name, "" for an arrow, as listHandlers gives it, or the registration's text for a handler given by name
 * (the engine says `load` for `const h = function load`), without the class the engine puts before it for a handler
 * registered with a context (`Owner.on`). The uses are each `<world>.<member>` the
 * handler's function, its callbacks included, reads or calls on an expression written as one of `world` (`world`,
 * `this.world`): each once, in the order first written, space-separated.
 */
export function listEffects(file: string, text: string, world: string[]): string[] {
  return nodesOf(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
    .filter(ts.isCallExpression)
    .flatMap((call) => lineOf(call, world));
}
