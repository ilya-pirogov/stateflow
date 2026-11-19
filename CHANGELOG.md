# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A log entry lists under `observers` only the observers, events and watches that fired in the step, and those whose
  compare or predicate threw. One that was evaluated and declined is no longer listed: every event and watch is
  evaluated at every commit, so a flow with many events wrote one record per event into every entry, and the console
  handler printed each as `=> false`.

## [2.0.1] - 2026-11-18

### Changed

- The published bundle targets ES2020 again, as 1.2 did (2.0.0: ES2022). An application whose build does not
  transpile its dependencies ships the bundle as it is, and browsers without native private class members and static
  blocks, Safari before 16.4 among them, could not parse the ES2022 one. Private class fields go through helpers
  again.

### Added

- `@state-flow/tools` is published to npm at the library's version: the development tools for code built on the
  library, shipped as TypeScript source. The release workflow publishes both packages, each in its own job.

## [2.0.0] - 2026-11-17

Every effect now belongs to a state: pure reducers decide, and handlers apply. A handler never
chooses the next state: it succeeds or refuses, the reducer has already named where the state goes in
either case, and data from the world reaches props only as a handler's named result. A run with every
handler switched off therefore reaches the same variants for the same signals as a run in which every
handler and every declared transition succeeds, with the props the world would fill left at their
defaults.

### Removed (breaking)

- The statics `state`, `ignore` and `reject` of `Result` (the last two renamed `ignored` and
  `rejected`, see Changed), `Result<TData>` and its `data`.
- `Result.enqueue` and the follow-up chain: signals queued after a commit, the chain snapshot and its
  restore, the `"rollback"` FlowChange and the `enqueuedSignals` log field. A follow-up is another
  reducer's answer in the same dispatch.
- `Result`'s handler-level `transition(asyncFn, timeout)`. A reducer declares an entry that waits
  for the world instead (see Added).
- `StateManager.addRollbackHandler`. A handler's Rejected or throw still refuses the step, but no
  cleanup runs: what the handlers that ran did stays done. The reducer names where the state goes on a
  refusal (`failed`, see Added); release what a temporary state held in its exit handler, and clean up
  after a failure in the failed state's enter handler.
- `FlowChange.kind`, the `duringTransition` log field, `Result#enqueuedSignals`, `Result#waitAll`,
  `Result#withMeta`, `Result#withEnqueued`, `ResultCollector#logEnqueue`, `#merge` and `#push`, and the
  third parameter of the `ResultCollector` constructor.
- The positional `mute` argument of `dispatch` and `send`; pass `{ mute: true }`.
- The per-dispatch stack capture and what carried it: `StateFlowLogEntry.stacktrace`, `Result#stacktrace`,
  `Result#withStacktrace` and the console handler's stacktrace-viewer line. 1.2 parsed `new Error().stack`
  on every dispatch to record where the signal came from, about a third of a plain dispatch's cost.

### Changed (breaking)

- The types need TypeScript 5.6+: the handler adders use `NoInfer`, and `Items` returns `MapIterator`.
- The published bundle targets ES2022 (1.2: ES2020): private class fields ship natively instead of through
  WeakMap helpers. Node.js 18+ and current browsers run it as before.
- `Result` is abstract. A reducer returns a `StateResult` (`ok`, `transition`, `ignored`, `rejected`,
  `error`), or props or an instance of its own state bare; a handler returns a `HandlerResult` (`ok`,
  `ignored`, `rejected`, `error`, or a named result of its variant); `send()` and `dispatch()` return a
  `Result`. The `ok` and `error` statics of `Result` live on those two classes now. The exported type
  that 1.2 called `StateResult`, what a reducer may return, is `ReducerReturn`.
- `StateResult.ok` and `StateResult.transition` take instances: a reducer answers with props by
  returning them bare. A reducer that returns anything but props, an instance of its own state or a
  `StateResult` is an Error result: in 1.2, another state's instance or a bare OK threw a TypeError,
  and a promise committed an instance with no props.
- `.variant(name, { initial: true })` replaces the boolean second argument of `.variant`, and
  `.signals()` is optional: a state without signals has no signal reducers. `build()` throws for a
  variant named `items`, and for a key of `.signals()` that is not the name of the signal listed under
  it: a reducer runs for the signal whose name is its key, so a reducer under that key would never run.
- Every reducer a signal reaches runs, all on the frozen snapshot from before the signal, and their
  verdicts merge: a Rejected or Error from any reducer refuses the dispatch. 1.2 ran the states in
  order, each seeing the earlier states as the dispatch left them, and stopped at the first refusal.
- A signal that no variant takes is Ignored with the message `no reducer for <signal> in <variants>`;
  1.2 said `no handler in <variants>`.
