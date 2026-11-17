import { describe, expect, it } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  HandlerResult,
  type InstanceOf,
  type Items,
  type StateManager,
  StateResult,
  type StateVariant,
} from "..";

/**
 * A failed that holds, at one path, the instance the step before it entered or updated there. The failed step calls
 * the handlers of its diff from the instances before the signal, as any step does, so it enters or updates that
 * instance again: the refused step's handler undid its work when the step's signal aborted, the second call does it
 * again, and the world agrees with the state, which commits the failed holding that instance. The result is the
 * refusal. Definitions are made inside each test, because defineFlow binds once per variant.
 */
describe("a failed that holds the instance the step before it entered or updated", () => {
  const switchOn = defineSignal("switchOn");

  /** A lamp, and a room that holds one; their reducers are left to the test. */
  function defineRoom() {
    const lamp = defineState<{ watts: number }>()
      .name("lamp")
      .signals({ switchOn })
      .variant("off", { initial: true })
      .variant("on")
      .build();
    const room = defineState<{ lamp: InstanceOf<typeof lamp> }>()
      .name("room")
      .signals({ switchOn })
      .variant("dark", { initial: true })
      .variant("dimming", { transitional: true })
      .variant("lit")
      .variant("broken")
      .build();

    return { lamp, room };
  }
  type Room = ReturnType<typeof defineRoom>;
  type Lamp = InstanceOf<Room["lamp"]>;
  type RoomTarget = { room: InstanceOf<Room["room"]> };

  /**
   * Registers handlers that write what they do to `world`: lamp.on's enter handler switches the bulb on, and its update
   * handler sets the bulb's watts, each undone when its step's signal aborts; the enter handler of `refusing` refuses,
   * so a step into that variant never commits.
   */
  function switchBulb(sm: StateManager, { lamp }: Room, refusing: StateVariant, world: string[]): void {
    sm.addEnterHandler(lamp.on, ({ watts }, _snapshot, _prev, _key, signal) => {
      world.push(`on ${watts}`);
      signal.addEventListener("abort", () => world.push(`off ${watts}`));

      return HandlerResult.ok();
    });

    sm.addUpdateHandler(lamp.on, ({ watts }, _snapshot, prev, _key, signal) => {
      world.push(`${prev.watts} to ${watts}`);
      signal.addEventListener("abort", () => world.push(`${watts} back to ${prev.watts}`));

      return HandlerResult.ok();
    });

    sm.addEnterHandler(refusing, () => {
      world.push("no power");
      return HandlerResult.rejected("no power");
    });
  }

  /** A room target that holds `held` as its lamp, with the handlers of switchBulb. */
  function makeRoom(made: Room, held: Lamp, refusing: StateVariant, world: string[]): RoomTarget {
    const target = { room: { lamp: held } };
    applyFlow(target, [made.room], (sm) => switchBulb(sm, made, refusing, world));

    return target as unknown as RoomTarget;
  }

  /** What a case defines: the lamp the room holds before the signal, the lamp both steps hold, and the room variant
   * whose enter handler refuses. */
  type Case = { held: Lamp; shared: Lamp; refusing: StateVariant };

  // The bulb goes on, off again as the refused step's signal aborts, and on once more in the failed step.
  const onOffOn = ["no power", "on 60", "off 60", "on 60"];

  it.each<[string, (made: Room) => Case, string[], string]>([
    [
      "ok(next, failed) whose next and failed hold one new lamp: the failed step enters it again",
      ({ lamp, room }) => {
        const on = lamp.on({ watts: 60 });
        defineFlow(room.dark, { switchOn: () => StateResult.ok(room.lit({ lamp: on }), room.broken({ lamp: on })) });

        return { held: lamp.off({ watts: 0 }), shared: on, refusing: room.lit };
      },
      onOffOn,
      "room.broken(lamp=lamp.on(watts=60))",
    ],
    [
      "ok(next, failed) whose next and failed hold one new lamp, which the step updates: the failed step updates it again",
      ({ lamp, room }) => {
        const brighter = lamp.on({ watts: 100 });
        defineFlow(room.dark, {
          switchOn: () => StateResult.ok(room.lit({ lamp: brighter }), room.broken({ lamp: brighter })),
        });

        return { held: lamp.on({ watts: 60 }), shared: brighter, refusing: room.lit };
      },
      // Updates run before enters, so the room's refusal comes second.
      ["60 to 100", "no power", "100 back to 60", "60 to 100"],
      "room.broken(lamp=lamp.on(watts=100))",
    ],
    [
      "a transition whose temp and failed hold one new lamp, its temp step refused: the failed step enters it again",
      ({ lamp, room }) => {
        const on = lamp.on({ watts: 60 });
        defineFlow(room.dark, {
          switchOn: () =>
            StateResult.transition(
              room.lit({ lamp: lamp.on({ watts: 60 }) }),
              room.dimming({ lamp: on }),
              room.broken({ lamp: on }),
            ),
        });

        return { held: lamp.off({ watts: 0 }), shared: on, refusing: room.dimming };
      },
      onOffOn,
      "room.broken(lamp=lamp.on(watts=60))",
    ],
    [
      "a transition whose next and failed hold one new lamp that temp does not, its end step refused: the failed end enters it again",
      ({ lamp, room }) => {
        const on = lamp.on({ watts: 60 });
        defineFlow(room.dark, {
          switchOn: (s) => StateResult.transition(room.lit({ lamp: on }), room.dimming(s), room.broken({ lamp: on })),
        });

        return { held: lamp.off({ watts: 0 }), shared: on, refusing: room.lit };
      },
      onOffOn,
      "room.broken(lamp=lamp.on(watts=60))",
    ],
    [
      "a transition whose temp swaps out the lamp the room holds while next and failed keep it, its end step refused: the failed end enters it again",
      ({ lamp, room }) => {
        defineFlow(room.dark, {
          switchOn: (s) =>
            StateResult.transition(room.lit(s), room.dimming({ lamp: lamp.off({ watts: 1 }) }), room.broken(s)),
        });
        const held = lamp.on({ watts: 60 });

        return { held, shared: held, refusing: room.lit };
      },
      onOffOn,
      "room.broken(lamp=lamp.on(watts=60))",
    ],
  ])("%s", (_what, define, world, committed) => {
    const made = defineRoom();
    const { held, shared, refusing } = define(made);
    const seen: string[] = [];
    const target = makeRoom(made, held, refusing, seen);

    // A transition without work ends inside the call, so every case has its result here.
    const result = dispatch(target, switchOn());

    expect(String(result)).toBe("Rejected: no power");
    expect(String(target.room)).toBe(committed);
    expect(target.room.lamp).toBe(shared);

    expect(seen).toEqual(world);
  });

  it("ok(on, on), one new instance of the node itself as next and failed: the failed step enters it again", () => {
    const made = defineRoom();
    const { lamp } = made;
    const on = lamp.on({ watts: 60 });
    defineFlow(lamp.off, { switchOn: () => StateResult.ok(on, on) });

    // A fuse, another state, blows on the same signal, and its enter handler refuses.
    const fuse = defineState<{ amps: number }>()
      .name("fuse")
      .signals({ switchOn })
      .variant("whole", { initial: true })
      .variant("blown")
      .build();
    defineFlow(fuse.whole, { switchOn: (f) => fuse.blown(f) });

    const world: string[] = [];
    const target = { lamp: { watts: 0 }, fuse: { amps: 10 } };
    applyFlow(target, [lamp, fuse], (sm) => switchBulb(sm, made, fuse.blown, world));

    const result = dispatch(target, switchOn());

    expect(String(result)).toBe("Rejected: no power");
    expect(target.lamp).toBe(on);
    expect(String(target.fuse)).toBe("fuse.whole(amps=10)");

    // The states take their turns in the flow's order: the lamp enters before the fuse refuses.
    expect(world).toEqual(["on 60", "no power", "off 60", "on 60"]);
  });

  it("an element that next and failed hold under the same key of an Items: the failed step enters it again under that key", () => {
    const add = defineSignal("add");
    const el = defineState<{ n: number }>().name("el").variant("on", { initial: true }).build();
    const host = defineState<{ els: Items<typeof el> }>()
      .name("host")
      .signals({ add })
      .variant("idle", { initial: true })
      .variant("busy")
      .build();
    const shared = el.on({ n: 1 });
    defineFlow(host.idle, {
      add: (h) =>
        StateResult.ok(host.busy({ els: h.els.with("a", shared) }), host.idle({ els: h.els.with("a", shared) })),
    });

    const entered: unknown[] = [];
    const target = { host: { els: el.items() } };
    applyFlow(target, [host], (sm) => {
      sm.addEnterHandler(el.on, (_s, _snapshot, _prev, key) => {
        entered.push(key);
        return HandlerResult.ok();
      });
      sm.addEnterHandler(host.busy, () => HandlerResult.rejected("busy"));
    });

    const result = dispatch(target, add());

    expect(String(result)).toBe("Rejected: busy");
    expect((target as unknown as { host: InstanceOf<typeof host> }).host.els.get("a")).toBe(shared);

    expect(entered).toEqual(["a", "a"]);
  });

  it("a failed that keeps the committed instance where the step keeps it too: the failed step commits it with no call", () => {
    const made = defineRoom();
    const { lamp, room } = made;
    defineFlow(room.dark, { switchOn: (s) => StateResult.ok(room.lit(s), room.broken(s)) });

    const world: string[] = [];
    const target = makeRoom(made, lamp.off({ watts: 0 }), room.lit, world);
    const committed = target.room.lamp;

    const result = dispatch(target, switchOn());

    expect(String(result)).toBe("Rejected: no power");
    expect(String(target.room)).toBe("room.broken(lamp=lamp.off(watts=0))");
    expect(target.room.lamp).toBe(committed);

    expect(world).toEqual(["no power"]);
  });

  it("a failed whose new instance is its own: the failed step enters that one, so the bulb is on as the state says", () => {
    const made = defineRoom();
    const { lamp, room } = made;
    defineFlow(room.dark, {
      switchOn: () =>
        StateResult.ok(room.lit({ lamp: lamp.on({ watts: 60 }) }), room.broken({ lamp: lamp.on({ watts: 40 }) })),
    });

    const world: string[] = [];
    const target = makeRoom(made, lamp.off({ watts: 0 }), room.lit, world);

    const result = dispatch(target, switchOn());

    expect(String(result)).toBe("Rejected: no power");
    expect(String(target.room)).toBe("room.broken(lamp=lamp.on(watts=40))");

    // The refused step switched its own bulb on and off again; the failed step switched on the bulb it holds.
    expect(world).toEqual(["no power", "on 60", "off 60", "on 40"]);
  });
});
