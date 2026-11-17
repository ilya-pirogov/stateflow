// A compile fixture for typing.spec.ts, never run: every line marked EXPECT ERROR must fail to compile, and no
// other line may. The comment above a marked line says why it must fail.
import {
  defineFlow,
  defineSignal,
  defineState,
  FAILURE,
  HandlerResult,
  type InstanceOf,
  type Items,
  mockHandlers,
  observe,
  type StateDefinition,
  type StateManager,
  StateResult,
  type StateVariant,
} from "../..";

declare const sm: StateManager;

type Loaded = { manifest: string };
const parseLoaded = (data: unknown): Loaded => data as Loaded;
const signals = { play: defineSignal<{ url: string }>("play"), stop: defineSignal("stop") };

export const driver = defineState<{ url: string; manifest: string | null }>()
  .name("driver")
  .signals(signals)
  .variant("idle", { initial: true })
  .variant("active", { async: true, results: { loaded: (d) => parseLoaded(d) } })
  .variant("seeking", { async: true })
  .variant("failed")
  .build();

export const producer = defineState<{ id: string }>()
  .name("producer")
  .variant("active", { initial: true, results: { created: (d) => d as { id: string } } })
  .build();

// Result reducers: a state with signals takes them second, one without signals first.
defineFlow(
  driver.active,
  { stop: (s) => driver.idle(s) },
  { loaded: (s, data) => ({ ...s, manifest: data.manifest }) },
);
defineFlow(producer.active, { created: (p, data) => ({ ...p, id: data.id }) });
// A result reducer takes (next, data, ctx); an element's key is ctx.key.
defineFlow(producer.active, { created: (p, data, ctx) => ({ ...p, id: `${String(ctx.key)}/${data.id}` }) });
// A fourth parameter: nothing passes one.
defineFlow(producer.active, { created: (p, _data, _ctx, key: unknown) => ({ ...p, id: String(key) }) }); // EXPECT ERROR
// ResultReducers needs a reducer for every declared result: missing all of them.
defineFlow(driver.active, { stop: (s) => driver.idle(s) }); // EXPECT ERROR
// Missing the one declared.
defineFlow(driver.active, { stop: (s) => driver.idle(s) }, {}); // EXPECT ERROR

// FAILURE's reducer: any variant may take it among its result reducers, whatever it declares; it gets the kind, the
// reason and the error.
defineFlow(driver.failed, { play: (s) => s }, { [FAILURE]: (s, { reason }) => ({ ...s, url: reason ?? s.url }) });
defineFlow(
  driver.active,
  { stop: (s) => driver.idle(s) },
  { loaded: (s, data) => ({ ...s, manifest: data.manifest }), [FAILURE]: (s) => s },
);
defineFlow(producer.active, { created: (p) => p, [FAILURE]: (p, failure, ctx) => ({ ...p, id: `${ctx.key}` }) });
// A variant with neither signals nor named results has FAILURE's reducer alone to define.
export const lamp = defineState<{ on: boolean }>().name("lamp").variant("idle", { initial: true }).build();
defineFlow(lamp.idle, { [FAILURE]: (l, { reason }) => ({ ...l, on: reason === undefined }) });
// Without it, it has nothing to define.
defineFlow(lamp.idle, {}); // EXPECT ERROR
// Its data is { kind, reason?: string, error?: unknown }.
defineFlow(lamp.idle, { [FAILURE]: (l, failure: { reason: number }) => l }); // EXPECT ERROR
defineFlow(lamp.idle, {
  [FAILURE]: (l, { kind, error }) => ({ ...l, on: kind === "timeout" && error instanceof Error }),
});
// Its kind is rejected, error, timeout or aborted; disposed is a kind of TransitionAborted only.
defineFlow(lamp.idle, { [FAILURE]: (l, { kind }) => ({ ...l, on: kind === "disposed" }) }); // EXPECT ERROR
// Its error is unknown until narrowed.
defineFlow(lamp.idle, { [FAILURE]: (l, { error }) => ({ ...l, on: error.message === "" }) }); // EXPECT ERROR
// It returns props or an instance of the state, as any result reducer.
defineFlow(lamp.idle, { [FAILURE]: () => ({ on: 1 }) }); // EXPECT ERROR
// A result the variant declares under the name failure is another result.
export const valve = defineState<{ note: string }>()
  .name("valve")
  .variant("shut", { initial: true, results: { failure: (d) => String(d) } })
  .build();