- A reducer's third argument is a frozen `ReducerContext` (`parent`, `key`); a top-level state's
  definition called on it reads that state as it was before the signal (`power(ctx)`). A write to it
  fails (in strict-mode code it throws, which is the reducer's Error); in 1.2 a reducer could write
  `ctx`, and the write committed without that state's handlers.
- A reducer that returns the instance it was given changes nothing and runs no handler; 1.2 ran its
  update handlers.
- Merging: Error > Rejected > OK > Ignored, and of one kind the first wins, except that two Ignored
  join their messages and two Errors become one Error whose `error` is an `AggregateError` of both and
  whose message joins theirs (`"a; b"`). When the handlers of a step refuse, their failures merge in
  the order they were called, and the log entry's `finalStates` show what committed. 1.2 returned the
  phase's last failure (two Errors merged into `null; null`) and logged the refused snapshot.
- A Rejected or Error result means the signal did not reach its next state: nothing committed, or the
  failed states the reducers declared committed. As a declared transition's outcome, its temp had
  committed first.
- Nothing that is told of a commit can break it: a commit sets every state that changed before any
  observer runs, and a throw from an observer's compare or callback, or from a `subscribeFlow`
  subscriber, is reported with `console.error` and leaves the dispatch's result as it is; a compare's
  throw is also that observer's `error` in the log entry. In 1.2 a compare's throw left that state and
  the ones after it unset and made the dispatch throw, a callback's throw went uncaught, and a
  subscriber's was swallowed without a report.
- Exit handlers receive the instance they leave. Every handler also receives the previous instance as
  its third argument, and a nested state's key in its parent's `Items` as the fourth. The snapshot
  handlers receive is frozen. Enter, exit and update handlers are synchronous: a returned promise is an
  Error that refuses the step.
- A synchronous dispatch to a target, or `disposeFlow` of it, from inside its own dispatch throws; so
  does `disposeFlow` inside a reducer.
- While a transition is pending, the lock holder's sends queue behind it and are reduced in order after
  it ends, and a bare `dispatch` throws; only an abort passes. `sync()` and the release of a lock wait
  until no transition is pending, also one that an abort or a queued send started.
- `observe()` takes only variants of the target's top-level states (not a nested state's, nor one
  outside the flow), since another observer would never fire: such a call does not compile, as the
  target's type must have a prop under each variant's state name, of that state's props or a subtype
  of them, and it throws when the types let it through (a target or a variant typed `any`). A state
  instance's type carries its state's name, so two states with equal props are not one type.
- A parser must return a plain object (prototype `Object.prototype` or `null`): the engine rebuilds a
  node by copying its props without a constructor, so a class instance would lose its private fields.
- A state instance or an `Items` inside a prop's data (an array, a plain object, a `FrozenMap` or a
  `FrozenSet`, frozen or not) is refused when the instance holding it is built: a nested state goes
  directly in a prop.
- Log entries: one per commit, each with its own `dispatchOrder`, the order in which steps started. A
  declared transition writes one per commit, marked by `transition` (`"temp"`, `"final"` or
  `"failed"`), and an accepted abort's entry carries `aborted`, the path of the node whose transition
  it aborted. A refused step and its failed step are one entry. A handler result's type is `enter`,
  `exit`, `update`, `commit` or `transition`, and handler results and state changes name a nested node
  by its path (`media.producers[cam]`).

### Added

- `StateResult.transition(next, temp, failed, options?)`, returned by a reducer: an entry that waits for
  the world. All three ends are required, so a transition always has a state to hold while the work
  runs and a state to end in when it fails; the options (`timeoutMs`, default 500) come fourth only.
  `temp` commits at once, together with the dispatch's other answers (a temp that is the node's own
  instance changes nothing there). The work is every transition handler of every asynchronous variant
  the step from temp to next enters, started together with one `AbortSignal`. OK or Ignored folds the
  work's named results and commits `next`; the first Rejected, Error or throw, or the timeout, commits
  `failed` at once. A transition whose end enters no asynchronous variant, or none with a transition
  handler registered, has no work, and `next` commits inside the send. Entry is a change of variant:
  when `next` keeps temp's variant, the end step enters nothing there, so an asynchronous change of
  props goes through a temp of another variant (`active -> switching -> active`).
- The asynchronous mark, `.variant(name, { async: true })`: the variant's entry waits for the world, and
  the mark, not the registered handlers, decides it. A node enters an asynchronous variant only as the
  `next` of a declared transition: an ok answer, a temp or a failed (the aborted transition's failed end
  included) that enters one is an Error, and `applyFlow` throws for an initial instance that holds one
  at any depth. `async` together with `initial` or `transitional`
  throws when the variant is added. Only an asynchronous variant takes transition handlers:
  `addTransitionHandler` and a transition mock throw for any other, and their types refuse one.
