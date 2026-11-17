// What a refusal's data costs a dispatch: a synchronous dispatch, which never builds a failure, and a transition whose
// work is refused, without data and with it, through to the FAILURE reducer of its failed end. Each flow is set up
// outside the timed part; a transition is sent and its outcome awaited, then a synchronous signal resets it.
import { bench, describe } from "vitest";

import {
  applyFlow,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  FAILURE,
  HandlerResult,
  StateResult,
  setConsoleLogSilenced,
} from "..";

setConsoleLogSilenced(true);

const inc = defineSignal("inc");
const counter = defineState<{ n: number }>()
  .name("counter")
  .signals({ inc })
  .variant("idle", { initial: true })
  .build();
defineFlow(counter.idle, { inc: (s) => ({ n: s.n + 1 }) });
const sync = { counter: { n: 0 } };
applyFlow(sync, [counter], () => {});

const start = defineSignal("start");
const back = defineSignal("back");
type JobProps = { n: number; retry: boolean };
const job = defineState<JobProps>()
  .name("job")
  .signals({ start, back })
  .variant("idle", { initial: true })
  .variant("running", { transitional: true })
  .variant("done", { async: true })
  .variant("failed")
  .build();
defineFlow(job.idle, {
  start: (s) =>
    StateResult.transition(job.done({ ...s, n: s.n + 1 }), job.running(s), job.failed(s), { timeoutMs: 1000 }),
});
defineFlow(job.done, { back: (s) => job.idle(s) });
defineFlow(
  job.failed,
  { back: (s) => job.idle(s) },
  { [FAILURE]: (s, { data }) => ({ ...s, retry: data?.final !== true }) },
);

function makeJob(answer: () => Promise<HandlerResult>) {
  const target = { job: { n: 0, retry: true } };
  applyFlow(target, [job], (sm) => sm.addTransitionHandler(job.done, answer));
  return target;
}
const plain = makeJob(async () => HandlerResult.rejected("refused"));
const withData = makeJob(async () => HandlerResult.rejected("refused", { final: true }));

async function refuse(target: typeof plain) {
  await dispatch(target, start()).done();
  dispatch(target, back());
}
// Without this warm-up of both paths in turn, the case timed later ran up to 20% faster than the one before it even
// when both ran the same code, which hid the difference this bench is for.
for (let i = 0; i < 20_000; i++) {
  await refuse(plain);
  await refuse(withData);
}

describe("refusal data", () => {
  bench("sync reducer dispatch", () => {
    dispatch(sync, inc());
  });
  bench("transition, work rejected without data", () => refuse(plain));
  bench("transition, work rejected with data", () => refuse(withData));
});
