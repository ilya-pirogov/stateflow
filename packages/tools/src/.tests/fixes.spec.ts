import { applyFlow, defineFlow, defineSignal, defineState, HandlerResult, lock } from "@state-flow/core";
import { expect, it, vi } from "vitest";
import { handlersOff, standIn, TestClock } from "..";

it("standIn boxes the value itself: its class, methods and getters stay", () => {
  class Socket {
    #open = true;
    get open(): boolean {
      return this.#open;
    }
    close(): void {
      this.#open = false;
    }
  }
  const socket = new Socket();
  const box = standIn(socket);
  box.deref().close();
  box.deref()[Symbol.dispose]();
  expect([box.deref() === socket, socket instanceof Socket, box.deref().open, box.deref().disposals]).toEqual([
    true,
    true,
    false,
    1,
  ]);
  // @ts-expect-error A value with its own Symbol.dispose would lose it.
  standIn({ [Symbol.dispose]() {} });
});
it("time never goes back: overlapping calls end at the latest end, a negative ms moves nothing", async () => {
  const clock = new TestClock();
  const ran: string[] = [];
  clock.setTimeout(() => ran.push("at 1000"), 1000);
  clock.setTimeout(() => ran.push("at 1005"), 1005);
  await Promise.all([clock.advance(1000), clock.advance(10)]);
  await clock.advance(-100);
  await clock.idle();
  expect(ran).toEqual(["at 1000"]);
  await clock.advance(5);
  expect(ran).toEqual(["at 1000", "at 1005"]);
});
it("idle drains whether the runner's fake timers were switched on before or after the module loaded", async () => {
  vi.useFakeTimers();
  try {
    vi.resetModules();
    const { TestClock: LoadedWhileFaked } = await import("..");
    await new LoadedWhileFaked().idle();
    await new TestClock().idle();
  } finally {
    vi.useRealTimers();
  }
});
/** A lamp whose enter handler touches the world when it turns on: `world` shows whether handlers ran. */
function lampWithWorld() {
  const toggle = defineSignal("toggle");
  const lamp = defineState<{ n: number }>()
    .name("lamp")
    .signals({ toggle })
    .variant("off", { initial: true })
    .variant("on")
    .build();
  defineFlow(lamp.off, { toggle: (s) => lamp.on(s) });
  defineFlow(lamp.on, { toggle: (s) => lamp.off(s) });
  const world: string[] = [];
  const target = { lamp: { n: 0 } };
  applyFlow(target, [lamp], (sm) =>
    sm.addEnterHandler(lamp.on, () => {
      world.push("light on");
      return HandlerResult.ok();
    }),
  );
  return { target, toggle, world };
}

it("a nested handlersOff scope's end keeps handlers off until the outer scope ends", async () => {
  const { target, toggle, world } = lampWithWorld();
  {
    using _outer = handlersOff();
    {
      using _inner = handlersOff();
    }
    await using send = await lock(target);
    await send(toggle()).done();
  }
  expect(world).toEqual([]);
});

it("ending a handlersOff scope twice changes nothing: the outer scope and later scopes keep handlers off", async () => {
  const { target, toggle, world } = lampWithWorld();
  {
    using _outer = handlersOff();
    const inner = handlersOff();
    inner[Symbol.dispose]();
    inner[Symbol.dispose]();
    await using send = await lock(target);
    await send(toggle()).done(); // on, inside the outer scope
  }
  expect(world).toEqual([]);
  {
    // A later, correct pair of scopes is not disturbed by the double end before it.
    using _outer = handlersOff();
    {
      using _inner = handlersOff();
    }
    await using send = await lock(target);
    await send(toggle()).done(); // off
    await send(toggle()).done(); // on, inside the outer scope
  }
  expect(world).toEqual([]);
  {
    // With every scope ended, handlers run again.
    await using send = await lock(target);
    await send(toggle()).done(); // off
    await send(toggle()).done(); // on
  }
  expect(world).toEqual(["light on"]);
});
it("a timer that throws rejects advance; time stays at its due time and later timers wait for the next call", async () => {
  const clock = new TestClock();
  const ran: number[] = [];
  clock.setTimeout(() => {
    throw new Error("boom");
  }, 5);
  clock.setTimeout(() => ran.push(8), 8);
  await expect(clock.advance(10)).rejects.toThrow("boom");
  await clock.advance(2);
  expect(ran).toEqual([]);
  await clock.advance(1);
  expect(ran).toEqual([8]);
});