- `addTransitionHandler(variant, fn)`: `(next, snapshot, prev, key, signal) => Promise<HandlerResult>`.
  The signal aborts whenever the work's result will not commit, and its reason is a `TransitionAborted`
  (exported) whose `kind` says why: `aborted`, an abort was accepted (`aborted by <signal>`); `timeout`,
  the work outlasted `timeoutMs` (`<path> did not reach <variant> within <ms> ms`, after `failed`
  committed); `disposed`, `disposeFlow` ran (`flow disposed`); `failed`, a handler of the work
  refused or failed, or every handler succeeded and the end step did not commit (`failed:
  <refusal>`, after `failed` committed). On every kind the handler releases what it acquired, but for
  a `DisposableBox` it returns, which the engine disposes. When `next` commits, the signal never
  aborts. What a handler returns or throws after an accepted abort is dropped and logged as `dropped
  after abort`; after a timeout, a failure or a dispose it is dropped without a report.
- `failed`, the second argument of `StateResult.ok` and the third of `StateResult.transition`: where a
  node goes when a handler refuses its entry, an instance of its state. The step into failed is the
  plain step to the failed instances from where the refused step started, and nothing is rolled back:
  it calls the handlers of the nodes it changes, so an exit the refused step made runs again where the
  failed step leaves the same instance, an enter or update runs again where the failed holds the instance
  the refused step entered or updated, and a node the failed keeps as the same instance gets no call.
  It is a floor: its own handlers cannot stop its commit, and their refusal makes the result an Error.
- `FAILURE`, an exported symbol: the key of the built-in result by which a failed state takes the
  reason of the failure. Any variant takes it, without declaring it, with a result reducer
  `[FAILURE]: (state, { reason }, ctx) => props | instance`; every node a step into failed enters or
  updates folds `{ reason }` through it before the named results of its enter handlers. `reason` is the
  refusal's message for a Rejected and its error's message for an Error. A symbol of its own, not
  from the global registry, so neither a result a variant declares by name nor a symbol user code makes
  (`Symbol.for("FAILURE")` included) collides with it.
- Variant options `{ initial, transitional, async, results }`. A transitional variant commits only as
  the temp of a declared transition: a reducer's answer that would leave a node in it is an Error, so
  the node leaves it when the transition ends. It takes no transition handler; its reducers are abort
  reducers.
- Named results: `results` declares a variant's results, each with the parser of its data; `build()`
  puts a factory per result on the variant (`driver.active.results.loaded(data)`), which only that
  variant's enter and transition handlers may return (`HandlerResult<"driver.active">`); `defineFlow`
  takes the variant's result reducers after its signal reducers, or alone for a state without signals,
  and they fold the data into the entered instance: `(next, data, ctx) => props | instance`, with a
  nested element's key as `ctx.key`.
- Nested states: a prop holding another state's instance, or an `Items` of them (`def.items()`, a map,
  or with `{ key }` a set keyed by each element). The parent decides its children; the engine diffs the
  tree by position and runs the children's handlers, exits children first and enters parents first. One
  signal reaches every reducer in the tree, a nested reducer gets `ctx.parent` and `ctx.key`, a child's
  answer lands in its parent's, and a parent that replaces or removes a child whose own reducer answered
  is an Error. One declared transition per dispatch over the whole tree.
