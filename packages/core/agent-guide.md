# StateFlow: a guide for coding agents

This file ships inside `@state-flow/core` and describes the version it ships with. Most exports carry their contract in the doc comment on their declaration, in the declaration file of the module that defines it (`dist/*.d.ts`; `dist/index.d.ts` only re-exports); read those where this guide is short. Some have none; for those, the type is the contract. Every rule below says why it holds.

## The model

A signal asks a target to change. The reducers of the variants the target is in decide, purely and synchronously, where it goes and where it lands when entering fails. Handlers attached to variants apply that decision to the world. Data from the world reaches props only as a handler's named result, which a result reducer folds in. So a flow's whole logic runs with every handler off.

## Testing with handlers off

- Switch every handler off with `setHandlersDisabled(true)` and switch it back on after the test: it is one switch per loaded copy of the engine, so a test that leaves it off runs every later test that copy runs with handlers off (under vitest, which loads the engine anew for each test file, the rest of that file). It is read at every handler call, so it acts on targets built before or after it; reducers, commits, observers, events and the log still run.
- Give the world's answer a test needs with `mockHandlers(variant, { transition, enter, exit, update, commit })` under `using`. A mock runs even with handlers off, and its named result folds as a real handler's would, so one mocked transition drives a declared transition while the world stays untouched.
- With handlers off and no mock, a declared transition has no work: its next commits inside the send that declared it, with the props the world fills left at their defaults. So a failed end, an abort and an abort reducer are reached only through a mock that refuses or never answers.
- Start a test in the middle of a session with `applyFlow(target, states, setup, { start: { <state>: instance } })` instead of sending the signals that lead there: nothing runs for a start, no handler and no log entry.
- Control time through the flow's `timers` option or fake timers, never the wall clock: a declared transition's timeout and every delivery of observers, watches, events and subscribers go through the flow's timers.
- Await `settled(target)` after releasing your lock before asserting on observers, watches, events or subscribers: they are delivered on later timer turns, and `settled` takes the lock itself, so awaited under your own lock it never resolves.
- Assert on the result's kind and on the state that committed, refusals included: a refused step commits nothing, or the failed state its reducer named.

## What a reducer may do

- Return props (the variant stays), an instance of its own state, or a `StateResult` (`ok`, `transition`, `ignored`, `rejected`, `error`). Anything else, a promise included, is an Error result: reducers are synchronous.
- Read only its arguments: the instance, the payload, and `ctx.read("<state>")` for another top-level state. Every reducer of a signal sees the snapshot from before the signal, so their verdicts can merge; a rejection from any of them refuses the dispatch.
- Never read the clock, randomness or anything outside its arguments, never `deref()` a `Box` (it throws), never dispatch: the same input must give the same answer, which is what lets a test run the logic alone.
- Put a live resource into props only in a `Box`; props are deep-frozen.
- An entry that waits for the world is declared, never awaited: `StateResult.transition(next, temp, failed, options?)` names all three ends; the variant whose entry waits is marked `{ async: true }`, and its transition handlers do the work.

## What a handler may do

- Apply the decision to the world, and answer with a `HandlerResult` (`ok`, `ignored`, `rejected`, `error`) or a named result of its own variant (`variant.results.<name>(data)`). It never chooses a state: a Rejected or a throw refuses the step, and the target goes where its reducer said. A refusal may carry plain data, `HandlerResult.rejected(message, data)`, which the failed end's `FAILURE` reducer gets as `data`: the reducer decides from that, never from the message's text.
- Enter, exit and update handlers are synchronous, and a promise one returns is an Error that refuses the step: a step commits inside the send that made it, so it cannot wait. A wait for the world is a declared transition, whose transition handler returns a promise while the temp state it named holds.
- Bring the world's data into props as a named result from an enter, update or transition handler. An exit handler may not: the node it leaves holds no instance to fold into.
- Never dispatch to or dispose its own target synchronously: that throws. A follow-up on the same target is another reducer's answer in the same dispatch; a fact from the world later is a signal sent through a lock.
- An exit handler runs in every step that leaves its variant, a refused step included, so it may run twice for one instance. Release what must be released once in a commit delegate, `HandlerResult.ok().onCommit(release)`, or hold the resource in a `DisposableBox`, which the engine disposes once no committed state holds it.
- An enter or update handler gets the step's `AbortSignal`, which aborts when the step does not commit: release there what the call made. A transition handler's signal aborts on a timeout, an abort, a failed end or `disposeFlow`: stop the work and release what it acquired.
- Register named functions, not anonymous ones: the log, `listHandlers` and error messages name a handler by its function's name.