defineFlow(valve.shut, {
  failure: (v, note) => ({ ...v, note }),
  [FAILURE]: (v, { reason }) => ({ ...v, note: reason ?? "" }),
});

// A result reducer under a name the variant does not declare takes another state's result of that name; it annotates
// the data's type, and answers as a signal reducer does.
export const viewer = defineState<{ url: string }>()
  .name("viewer")
  .signals(signals)
  .variant("idle", { initial: true })
  .variant("watching")
  .build();
defineFlow(viewer.idle, {}, { loaded: (v, { manifest }: Loaded) => viewer.watching({ ...v, url: manifest }) });
defineFlow(viewer.watching, {}, { loaded: () => StateResult.ignored("watching already") });
// Without an annotation the data is never, so there is nothing to read.
defineFlow(viewer.idle, {}, { loaded: (v, data) => ({ ...v, url: data.manifest }) }); // EXPECT ERROR
// It returns what a signal reducer returns, so props of another shape do not compile.
defineFlow(viewer.idle, {}, { loaded: () => ({ url: 1 }) }); // EXPECT ERROR

// A variant's named result fits only its own handlers; the four plain results fit all.
sm.addEnterHandler(driver.active, () => driver.active.results.loaded({ manifest: "m" }));
sm.addUpdateHandler(driver.active, () => driver.active.results.loaded({ manifest: "m" }));
sm.addEnterHandler(driver.failed, () => HandlerResult.rejected("no"));
sm.addExitHandler(driver.active, () => HandlerResult.ok());
// The wrong data shape.
sm.addEnterHandler(driver.active, () => driver.active.results.loaded({ manifest: 1 })); // EXPECT ERROR
// An unknown result name.
sm.addEnterHandler(driver.active, () => driver.active.results.nope({ manifest: "m" })); // EXPECT ERROR
// A sibling variant's result: the variant comes from the first argument only.
sm.addEnterHandler(driver.failed, () => driver.active.results.loaded({ manifest: "m" })); // EXPECT ERROR
sm.addUpdateHandler(driver.failed, () => driver.active.results.loaded({ manifest: "m" })); // EXPECT ERROR
// An exit handler takes no named result.
sm.addExitHandler(driver.active, () => driver.active.results.loaded({ manifest: "m" })); // EXPECT ERROR
// StateResult and HandlerResult do not mix: a StateResult from a handler.
sm.addEnterHandler(driver.idle, () => StateResult.ok(driver.idle({ url: "", manifest: null }))); // EXPECT ERROR

// An enter handler is synchronous: a promise from it does not compile.
sm.addEnterHandler(driver.active, async () => HandlerResult.ok()); // EXPECT ERROR

// Enter and update handlers get the step's AbortSignal fifth.
sm.addEnterHandler(driver.active, (_state, _snapshot, _prev, _key, signal) => {
  signal.addEventListener("abort", () => {});
  return HandlerResult.ok();
});
sm.addUpdateHandler(driver.active, (_state, _snapshot, _prev, _key, signal) => {
  signal.addEventListener("abort", () => {});
  return HandlerResult.ok();
});
// A sixth parameter: nothing passes one.
sm.addEnterHandler(driver.active, (_state, _snapshot, _prev, _key, _signal, _more: unknown) => HandlerResult.ok()); // EXPECT ERROR
sm.addUpdateHandler(driver.active, (_state, _snapshot, _prev, _key, _signal, _more: unknown) => HandlerResult.ok()); // EXPECT ERROR
// An exit handler gets no signal.
sm.addExitHandler(driver.active, (_state, _snapshot, _prev, _key, _signal: unknown) => HandlerResult.ok()); // EXPECT ERROR