- `send(signal, { abort: true })` and `dispatch(target, signal, { abort: true })` abort a pending
  transition. The signal's reducers run on the committed snapshot; the abort is accepted when they
  commit something and leave no transitional variant, and refused otherwise, with the transition going
  on. An accepted abort aborts the work's signal, waits for the work no longer than what is left of its
  timeout, and commits its own step; the transition's `done()` resolves to Rejected `aborted by
  <signal>`. `disposeFlow` during the transition ends it with no further commit.
- `addCommitHandler(variant, fn)`: runs right after the commit, inside the dispatch; it is not awaited,
  and a throw or a rejected promise is reported, never a failure.
- `setHandlersDisabled(true)`: no handler runs while it is on. It is read at every handler call, so it
  acts on targets set up before it changed; registrations are kept. A declared transition has no work
  meanwhile unless a transition mock is in force. Whether an entry is asynchronous is the variant's
  mark, which the switch does not change.
- `mockHandlers(variant, { enter, exit, update, transition, commit })`: replaces the handlers of one
  variant on every target until disposed, and runs whether handlers are switched off or not.
- `FlowChange.dispatchOrder`: the `dispatchOrder` of the log entry of the step that committed the
  change, so a subscriber can match every change to its entry.
- Exported `StateResult`, `HandlerResult` and `TransitionAborted` classes, `Items`, `FAILURE`, and the
  types `ReducerReturn`, `ReducerContext`, `InstanceOf`, `DispatchOptions`, `FlowConfig`,
  `TransitionOptions`, `EnterHandler`, `StateHandler`, `TransitionHandler`, `CommitHandler`,
  `HandlerMocks` and `FlowSnapshot`.

### Fixed

- A handler's refusal names that handler and the state change it refused, as in `in handler 'guard()'
  was rejected while trying to exit light`; 1.2 named the last handler of the phase, which may not have
  refused, and wrote `thrown an error` and `while tried to`.
- A value with no string form, passed to `StateResult.error` or `HandlerResult.error` or thrown by a
  handler, gives an Error result that logs safely; thrown by an exit, update or enter handler, it
  refuses the step like any throw. In 1.2, `Object.create(null)` passed to `Result`'s `error` threw, a
  handler's throw of such a value made the dispatch throw a TypeError, and logging the result of an
  Error whose `toString` throws threw.
- A handler whose context object has no prototype runs instead of making the dispatch throw a TypeError.
  The handler's name is now read once, at registration, so a context whose name cannot be read is
  refused there.
- `disposeFlow` is idempotent: a second call does nothing, so a listener of a transition's signal may
  dispose its own target. Every other call on a disposed target, a dispatch, an observer registration,
  throws a `StateFlowError` `<name> is disposed`, except a send, which answers `Rejected` with that
  message whatever its lock, a `lock()`, which resolves to such a sender (see Events, watches and
  sibling reads), and `settled`; disposing an observer registered before the teardown does nothing. In
  1.2 a second `disposeFlow`, a dispatch, an observer registration and that disposal threw a TypeError,
  and a lock was granted on the torn-down target. A target never applied throws
  `<target> doesn't contain state flows`, which 1.2 wrote `contains`.
- Disposing an observer removes only that observer. In 1.2 it also removed every other observer of the
  same variant on the same target that shared its callback.

### FAILURE carries the failure's kind

- The data of the `FAILURE` result is `{ kind, reason?, error? }`. `kind` says how the failure came
  about: `rejected`, the refusal of the step, of a transition's work or of its end step was a Rejected;
  `error`, it was an Error (a handler threw or returned one, or a named result did not fold); `timeout`,
  the work outlasted `timeoutMs`; `aborted`, an accepted abort's own step was refused and the step into
  failed ends the transition it aborted in its own failed. `reason` is as before; `error` is the
  failure's Error, on the timeout the `TransitionAborted` of kind `timeout` the work's signal aborts
  with, and absent for a Rejected.

### A handler's refusal carries data to its failed end

- `HandlerResult.rejected(message, data?)` takes a record of plain data about the refusal beside its message, so a
  failed end can decide from data a recording keeps rather than from an error's class. The failed end the refusal
  leads to gets it as `data` in the `FAILURE` result, `{ kind, reason?, error?, data? }`, from a transition handler
  and from an exit, update or enter handler alike, and with kind `aborted` when an accepted abort's own step was
  refused that way. `Result.data` holds it: a tap reads it on the handler's result, and the result of a dispatch
  that such a refusal decided holds it too. A merge keeps the winner's: the earlier of two Rejected, none when an
  Error wins. The failed end gets a frozen shallow copy, as a reducer gets a signal's payload; the engine checks
  nothing in it and prints it nowhere: result text, log entries and `finalResultData` are unchanged. A refusal
  without data gives the `FAILURE` data it gave before.

### Timers injectable through FlowConfig

- `applyFlow`'s config takes `timers`, an object with `setTimeout` and `clearTimeout` methods, which
  every timer of the flow goes through: a declared transition's timeout, the wait of an accepted abort
  (what is left of the timeout), and the delivery of observers and subscribers. Absent, the flow uses
  the global functions, looked up at each call, so fake timers installed after `applyFlow` still apply.
  A simulation passes its own to control time without faking globals.

### A flow starts from given states, an option

- `applyFlow`'s config takes `start`, an object that gives an instance under a state's name, taken as that
  state's committed one in place of the initial variant built from the target's props, for tests and tools
  that begin in the middle of a session. Nothing runs for it: no handler, no log entry, no enter, so the
  instance may be in an asynchronous variant; events and watches compare the first commit with it. A
  variant marked transitional is refused as in an initial instance, and the result-name check runs on it
  too. Nothing else is checked: a name that matches no state is ignored and an instance of another
  definition is taken as it is.

### Taps: told each dispatch, each handler outcome and each step's end

- `addFlowTap(tap)` adds a `FlowTap` that every flow of the page tells, and returns the function that
  removes it. `dispatched(target, signal)` is told of each dispatch before its reducers run, a muted or
  ignored one included; `handled(target, kind, call, result)` of each exit, update, enter and transition
  handler's result, inside the step before it commits (a transition's when its work settles, a late answer
  after the end committed). A commit handler is not told. A tap only observes: a dispatch to the target
  from inside it, and `disposeFlow`, throw as in a handler, and its throw goes to `console.error` without
  stopping the step or the other taps. It is meant for tools that record a session, not for application
  code.