## Sending and reading a result

- Send through the lock: `await using send = await lock(target)`, then `send(signal)`. Locks are served in the order asked for, and the release waits until no transition is pending. Take the lock outside any `try` that has a `catch`: a refused lock is the caller's error. `dispatch()` is deprecated, kept for synchronous teardown, bootstrap before any lock, and `{ abort: true }` on a transition whose lock another caller holds.
- Every send returns a `Result`. `kind` is `OK`, `Ignored`, `InTransition`, `Rejected` or `Error`; `ResultKind[result.kind]` is its name. A send that declares a transition with work (a transition handler that runs for the variant it enters: a registered one with handlers on, or a mock) returns `InTransition` at once, and `await result.done()` resolves to its end; with no work, its next commits inside the send, which returns the end's result, `OK` when it commits; `done()` on any other result resolves to itself, so `await send(signal).done()` fits both.
- Ignored is not silent success: no reducer took the signal. A caller for whom anything but OK is an error says so with `.expect(ResultKind.OK)`, which throws for another kind; on a pending result it is checked at `done()`, so write `await send(signal).expect(ResultKind.OK).done()`.
- `result.message` is an Ignored or Rejected result's text, `result.error` an Error result's error, and `result.code` the code below when the engine wrote the text. A log entry carries the same as data in `finalResultData` (`kind`, `message`, `errors`, `code`): read that, never parse `finalResult`.

## Error codes

Every error the engine raises, and every refusal whose text it writes, has a code. An error's message ends with ` [SFnnn] <fix>`, and `StateFlowError.code` holds the code (`TransitionAborted` is a `StateFlowError`); a refusal keeps its text, and `Result.code` names its code. Look the code up here. In a message below, `<name>` stands for what the engine fills in.

<!-- Generated from src/error-codes.json by src/.tests/agent-guide.spec.ts; to regenerate, run `npx vitest run -u agent-guide` in packages/core. -->

**SF001** Cannot deref a Box inside a reducer; read it in a handler (enter, exit, update, transition or commit) or an observer.
- Cause: A reducer called deref() on a Box. Reducers are pure, and a Box holds a live resource.
- Fix: Read the Box in a handler or an observer; give the reducer what it needs as payload or props.

**SF002** Items of <definition>: a map takes with(key, item)
- Cause: with() on Items that are a map got one argument.
- Fix: Call with(key, item) on a map of items.

**SF003** Items of <definition>: a keyed set takes with(item) and keys it itself
- Cause: with() on Items that are a keyed set got a key as well as the item.
- Fix: Call with(item); the set's key function gives the key.

**SF004** Items of <definition> take its instances only, not <value>
- Cause: with() got a value that is not an instance of the definition the Items were made of.
- Fix: Pass an instance of that definition, made by one of its variants.

**SF005** FrozenSet is immutable; build a new FrozenSet instead of mutating.
- Cause: add, delete or clear was called on a FrozenSet held in state props.
- Fix: Build a new FrozenSet with the change and return it in the next props.

**SF006** FrozenMap is immutable; build a new FrozenMap instead of mutating.
- Cause: set, delete or clear was called on a FrozenMap held in state props.
- Fix: Build a new FrozenMap with the change and return it in the next props.

**SF007** <target> doesn't contain state flows
- Cause: A flow call got an object applyFlow never ran on.
- Fix: Call applyFlow(target, states, initializer) on the object before using it.

**SF008** <flow> is disposed
- Cause: A call reached a flow after disposeFlow: an Error from dispatch, lock or a read, a Rejected result from the send of a lock taken before.
- Fix: Stop using the object after disposeFlow; make a new one.

**SF009** Incorrect state definition
- Cause: The states given to applyFlow hold something that is not a state definition.
- Fix: List only definitions made by defineState()...build().

**SF010** State object <name> not found
- Cause: The object given to applyFlow has no property named after one of its states.
- Fix: Give the object a property with the state's name holding its initial props.