// Transition handlers: a promise of a plain result, or of a named result of their own variant.
sm.addTransitionHandler(driver.active, async () => driver.active.results.loaded({ manifest: "m" }));
sm.addTransitionHandler(driver.active, async () => HandlerResult.rejected("no manifest"));
sm.addTransitionHandler(driver.active, async (next, _snapshot, _prev, _key, signal) => {
  signal.throwIfAborted();
  return next.url === "" ? HandlerResult.rejected("no url") : driver.active.results.loaded({ manifest: next.url });
});
// A sibling variant's result: the variant comes from the first argument only.
sm.addTransitionHandler(driver.seeking, async () => driver.active.results.loaded({ manifest: "m" })); // EXPECT ERROR
// A result that is no promise.
sm.addTransitionHandler(driver.active, () => HandlerResult.ok()); // EXPECT ERROR
// Only a variant declared with { async: true } takes transition handlers.
sm.addTransitionHandler(driver.failed, async () => HandlerResult.ok()); // EXPECT ERROR
// Only a literal true marks a variant asynchronous in its type: a boolean flag may be false when the code runs.
declare const flag: boolean;
export const flagged = defineState<{ n: number }>()
  .name("flagged")
  .variant("idle", { initial: true })
  .variant("maybe", { async: flag })
  .build();
sm.addTransitionHandler(flagged.maybe, async () => HandlerResult.ok()); // EXPECT ERROR

// Handlers written as class methods without return annotations, as services write them.
class Service {
  onActivate() {
    return driver.active.results.loaded({ manifest: "m" });
  }
  onCreate() {
    return producer.active.results.created({ id: "p" });
  }
  async onLoad() {
    return driver.active.results.loaded({ manifest: "m" });
  }
  async onCreated() {
    return producer.active.results.created({ id: "p" });
  }
}
sm.addEnterHandler(driver.active, new Service().onActivate);
// Another state's result, from an unannotated method.
sm.addEnterHandler(driver.active, new Service().onCreate); // EXPECT ERROR
sm.addTransitionHandler(driver.active, new Service().onLoad);
// Another state's result, from an unannotated async method.
sm.addTransitionHandler(driver.active, new Service().onCreated); // EXPECT ERROR

// Mocks are typed as the handlers they replace.
export const mocked = mockHandlers(driver.active, { enter: () => driver.active.results.loaded({ manifest: "m" }) });
export const mockedUpdate = mockHandlers(driver.active, {
  update: () => driver.active.results.loaded({ manifest: "m" }),
});
export const mockedWork = mockHandlers(driver.active, {
  transition: async () => driver.active.results.loaded({ manifest: "m" }),
});
// Another state's result from a mock.
mockHandlers(producer.active, { enter: () => driver.active.results.loaded({ manifest: "m" }) }); // EXPECT ERROR
mockHandlers(driver.active, { transition: async () => producer.active.results.created({ id: "p" }) }); // EXPECT ERROR
// A variant that is not asynchronous takes mocks of every kind but transition.
export const mockedEntry = mockHandlers(driver.failed, { enter: () => HandlerResult.ok() });
mockHandlers(driver.failed, { transition: async () => HandlerResult.ok() }); // EXPECT ERROR

// A union of asynchronous variants, as indexing definitions by a union of kinds gives, takes one transition mock: a
// function whose answer is a named result of any of them, with no cast.
export const scanner = defineState<{ url: string; manifest: string | null }>()
  .name("scanner")
  .variant("idle", { initial: true })
  .variant("active", { async: true, results: { loaded: (d) => parseLoaded(d) } })
  .build();
declare const eitherActive: typeof driver.active | typeof scanner.active;
declare const load: () => Promise<HandlerResult<"driver.active" | "scanner.active">>;
export const mockedEither = mockHandlers(eitherActive, { transition: load });

// A union with a variant that is not asynchronous takes no transition mock.
declare const activeOrFailed: typeof driver.active | typeof driver.failed;
mockHandlers(activeOrFailed, { transition: async () => HandlerResult.ok() }); // EXPECT ERROR

// A union payload: one factory takes any member of the union, and a reducer narrows the signal by its discriminant.
const seek = defineSignal<{ by: "time"; time: number } | { by: "frame"; frame: number }>("seek");
export const seekByTime = seek({ by: "time", time: 1 });
export const seekByFrame = seek({ by: "frame", frame: 25 });

// One member's discriminant with another member's field.
seek({ by: "time", frame: 25 }); // EXPECT ERROR

export const clip = defineState<{ at: number }>()
  .name("clip")
  .signals({ seek })
  .variant("paused", { initial: true })
  .build();
defineFlow(clip.paused, { seek: (c, s) => ({ ...c, at: s.by === "time" ? s.time : s.frame / 25 }) });

// A member's field read before the discriminant narrows the signal.
defineFlow(clip.paused, { seek: (c, s) => ({ ...c, at: s.time }) }); // EXPECT ERROR