- `FlowTap.ended(target, step)` is told once for every log entry a dispatch writes, a muted one's too,
  once the step and its commit handlers ran: inside the dispatch, but for a transition's end and an
  accepted abort's step, when the work settles or the wait ends. `FlowTapStep` gives the
  dispatch's signal, whether it was sent as an abort, the step's result, the entry's transition mark, the
  changes it committed node by node with their instances, the observers that fired, and the calls of the
  works a timeout, another work's refusal or an accepted abort left unsettled. Every `dispatched` whose
  dispatch returns is followed by exactly one `ended` with the same signal object, and a declared
  transition's end adds one more.

### The final result as data on a log entry

- `StateFlowLogEntry.finalResultData` gives the final result beside the text `finalResult`, so a reader
  need not parse the text: `kind` (the `ResultKind`'s name), `message` (an Ignored or Rejected result's,
  else `null`) and `errors` (`{ name, message }` for each error of an Error result, as strings; two
  Errors the engine merged are listed flat, in merge order, and any other error, a handler's
  AggregateError included, is one item; none for another kind). The text and `message` of the entry are as
  before. A muted dispatch writes no entry, so no data, and an entry has none when reading an error's name
  or message threw while it was built.

### A list of what a flow is made of

- `listStates(states)` lists, as plain data, the definitions it is given in their order: each one's name
  and signals, and per variant, in the order of the definition's keys, its name, its marks (`initial`,
  `transitional`, `async`), the signals it has a reducer for and the named results it declares. A nested
  definition is
  listed only when the caller names it. `listHandlers(target)` lists the handlers registered on a target
  as `{ variant, kind, name }`, whatever mocks and the handlers-off switch say, and throws for a target
  with no flow. Neither lists transitions, which exist only as what a reducer returns, and neither adds
  anything to a dispatch.
- `definitionOf(items)` gives the definition whose instances an Items holds, an empty one's too, so a tool
  that writes an Items as data can name it and build it again.
- `isVariant(value)` tells a state variant from any other value, so a tool that writes a prop holding a variant
  as data can name it.

### Error codes, with the fix beside each error

- Every error the engine raises carries a stable `code` (`SF001` to `SF093`, one per distinct message, never
  reused or renumbered; `SF077` is unused), and its message is the text it had before, then ` [<code>] <fix>`: the
  code and a short fix. The table lives in the repository at `packages/core/src/error-codes.json` and gives each
  code's message, cause and fix; the package does not export it. A refusal whose text the engine writes keeps its
  text, and its result names the code: `Result.code`, also an Error result's code when its error is the engine's,
  and `null` for every other result; a merge that joins two messages names the first code of the two. An error's
  code always names its own text: an error that wraps another ends with its own code and fix, and the error it
  wraps, when there is one, is its `cause`. `finalResultData` gains `code`. A Result keeps its code in one private
  field, `null` on success: one stored `null` per Result, and no other work. Breaking: the constructors are
  `new StateFlowError(code, message, inner?)` and `new TransitionAborted(kind, code, message)`.

### An agent guide in the package, and doc examples checked in CI

- The package ships `agent-guide.md` beside `dist`, written for coding agents and for the version it ships
  with: how to test code built on StateFlow with handlers off, what a reducer and a handler may do, how to
  send and read a result, and every error code with its message, cause and fix, generated from
  `error-codes.json` and checked against it by a test. The README names it. The declaration files in `dist`
  keep their doc comments, which the guide sends an agent to.
- Every TypeScript block of the README and the docs site compiles against the engine's source in the test
  suite, a page's fragments together as one module under the installation page's compiler options, and runs:
  its tests run, and an outcome a comment states after a statement (`String(media); // "media.playing"`) is
  asserted. Every page runs, the names it uses but does not define given small stand-ins. An API signature in
  shorthand is marked `{% shorthand=true %}`, and each of its statements must declare an engine export by name,
  with members of that export. A block the check leaves out is marked `{% unchecked="<reason>" %}`
  in its page, and it and every block in another language is counted as a skipped test.
- The examples name every handler they register, and the session example closes a producer and a socket in
  a commit delegate of its exit handlers instead of at once, since an exit runs in a refused step too. Their
  log lines name those handlers where they were empty before.

### Equal answers by value, an option

- `applyFlow`'s config takes `equalAnswers`. `"identity"`, the default, keeps the rule that only the
  instance a reducer was given changes nothing. With `"value"`, a next of that instance's variant whose
  props equal its props counts as that instance too: no handler runs and nothing commits there, and
  observers, subscribers and the log see no change. Props compare by `===`, a `Box` by `equals`, a
  `FrozenSet` by size and elements, a `FrozenMap` by size, keys and equal values, and arrays and plain
  records element by element at any depth; a nested state, an `Items` and any other object only by
  `===`. A temp and a failed compare by identity in either mode, so a failed with equal props still
  takes `FAILURE`. The cost is one walk of the props for each answer whose next is another instance of
  its node's variant.