**SF011** <path> starts in a transitional variant, which commits only as the temp of a declared transition
- Cause: The initial instance, or the one FlowConfig.start gives, holds a variant marked transitional.
- Fix: Start in a variant that is not transitional.

**SF012** <path> starts in <variant>, whose entry is asynchronous; declare a transition into it
- Cause: A nested state of the initial instance would enter a variant marked async, which only a declared transition enters.
- Fix: Start in a synchronous variant and enter this one with StateResult.transition.

**SF013** <flow> has no emit method, which defineEvent("<event>") needs
- Cause: The initializer defined an event on an object that has no emit method.
- Fix: Give the object an emit(name, payload) method, or drop the event.

**SF014** <state> and <state> both declare a result named <name>; every state with a result reducer of that name takes it, so one state of a flow declares it
- Cause: Two state definitions of one flow declare a named result of the same name.
- Fix: Rename one of the results, or declare it on one state only.

**SF015** Cannot dispatch from inside a reducer
- Cause: A reducer called dispatch or a lock's send. Reducers are pure.
- Fix: Return the change from the reducer; send from a handler or from outside the flow.

**SF016** Cannot dispatch to <flow> from inside its own dispatch
- Cause: A handler, observer or tap sent to the object whose step is running.
- Fix: Return a named result from the handler, or send after the dispatch returns.

**SF017** nothing to abort: no transition is pending and the lock is held
- Cause: A Rejected result: an abort was sent while no transition was pending and another caller held the lock.
- Fix: Expect it when an abort may race a transition's end; otherwise send without abort.

**SF018** Lock is held. Use `await using send = await lock(target)` for queued access
- Cause: dispatch was called while another caller held the object's lock.
- Fix: Take the lock with await lock(target) and send through it.

**SF019** A transition is pending on <flow>; use lock() to queue, or { abort: true }
- Cause: dispatch was called while a declared transition's work was running.
- Fix: Send through lock() to queue behind it, or send with { abort: true } to end it.

**SF020** Lock has been released
- Cause: A lock's send was called after the lock was released.
- Fix: Send only inside the lock's scope; take a new lock for a later operation.

**SF021** <path> would be left in <variant>, a transitional variant, which commits only as the temp of a declared transition
- Cause: A reducer's next leaves a node in a variant marked transitional.
- Fix: Return that variant as the temp of StateResult.transition, or another variant as next.

**SF022** <path>: its failed <instance> would leave <path> in a transitional variant
- Cause: The failed a reducer declared would leave a node in a variant marked transitional.
- Fix: Declare a failed that holds no transitional variant.

**SF023** <path> replaced or removed <path>, whose own reducer also answered
- Cause: A reducer replaced or removed a nested state whose own reducer answered the same signal, so two answers would decide it.
- Fix: Keep the nested state in the parent's answer, or let only one of the two reducers answer.

**SF024** <path> enters <variant>, whose entry is asynchronous; declare a transition
- Cause: A reducer's next enters a variant marked async without declaring a transition.
- Fix: Return StateResult.transition(next, temp, failed) to enter it.

**SF025** <path> enters <variant>, whose entry is asynchronous, <where>; declare a transition
- Cause: A failed step or a transition's failed end would enter a variant marked async.
- Fix: Declare a failed whose variants are synchronous.

**SF026** <place> holds <box> <where>, which the temp drops from <place>; the temp's commit disposes it
- Cause: An end of a transition holds a DisposableBox the temp leaves out, and the temp's commit disposes it.
- Fix: Keep the box in the temp too, or give the end a new box.

**SF027** <place> and <place> hold <box> <where>; a DisposableBox has one place in the states
- Cause: One DisposableBox stands in two places of the states a step would commit.
- Fix: Keep each DisposableBox in one prop; move it rather than copy it.

**SF028** <place> holds <box> <where>, which the engine disposed already
- Cause: A step would commit a DisposableBox the engine disposed when a state dropped it.
- Fix: Make a new box for the resource instead of reusing the disposed one.

**SF029** <the refusal of the failed step>
- Cause: A handler of the failed step, or a result reducer folding into it, refused. A failed step commits whatever its handlers answer, so the refusal is an Error of the result.
- Fix: Make the failed variant's handlers succeed; report trouble there through state, not a refusal.