// Reducers: ok and transition take instances; props answer bare.
defineFlow(driver.failed, { play: (s, { url }) => ({ ...s, url }) });
defineFlow(driver.failed, { play: (s) => StateResult.ok(driver.active(s), driver.failed(s)) });
// A function as failed.
defineFlow(driver.failed, { play: (s) => StateResult.ok(driver.active(s), () => driver.failed(s)) }); // EXPECT ERROR
// Props as ok's next.
defineFlow(driver.failed, { play: (s) => StateResult.ok({ ...s }) }); // EXPECT ERROR
// Unrelated props as ok's next.
defineFlow(driver.failed, { play: () => StateResult.ok({ nonsense: true }) }); // EXPECT ERROR
// Wrong props, bare.
defineFlow(driver.failed, { play: (s) => ({ ...s, url: 1 }) }); // EXPECT ERROR
// Props as failed.
defineFlow(driver.failed, { play: (s) => StateResult.ok(driver.active(s), { ...s }) }); // EXPECT ERROR
// A failed instance of another state.
defineFlow(driver.failed, { play: (s) => StateResult.ok(driver.active(s), producer.active({ id: "p" })) }); // EXPECT ERROR
// A definition's call is typed as its variants' calls are, so it fits ok's failed.
defineFlow(driver.failed, { play: (s, _signal, ctx) => StateResult.ok(driver.active(s), driver(ctx)) });
// transition takes next, temp and failed, all instances, and the options fourth.
defineFlow(driver.failed, { play: (s) => StateResult.transition(driver.active(s), driver.idle(s), driver.failed(s)) });
defineFlow(driver.failed, {
  play: (s) => StateResult.transition(driver.active(s), driver.idle(s), driver.failed(s), { timeoutMs: 1 }),
});
// A function as failed.
defineFlow(driver.failed, {
  play: (s) => StateResult.transition(driver.active(s), driver.idle(s), () => driver.failed(s)), // EXPECT ERROR
});
// next alone: temp and failed are required.
defineFlow(driver.failed, { play: (s) => StateResult.transition(driver.active(s)) }); // EXPECT ERROR
// next and temp alone: failed is required.
defineFlow(driver.failed, { play: (s) => StateResult.transition(driver.active(s), driver.idle(s)) }); // EXPECT ERROR
// No temp.
defineFlow(driver.failed, { play: (s) => StateResult.transition(driver.active(s), undefined, driver.failed(s)) }); // EXPECT ERROR
// The options where temp goes.
defineFlow(driver.failed, {
  play: (s) => StateResult.transition(driver.active(s), { timeoutMs: 1 }, driver.failed(s)), // EXPECT ERROR
});
// The options where failed goes.
defineFlow(driver.failed, { play: (s) => StateResult.transition(driver.active(s), driver.idle(s), { timeoutMs: 1 }) }); // EXPECT ERROR
// Props as transition's next.
defineFlow(driver.failed, { play: (s) => StateResult.transition({ ...s }, driver.idle(s), driver.failed(s)) }); // EXPECT ERROR
// Props as temp.
defineFlow(driver.failed, { play: (s) => StateResult.transition(driver.active(s), { ...s }, driver.failed(s)) }); // EXPECT ERROR
// Props as failed.
defineFlow(driver.failed, { play: (s) => StateResult.transition(driver.active(s), driver.idle(s), { ...s }) }); // EXPECT ERROR
// An options key other than timeoutMs.
defineFlow(driver.failed, {
  play: (s) => StateResult.transition(driver.active(s), driver.idle(s), driver.failed(s), { timeout: 5 }), // EXPECT ERROR
});
// Another state's instance as temp.
defineFlow(driver.failed, {
  play: (s) => StateResult.transition(driver.active(s), producer.active({ id: "p" }), driver.failed(s)), // EXPECT ERROR
});
// StateResult and HandlerResult do not mix: a HandlerResult from a reducer.
defineFlow(driver.failed, { play: () => HandlerResult.ok() }); // EXPECT ERROR