### Observation of nested states

- `observe()` takes a nested state's variant too, which replaces the rule that it takes only variants
  of the target's top-level states. Every node of that state that a commit changes into the variant
  tells the observer (each element of an `Items` that changed, say); the callback gets the committed
  instance and, as a second argument (a spy asserted with `toHaveBeenCalledWith` now sees it), the
  node's path as the log names it (`media`, `media.producers[cam]`). The compare gets the node's
  instances before and after; a nested node that held no instance of its state before, at a position
  that was empty or held another state, has none, and its callback runs without the compare. A node
  that a commit removes tells no observer. An observer's result in the log entry is named by the node's
  path. An observer of a variant is told of every node of its state, so an existing observer of a
  top-level state whose definition is also held nested now gets those nodes too, told apart by the path.
- The target's type must have a prop under each variant's state name, of that state's props, or hold
  that state's instances below its top-level props, in a prop or an `Items`, at any depth, so a variant
  of a state outside the target still does not compile. The types find a nested state by its name alone,
  in anything the target's props hold: a variant of a state that only an object outside the flow holds,
  or of another definition with a nested state's name, compiles too, and its observer never fires. The
  types cannot search the polymorphic `this` of a class, or a target typed by a type parameter, for
  nested states: a nested state's variant does not compile with those, and `this as Player` passes the
  target typed as the class.
- `observe()` no longer throws for a variant that is not a top-level state's: at run time a nested state
  that no node holds yet cannot be told from a state outside the flow, so a call the types let through,
  as a target or a variant typed `any` does, registers an observer that may never fire.
- `subscribeFlow` also delivers a `FlowChange` per nested node that changed, in pre-order after its
  top-level state's change, which stays as it was. `FlowChange.path` is a nested node's path, absent on a
  top-level state's change; `stateName` names the state of the node's instance, after the change or, when
  the node left, before it. A side where a nested position is empty is `undefined`, its variant
  `"(none)"`.
- An observer is told only of its own variant's nodes, also when two definitions share a name.

### Named results reach every state

- A named result is a fact of the flow. When a handler returns one, its node folds it as before; then, in the same
  step, every node of every other state whose variant has a result reducer of that name, top-level or nested, runs it
  on the snapshot the step started from, as a signal's reducers run on the snapshot before the signal: the reducer
  gets the node as it stood there, and its ctx reads that snapshot. The other nodes of the declaring state do not take
  it. Before, only the declaring variant's reducer folded a result, and another state learned it from a follow-up
  signal.
- Such a reducer answers as a signal reducer does: props, an instance of its own state of any variant, or a
  `StateResult`. An Ignored answers nothing; a Rejected, an Error or a throw refuses the step as a handler's refusal
  does; a transition or a failed is an Error. The answers commit with the step, which runs the handlers of the nodes
  they change, and its log entry lists every change. A transition handler's result folds before the end step, so the
  end step runs those handlers with its own. An enter handler's result folds after the enter phase, so a further round
  of the same step runs them, exits, then updates, then enters, on the target with the results folded in; the named
  results that round returns are taken in turn, and the step commits once nothing more takes one.
- The rules of a signal's answers hold for them: a child's answer lands in its parent's, an answer that replaces or
  removes a node whose own reducer answered too is an Error, and so is one that leaves a transitional variant or
  enters an asynchronous one. A node the step, or an earlier result's answer, changed cannot answer: two answers would
  decide one state. In a transition's temp step, a node at or below the declaring node answers only when the
  transition's next and failed both keep it, so the end keeps the answer.
- `defineFlow` takes, among a variant's result reducers, one under any name the variant does not declare:
  `(state, data, ctx) => props | instance | StateResult`, with `data` typed `never`, so the reducer writes out the type
  the declaring state's parser returns. A name the variant declares still needs its reducer, but a misspelled name of
  another state's result compiles, as a reducer of a result no state declares. A variant with neither signals nor
  named results defines FAILURE's reducer, with any other state's beside it. A reducer under a name its own variant
  declares folds only that variant's result, so a clash that `applyFlow` does not see reaches no such reducer.
- `applyFlow` throws when two definitions declare named results of one name, among its states and the nested states
  and `Items` their initial instances hold, at any depth; one definition may declare a name on several variants. A
  definition that a node first holds later, in a position that held none, is not checked.
- `FAILURE` is no named result: only the nodes the step into failed itself enters or updates take it.

### Update handlers return named results