**SF030** <where> answered for <path>, which this step changes already; two answers would decide one state
- Cause: A result reducer of another state answered for a node the step changes already.
- Fix: Let one of the two decide that node: drop the result reducer's change or the step's.

**SF031** <where> answered for a node the transition of <path> decides at its next or failed; two answers would decide one state
- Cause: A result reducer answered for a node that a pending transition's next or failed decides.
- Fix: Fold the result into the transition's next and failed, or into a node outside them.

**SF032** <where> would leave <path> in a transitional variant, which commits only as the temp of a declared transition
- Cause: A result reducer's answer leaves a node in a variant marked transitional.
- Fix: Return a variant that is not transitional from the result reducer.

**SF033** <where>: <path> enters <variant>, whose entry is asynchronous; declare a transition
- Cause: A result reducer's answer enters a variant marked async, which only a declared transition enters.
- Fix: Enter that variant through a signal reducer that returns StateResult.transition.

**SF034** failed: <the refusal that ended the transition>
- Cause: The reason of a transition's AbortSignal (TransitionAborted of kind failed): a handler refused, or the end step did not commit.
- Fix: Read the refusal in the message; stop the work and release what it acquired.

**SF035** <path> did not reach <variant> within <timeoutMs> ms
- Cause: A transition's work outlasted its timeoutMs (TransitionAborted of kind timeout); the failed end committed.
- Fix: Make the work answer sooner or raise timeoutMs; release what it acquired on abort.

**SF036** an abort of <path> is already in progress
- Cause: A Rejected result: an abort was sent while another abort of the same transition was waiting for its work.
- Fix: Send one abort per transition and wait for its result.

**SF037** <signal> changes nothing; the transition continues
- Cause: A Rejected result: an abort's reducers ignored it or changed nothing, so the transition goes on.
- Fix: Give the abort signal a reducer on the transition's temp that changes the state.

**SF038** <the abort reducer's refusal>; the transition continues
- Cause: A Rejected result: a reducer rejected the abort signal, so the transition goes on.
- Fix: Expect it where the abort may be refused, or let the reducer accept the abort.

**SF039** <the abort reducer's error>; the transition continues
- Cause: A reducer of the abort signal threw or broke a rule, so the transition goes on. The reducer's error is its cause.
- Fix: Fix the reducer's error named in the message.

**SF040** aborted by <signal>
- Cause: An abort was accepted: the transition's AbortSignal reason (TransitionAborted of kind aborted), and the Rejected outcome of the aborted send.
- Fix: Stop the work on abort and release what it acquired; expect Rejected where an abort may come.

**SF041** flow disposed during the abort of <path>
- Cause: disposeFlow ran while an accepted abort waited for its work.
- Fix: Expect it when the object may be disposed during an abort.

**SF042** Cannot dispose a flow from inside a reducer
- Cause: A reducer called disposeFlow. Reducers are pure.
- Fix: Dispose from a handler or from outside the flow.

**SF043** Cannot dispose <flow> from inside its own dispatch
- Cause: A handler of a running step called disposeFlow on its own object.
- Fix: Dispose after the dispatch returns.

**SF044** flow disposed during the transition of <path> to <variant>
- Cause: disposeFlow ran while a declared transition was pending; the transition's result is this Error.
- Fix: Expect it when the object may be disposed during a transition.

**SF045** flow disposed before <signal> was reduced
- Cause: disposeFlow ran while a send waited in the queue behind a transition.
- Fix: Expect it when the object may be disposed while sends are queued.

**SF046** flow disposed
- Cause: The reason of a transition's AbortSignal (TransitionAborted of kind disposed) when disposeFlow ran during its work.
- Fix: Stop the work on abort and release what it acquired.

**SF047** <variant>: mockHandlers mocks enter, exit, update, transition and commit handlers, not <key>
- Cause: mockHandlers got a key that is not a handler kind.
- Fix: Use only the keys enter, exit, update, transition and commit.

**SF048** <variant>: its <kind> handlers are mocked already; dispose that mock first
- Cause: mockHandlers mocked a kind of a variant that a live mock covers already.
- Fix: Dispose the first mock (using mocks = ...) before mocking again.

**SF049** <variant> is not asynchronous: only a variant declared with { async: true } has transition handlers
- Cause: A transition handler was registered or mocked on a variant not marked async.
- Fix: Declare the variant with { async: true }, or use an enter handler.

