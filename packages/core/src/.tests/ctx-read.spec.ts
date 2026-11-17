import { describe, expect, it } from "vitest";

import { applyFlow, defineFlow, defineSignal, defineState, dispatch, isIn, ResultKind, stateVar } from "..";

/**
 * A reducer reads a sibling state by name through `ctx.read`, typed by the flow's definitions the state declares, and
 * checks its variant by name with `isIn`: no definition is imported to read another state.
 */
describe("ctx.read and isIn", () => {
  const signals = { arm: defineSignal("arm"), fire: defineSignal("fire") };

  /** The flow's definitions by name, as a state module would import them with `import type`. */
  type Defs = { safety: typeof safety; trigger: typeof trigger };

  const safety = defineState<{ armedBy: string }, Defs>()
    .name("safety")
    .signals(signals)
    .variant("on", { initial: true })
    .variant("off")
    .build();
  const trigger = defineState<{ shots: number }, Defs>()
    .name("trigger")
    .signals(signals)
    .variant("idle", { initial: true })
    .variant("fired")
    .build();

  defineFlow(safety.on, { arm: (s) => safety.off({ ...s, armedBy: "arm" }) });
  defineFlow(safety.off, {});
  defineFlow(trigger.idle, {
    // The sibling by name: its variant decides, and its props are typed.
    fire: (s, _, ctx) => {
      const guard = ctx.read("safety");
      return isIn(guard, "off") && guard.armedBy === "arm" ? trigger.fired({ shots: s.shots + 1 }) : s;
    },
  });
  defineFlow(trigger.fired, {});

  it("reads the sibling's committed instance by name and checks its variant by name", () => {
    const gun = { safety: { armedBy: "" }, trigger: { shots: 0 } };
    applyFlow(gun, [safety, trigger], () => {});

    expect(dispatch(gun, signals.fire()).kind).toBe(ResultKind.OK);
    expect(stateVar(gun.trigger)).toBe(trigger.idle);

    dispatch(gun, signals.arm());
    expect(dispatch(gun, signals.fire()).kind).toBe(ResultKind.OK);
    expect(stateVar(gun.trigger)).toBe(trigger.fired);
    expect(gun.trigger.shots).toBe(1);
  });

  it("a name the flow has no state of is the reducer's Error", () => {
    const bump = defineSignal("bump");
    const lone = defineState<{ n: number }>().name("lone").signals({ bump }).variant("only", { initial: true }).build();
    defineFlow(lone.only, {
      bump: (s, _, ctx) => {
        ctx.read("missing");
        return s;
      },
    });
    const app = { lone: { n: 0 } };
    applyFlow(app, [lone], () => {});
    const result = dispatch(app, bump());
    expect(result.kind).toBe(ResultKind.Error);
    expect(String(result)).toContain("No state missing in the flow");
  });
});