- An update handler may return a named result of the variant it updates, which replaces the rule that only an enter or
  a transition handler may return one. It folds into the new instance after the enter phase, in the same fold as the
  enter handlers' results and before them: the update handlers saw the instance as the reducer declared it, and the
  commit, the observers and the log entry see it folded. Every other state with a result reducer of that name takes it
  in the same step, as it takes an enter handler's. A named result from an exit handler, or of another variant, stays
  an Error.
- `UpdateHandler<V>`, exported, types an update handler and an update mock: a plain result or a named result of `V`.
  `StateHandler<V>` types exit handlers only.

### Enter and update handlers get the step's AbortSignal

- An enter or update handler gets the step's `AbortSignal` as a fifth argument, after `key`:
  `(state, snapshot, prev, key, signal) => HandlerResult`, a mock's included. Every enter and update handler of the
  step gets the same signal, a further round's too. It aborts when the step does not commit, whatever stopped it: a
  handler refused or threw, a named result did not fold, another state's answer to it failed, the named results broke
  a `DisposableBox` rule, or a throw stopped the step before its commit. The engine still undoes nothing, so on the
  abort the handler releases what it made in that call, such as a handle it returned in a named result that never
  reached a state. Once the step commits, the signal never aborts, also in a step into failed, which commits whatever
  its handlers return. It aborts inside the dispatch, as the step ends and before the failed step runs, so a listener
  that dispatches to or disposes its own target synchronously throws, as a handler does.
- Exit handlers get no signal: they release, and make nothing. A transition handler's signal stays its transition's;
  the transition's end step gives its enter and update handlers a step signal of their own.
- `EnterHandler<V>` and `UpdateHandler<V>` take the fifth parameter; `StateHandler<V>` keeps four.

### Events, watches and sibling reads

- `StateManager.defineEvent(name, changed, payload?)`: a public event of the flow. After every commit `changed(cur,
  prev)` runs on the committed states and on the states as of the commit before; true emits `name` through the
  target's own `emit` on a later timer turn, with `payload(cur)` when given. The entry records each decision under
  `observers` as `event:<name>`. `applyFlow` throws for a target without `emit`.
- `watch(target, changed, callback)`: the same test with a callback, attached and released at any time, recorded
  as `watch:<callback name>`.
- An observer's and a watch's callback runs only while the observer or the watch is registered, as a `subscribeFlow`
  subscriber's change already did: once its disposer or `disposeFlow` removed it, a callback that an earlier commit
  set does not run. Before, it ran a timer turn after that commit whatever happened meanwhile. An event due before
  `disposeFlow` still fires, and a subscriber's change due before it still arrives.
- `ctx.read(name)`: a reducer reads a top-level state of the flow by name, typed by the definitions its state
  declares with `defineState<Props, Defs>()`; a name the flow has no state of is the reducer's Error.
  `isIn(instance, ...variants)` checks a variant by name.
- Once `disposeFlow` ran, every send answers `Rejected` `<name> is disposed`, with no log entry and nothing
  dispatched, whatever its lock: one taken before, one whose wait for its turn or for a pending transition the dispose
  ended, or one asked for afterwards, which `lock()` resolves at once to a sender that holds no lock. `done()` resolves
  to that result, and `expect(ResultKind.OK)` throws, as for any kind it does not list. So no sender needs a catch,
  while a method that expects OK still throws. The release of a lock taken before still flushes the entries its label
  buffered until then.
- `FailureData`, the payload type of a `[FAILURE]` reducer, is exported.

### settled, commit delegates and DisposableBox

- `settled(target)`: resolves once every delivery set on the flow's timers ran (observers, events, watches,
  subscribers), with the deliveries their commits set, once the locks they asked for were served, and once no
  declared transition is pending. On a disposed flow it waits for the deliveries set before `disposeFlow` and takes
  no lock; it rejects when `disposeFlow` runs while it waits for the lock, behind its holder or for the transition
  that lock waits for (before, the second case resolved).
- Commit delegates, `HandlerResult#onCommit(...fns)`: functions a handler's result carries, whatever its kind, run
  right after its step commits, before the commit handlers, in the order of the calls; a step that does not commit
  drops them. A transition handler's run when the transition's end step commits, before the end step's own. A throw
  is logged as a commit result.
- `DisposableBox.of(value, opts?)`: a `Box` of a value with `Symbol.dispose` or `Symbol.asyncDispose`, which the
  engine disposes. After every step it disposes each box the step carried, in the instances it replaced or planned
  or in its handlers' named results, that the committed states no longer hold; a refused step's boxes go with those
  of the step into failed after it, once that step committed, so a box that next and failed both hold stays. A
  declared transition that does not reach its next disposes the boxes of that next and of its work's results; and
  `disposeFlow` disposes those of the final states. It calls `Symbol.dispose`, or else `Symbol.asyncDispose` without
  awaiting it, once per value.