**SF050** Handler '<handler>' returned a promise; enter, exit and update handlers are synchronous
- Cause: An enter, exit or update handler is async or returned a promise.
- Fix: Return a HandlerResult synchronously; put the waiting in a transition handler.

**SF051** exit handler '<handler>' returned the named result <name>; only an enter, update or transition handler may
- Cause: An exit handler returned a named result; the node it leaves holds no instance to fold it into.
- Fix: Return the named result from an enter, update or transition handler.

**SF052** Transition handler '<handler>' returned no promise
- Cause: A transition handler returned a value that is not a promise.
- Fix: Make the transition handler async, or return a promise of its HandlerResult.

**SF053** Handler '<handler>' did not return a HandlerResult
- Cause: A handler returned, or its promise resolved to, something other than a HandlerResult.
- Fix: Return HandlerResult.ok(), a refusal, an error, or a named result of the variant.

**SF054** Handler '<handler>' on <variant> returned <variant>'s named result <name>
- Cause: A handler returned a named result of another variant than the one it was registered on.
- Fix: Return a named result of the handler's own variant.

**SF055** two transitions declared in one dispatch: <path> and <path>
- Cause: Two reducers answered one signal with StateResult.transition; an object has one pending transition.
- Fix: Declare the transition in one reducer; let the other answer with next.

**SF056** <where> returned a transition or a failed; it answers with next only
- Cause: A result reducer of another state returned StateResult.transition or a failed.
- Fix: Return the next instance or props only from a result reducer.

**SF057** <where> returned <instance>, whose key <key> is not its own
- Cause: A reducer of an element of a keyed set returned an instance whose key differs from the element's.
- Fix: Keep the props the key is made of; add a new element to change the key.

**SF058** No state <name> in the flow
- Cause: A reducer's ctx.read named a state the flow does not hold.
- Fix: Read a state the flow was applied with, by its name.

**SF059** <where> returned a promise; reducers are synchronous
- Cause: A signal or result reducer is async or returned a promise.
- Fix: Return the next state synchronously; put the waiting in a transition handler.

**SF060** <where> returned no StateResult, instance or props
- Cause: A signal reducer returned something other than a StateResult, an instance or props.
- Fix: Return a StateResult, an instance of the state, or its props.

**SF061** <where> returned <instance>, not an instance of <definition>
- Cause: A reducer returned an instance of another state definition than its own.
- Fix: Return an instance of the reducer's own state, made by one of its variants.

**SF062** <call>: <variant> has no result reducer for <name>
- Cause: A named result reached a variant that declares no result reducer of that name.
- Fix: Add the result reducer to the variant's defineFlow, or return the result from the variant that has it.

**SF063** <where> changed a nested state; nested states change only through a step
- Cause: A result reducer returned props whose nested states differ from the ones it got.
- Fix: Keep the nested states as they are; change them with a signal their own reducers take.

**SF064** no reducer for <signal> in <variants>
- Cause: An Ignored result: no variant the states are in has a reducer for the signal.
- Fix: Add a reducer for the signal to the variant, or expect Ignored where it is not handled.

**SF065** Result is abstract: a reducer returns a StateResult, a handler a HandlerResult
- Cause: Result was constructed directly.
- Fix: Use StateResult in a reducer and HandlerResult in a handler.

**SF066** <the result expect() refused: its signal, handler, kind, state, and error or message>
- Cause: expect() got a result of a kind it was not given. The result's error, when it has one, is its cause.
- Fix: Handle the outcome the message names, or list its kind in expect().

**SF067** a pending or declared transition result cannot be merged or copied
- Cause: merge was called on an InTransition result.
- Fix: Await done() and merge its outcome.

**SF068** StateResult.ok takes a state instance; a reducer returns props bare
- Cause: StateResult.ok got props or another value, not an instance.
- Fix: Pass an instance (variant(props)), or return the props bare.

**SF069** StateResult.ok: failed must be an instance of next's state
- Cause: The failed given to StateResult.ok is not an instance of next's definition.
- Fix: Pass a failed made by a variant of next's state.

**SF070** StateResult.transition takes a state instance as next; a reducer returns props bare
- Cause: StateResult.transition got props or another value as next.
- Fix: Pass an instance as next (variant(props)).