// observe() takes variants of the target's states: the target's type must have a prop under each variant's state
// name, of that state's props or a subtype of them, where applyFlow puts the instance, or hold that state's instances
// below its top-level props, in a prop or an Items, at any depth.
export const part = defineState<{ n: number }>().name("part").variant("on", { initial: true }).build();
export const twin = defineState<{ n: number }>().name("twin").variant("on", { initial: true }).build();
export const solo = defineState<{ n: number }>().name("solo").variant("on", { initial: true }).build();
export const holder = defineState<{ part: InstanceOf<typeof part>; n: number }>()
  .name("holder")
  .variant("x", { initial: true })
  .variant("y")
  .build();
declare const target: { holder: { part: InstanceOf<typeof part>; n: number }; solo: InstanceOf<typeof solo> };
observe(target, [holder.x, holder.y, solo.on], () => {});
observe(
  target,
  [holder.x],
  (state) => state.part,
  (a, b) => a.n !== b.n,
);
// A variant of a nested state the target holds, alone or with top-level ones; the callback gets the node's path.
observe(target, [part.on], (state, path) => `${path}: ${state.n}`);
observe(target, [holder.x, part.on], () => {});
// A variant of a state outside the target, though its props are those of a top-level state.
observe(target, [twin.on], () => {}); // EXPECT ERROR
// One variant of the array outside the target is enough.
observe(target, [solo.on, twin.on], () => {}); // EXPECT ERROR
// The elements of an Items, two levels below the target's props.
export const cam = defineState<{ id: string }>().name("cam").variant("live", { initial: true }).build();
export const rack = defineState<{ cams: Items<typeof cam> }>().name("rack").variant("up", { initial: true }).build();
declare const site: { hall: { rack: InstanceOf<typeof rack> } };
observe(site, [cam.live, rack.up], () => {});
observe(site, [twin.on], () => {}); // EXPECT ERROR
// A nested state in an optional or nullable prop is held too.
declare const maybe: { hall: { rack?: InstanceOf<typeof rack> | null } };
observe(maybe, [cam.live, rack.up], () => {});
// So is an Items in an optional or nullable prop.
declare const crowd: { hall: { cams?: Items<typeof cam> | null } };
observe(crowd, [cam.live], () => {});
observe(crowd, [twin.on], () => {}); // EXPECT ERROR
// A prop typed any holds no state the types can name, so it lets no variant through.
declare const loose: { holder: { part: InstanceOf<typeof part>; n: number; extra: any } };
observe(loose, [twin.on], () => {}); // EXPECT ERROR
// A state whose props hold its own instances is searched down to a bounded depth.
interface NodeProps {
  label: string;
  children: Items<NodeDef>;
}
type NodeDef = StateDefinition<NodeProps, "leaf", unknown, "node">;
declare const node: NodeDef;
export const tree = defineState<{ root: InstanceOf<NodeDef> }>().name("tree").variant("on", { initial: true }).build();
declare const forest: { tree: { root: InstanceOf<NodeDef> } };
observe(forest, [tree.on, node.leaf], () => {});
observe(forest, [twin.on], () => {}); // EXPECT ERROR
// Inside a class the target is `this`, which the check resolves through the class for a top-level state's variant;
// the search for nested states cannot resolve it, so a nested state's variant needs a reference typed as the class.
export class Owner {
  readonly holder: { part: InstanceOf<typeof part>; n: number } = { part: part.on({ n: 0 }), n: 0 };
  readonly solo: InstanceOf<typeof solo> = solo.on({ n: 0 });
  constructor() {
    observe(this, [holder.x, solo.on], (state) => state);
    observe(this, [twin.on], () => {}); // EXPECT ERROR
    observe(this, [part.on], () => {}); // EXPECT ERROR
    observe(this as Owner, [part.on, solo.on], (state) => state);
  }
}
// A prop narrower than the state's props, as an initial value infers it, is still where applyFlow puts the instance.
declare const narrow: { solo: { n: 0 } };
observe(narrow, [solo.on], () => {});
// A target whose type leaves its props open has no prop for the state.
declare const open: Record<string, unknown>;
observe(open, [solo.on], () => {}); // EXPECT ERROR
// A variant whose type names no state, as generic code types them, leaves nothing to check: the call compiles, and its
// observer fires for whatever node of the target holds its state.
declare const unnamed: StateVariant<{ n: number }>;
observe(target, [unnamed], () => {});
// The state's name is part of an instance's type: two states with the same props give two types.
export const sameProps: InstanceOf<typeof solo> = twin.on({ n: 1 }); // EXPECT ERROR
