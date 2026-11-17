import { afterEach, expect, it } from "vitest";
import {
  recordingWorld,
  runCounterExample,
  runPlayerExample,
  runSessionExample,
  Session,
} from "../../examples/examples";
import { addGlobalLogHandler, Box, defineSignal, lock } from "..";
import { writeTapLines } from "./fixtures/tap-lines";

const removers: (() => void)[] = [];
afterEach(() => {
  for (const remove of removers.splice(0)) {
    remove();
  }
});

/**
 * Every telling of a tap over one scripted program on the engine's examples, compared with tap-examples.txt beside
 * this file: the counter, player and session scenarios of examples.ts (plain steps, refusals, transitions, a timeout
 * whose late answer comes after its end, accepted aborts whose work answers the abort), then a send queued behind a
 * transition. Each line is one telling in the format stated in fixtures/tap-lines.ts, built from string forms the
 * engine has and from numbers the fixture's tap gives targets, signals and calls in the order it first meets them.
 * The scenarios' own awaits are part of the fixture: a late answer is told while the scenario still waits for the
 * play that timed out, so its line stands before the scenario's next dispatch.
 */
it("tells every step of the examples, one line per telling, as stored", async () => {
  // A global handler, so the entries go to it and not to the console.
  removers.push(addGlobalLogHandler(() => {}));
  const lines: string[] = [];
  removers.push(writeTapLines(lines));
  const { world } = recordingWorld();

  await runCounterExample(world);
  await runPlayerExample(world);
  await runSessionExample(world);
  // What the scenarios never do: a send queued behind a transition. Its tellings come at its turn, after the `ended`
  // of the transition it waited for. A signal made here by name reaches the session's reducers as its own would.
  const session = new Session(world);
  await session.open();
  {
    await using send = await lock(session);
    const track = Box.of({ id: "cam" });
    send(defineSignal<{ key: string; track: Box<{ id: string }> }>("addProducer")({ key: "cam", track }));
    await send(defineSignal<{ key: string }>("pause")({ key: "cam" })).done();
  }

  await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("tap-examples.txt");
});