**SF071** StateResult.transition takes a state instance as temp, the instance the node holds while the work runs
- Cause: StateResult.transition got no instance as temp.
- Fix: Pass the instance the node holds during the work as temp.

**SF072** StateResult.transition takes failed, an instance of next's state, which the node takes when the work fails
- Cause: StateResult.transition got no instance as failed.
- Fix: Pass the instance the node takes when the work fails as failed.

**SF073** StateResult.transition: next, temp and failed must be instances of one state definition
- Cause: next, temp and failed of StateResult.transition are of different definitions.
- Fix: Make next, temp and failed with variants of the reducer's own state.

**SF074** StateResult.transition: the options are an object { timeoutMs }
- Cause: The options of StateResult.transition are not an object.
- Fix: Pass { timeoutMs } or leave the options out.

**SF075** StateResult.transition: the options take timeoutMs only, not <key>
- Cause: The options of StateResult.transition have a key other than timeoutMs.
- Fix: Pass timeoutMs only.

**SF076** StateResult.transition: timeoutMs must be a positive finite number <= <max>, got <value>
- Cause: timeoutMs is not a positive finite number up to the largest delay setTimeout honours.
- Fix: Pass a timeoutMs above 0 and at most 2147483647.

**SF078** State prop `<key>` holds a non-plain class instance `<class>`; wrap live resources in `Box(...)` or expose frozen plain data.
- Cause: A state's props hold a Set, a Map, or an unfrozen instance of a class.
- Fix: Wrap a live resource in Box(...); use FrozenSet, FrozenMap or frozen plain data for data.

**SF079** State prop `<key>` holds <value> inside its data; a nested state goes directly in a prop, as an instance or in Items (def.items()).
- Cause: A state instance or Items sits inside an array, object or collection in a prop, where its handlers would never run.
- Fix: Put the nested state directly in a prop, alone or in def.items().

**SF080** Not a state
- Cause: A value that is not a state instance was given where one is needed.
- Fix: Pass a state instance, made by a variant.

**SF081** Initial state variant not found
- Cause: A state definition has no variant marked { initial: true }, and no start was given for it.
- Fix: Mark one variant { initial: true }, or give the state in FlowConfig.start.

**SF082** <variant>: the parser returned something other than a plain object (prototype Object.prototype or null); the engine copies props without a constructor when it rebuilds a node
- Cause: A state's parser returned a class instance or another non-plain value.
- Fix: Return a plain object from the parser.

**SF083** State Flow object not found
- Cause: A state definition was called on a value that is no snapshot or ctx holding that state.
- Fix: Call the definition on a snapshot of the flow or on a reducer's ctx.

**SF084** State not found: <name>
- Cause: The snapshot holds no instance of this definition under its name (another definition may share the name).
- Fix: Read a state the flow was applied with.

**SF085** Only one initial state variant is allowed
- Cause: A second variant of one state was marked { initial: true }.
- Fix: Mark one variant initial.

**SF086** <variant>: an initial variant cannot be transitional
- Cause: A variant was marked both initial and transitional.
- Fix: Drop one of the two marks.

**SF087** <variant>: an initial variant cannot be asynchronous
- Cause: A variant was marked both initial and async.
- Fix: Start in a synchronous variant and enter this one with a transition.

**SF088** <variant>: a transitional variant cannot be asynchronous
- Cause: A variant was marked both transitional and async.
- Fix: Drop one of the two marks.

**SF089** Name was not provided
- Cause: build() was called on a state with no .name().
- Fix: Call .name("...") before build().

**SF090** No state variants are defined
- Cause: build() was called on a state with no .variant().
- Fix: Declare at least one variant, one of them initial.

**SF091** <name>: a variant cannot be named items, which is the definition's items() method
- Cause: A variant was named items, the name of the definition's own method.
- Fix: Name the variant otherwise.

**SF092** <name>: the signal <signal> is listed under the key <key>; a reducer keyed <key> would never run
- Cause: A key of the object given to .signals() is not the name of the signal under it.
- Fix: List each signal under the name given to its defineSignal(name).

**SF093** Flow is already defined: <variant>
- Cause: defineFlow ran twice for one variant.
- Fix: Call defineFlow once per variant, with all its reducers.