- Before any handler runs, a dispatch is an Error when the states it may commit hold one `DisposableBox` in two
  places or one the engine disposed already, or when a declared transition's temp drops a box that the committed
  states hold and its next or failed holds again. A step other than a step into failed is refused the same way,
  before its commit, when its named results, as they fold in and other states take them, leave one box in two places
  or place a disposed one; a transition's end is checked so even with nothing to fold, since the temp step's fold may
  have dropped a box next holds again. Until the first `DisposableBox.of`, the engine skips these checks and the
  disposal scans.

### The step into failed calls the handlers of its diff

- A failed may hold the instances its refused step entered or updated. The step into failed calls the handlers of
  its diff from the instances before the signal, as any step does, so it enters or updates such an instance again:
  an enter or update handler may run twice in one dispatch, as an exit handler may, the refused call's `AbortSignal`
  aborting before the second call.

### Union payloads

- `defineSignal` with a union payload gives one factory that takes any member, where a union gave a union of
  factories no argument could call. `HandlerMocks.transition` takes a union of asynchronous variants as one handler.
- A payload type that unites an object with `void` (`{ reason: string } | void`) makes a signal without a payload.

## [1.2.0] - 2026-07-07

### Added

- `Box` / `isBox` — an opaque, owned handle for live resources (MediaStream, sockets, DOM
  elements) that must live in state without being deep-frozen. `Box.deref()` returns the
  wrapped reference in effect/observer scope and **throws inside a reducer**; `equals`
  compares by identity; the wrapper serializes as `Box(<name>#<id>)`.
- `FrozenSet` / `FrozenMap` — immutable, throw-on-mutate collections usable directly in state
  props (e.g. `capacities: FrozenSet<string>`).
- **Flat-state enforcement** — every constructed state now deep-freezes its plain-data props
  (nested objects/arrays included), not just the top-level container. `Box`es are skipped
  (their interior stays live); a raw live class instance in a prop is dev-warned.
- **Reducer-access rule** — dispatching from inside a reducer now throws a `StateFlowError`
  (reducers are pure — no side effects, no dispatch).

### Fixed

- `Infer` / `ExtractName` — corrected an over-narrow type constraint that made
  `Infer<typeof builtState>` resolve to `never` (and broke multi-state `applyFlow` with
  strongly-typed targets). Both now wildcard-infer, so `Infer` recovers the real props from a
  built `StateDefinition`/`StateVariant` and `ExtractName` recovers the real state name. The
  `SignalDefinition` branch (`Infer<typeof someSignal>`) is unchanged.

## [1.1.0] - 2026-07-01

### Added

- `subscribeFlow(target, subscriber)` — observation-only per-flow subscription
  delivering `FlowChange` (with real prev/next state instances) once per changed
  state, post-commit and isolated. Exposes `FlowChange` and `FlowSubscriber` types.

## [1.0.1] - 2026-06-16

### Fixed

- Export the `StateDefinition` and `StateInstance` types from the public entry
  point. They were already part of the public surface by inference —
  `defineState().build()` returns a `StateDefinition`, and the exported
  `StateResult` / `StateVariant` reference `StateInstance` — but were not
  nameable, so consumers re-exporting those results in their own `.d.ts` hit
  TypeScript's TS2883 portability error. Exposing them by name repairs the
  declaration surface. No runtime or behavioral change.

## [1.0.0] - 2026-06-13

### Added

- Initial public release of **StateFlow** — type-safe, immutable state
  management built on signals, flows, and frozen state snapshots.
- Public API: `defineSignal`, `defineState`, `defineFlow`, `applyFlow`,
  `lock` / `send`, `observe`, `dispatch` (deprecated escape hatch), `sync`,
  `disposeFlow`, and `StateManager`.
- `Result` / `ResultKind` / `ResultCollector` for explicit, type-safe
  transition outcomes (`ok` / `ignore` / `reject` / `error` / `transition` /
  `enqueue`).
- Logging utilities: `addGlobalLogHandler`, `consoleLogHandler`,
  `setConsoleLogSilenced`, `setGlobalDispatchContextProvider`, and the
  `StateFlowLogEntry` / `StateFlowLogHandler` types.
- Helpers and types: `Infer`, `StateFlowError`, `serializeDebug`, `isState`,
  `stateVar`, and the public symbols `PARSER`, `SIGNALS`, `STRING_REPR`,
  `VARIANT`.

[Unreleased]: https://github.com/ilya-pirogov/stateflow/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/ilya-pirogov/stateflow/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/ilya-pirogov/stateflow/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/ilya-pirogov/stateflow/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ilya-pirogov/stateflow/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/ilya-pirogov/stateflow/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ilya-pirogov/stateflow/releases/tag/v1.0.0
