/**
 * The engine's examples for the tools' command (packages/tools/src/flow-command.ts): every definition the examples
 * export, and a walk subject on the session's media. The builder registers no handler: Player and Session take no flow
 * config, so they cannot start from given states, and every reducer is the definitions' own, so a plain target reaches
 * every state they reach. The signals are made here by name, as the examples keep theirs to themselves.
 */
import { applyFlow, Box, defineSignal, type FlowConfig, lock } from "../src";
import { driverState, media, producer, transport } from "./examples";

export const definitions = [driverState, media, producer, transport];

export const subject = {
  /** A target of media on `flow`, which starts as a Session's does unless `flow.start` names media. */
  build(flow: FlowConfig): object {
    const target = { media: { transport: transport.closed({ socket: null }), producers: producer.items() } };
    applyFlow(target, [media], () => {}, flow);
    return target;
  },
  actions: {
    open: { fact: () => defineSignal("open")() },
    "add cam": {
      fact: () => defineSignal<Record<string, unknown>>("addProducer")({ key: "cam", track: Box.of({ id: "cam" }) }),
    },
    // Removing is a command: told again it commits again, a new collection, so it is a call that sends once.
    "remove cam": {
      call: async (target: object) => {
        await using send = await lock(target);
        await send(defineSignal<Record<string, unknown>>("removeProducer")({ key: "cam" })).done();
      },
    },
    close: { fact: () => defineSignal("close")() },
  },
  invariants: {},
  stepTime: 0,
};
