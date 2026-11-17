import { describe, expect, it } from "vitest";

import {
  applyFlow,
  Box,
  defineFlow,
  defineSignal,
  defineState,
  dispatch,
  HandlerResult,
  type InstanceOf,
  ResultKind,
  type StateManager,
  StateResult,
} from "..";

/**
 * The step's AbortSignal, the fifth argument of every enter and update handler. It aborts when the step that ran the
 * handler does not commit, whatever kept it from committing, so the handler releases what it made in that call, such
 * as a handle it returned in a named result that never landed; once the step committed, it never aborts. Definitions
 * are made inside each test, because defineFlow binds once per variant.
 */
describe("the step's AbortSignal", () => {
  const start = defineSignal("start");
  const bump = defineSignal("bump");
  const stop = defineSignal("stop");

  /** What a handler makes: a poll that runs until the handler's abort listener stops it. */
  type Poll = { running: boolean };
  type PollerProps = { n: number; poll: Box<Poll> | null };

  /**
   * A poller: idle -> polling on start, a new polling instance on bump, idle on stop. `started` is polling's reducer of
   * its named result started, which by default puts the poll a handler started in props.
   */
  function definePoller(started = (s: PollerProps, { poll }: { poll: Box<Poll> }): PollerProps => ({ ...s, poll })) {
    const poller = defineState<PollerProps>()
      .name("poller")
      .signals({ start, bump, stop })
      .variant("idle", { initial: true })
      .variant("polling", { results: { started: (data) => data as { poll: Box<Poll> } } })
      .build();

    defineFlow(poller.idle, { start: (s) => poller.polling(s) });
    defineFlow(
      poller.polling,
      { bump: (s) => ({ ...s, n: s.n + 1 }), stop: (s) => poller.idle({ ...s, poll: null }) },
      { started },
    );

    return poller;
  }
  type Poller = ReturnType<typeof definePoller>;

  /** A handler of polling: starts a poll, stopped when `signal` aborts, and returns it as the named result started. */
  function startPoll(poller: Poller, polls: Poll[], signal: AbortSignal) {
    const poll: Poll = { running: true };
    polls.push(poll);

    signal.addEventListener(
      "abort",
      () => {
        poll.running = false;
      },
      { once: true },
    );

    return poller.polling.results.started({ poll: Box.of(poll) });
  }

  /** A target of the poller's flow, with the handlers `init` registers. */
  function makePoller(poller: Poller, init: (sm: StateManager) => void): { poller: InstanceOf<Poller> } {
    const target = { poller: { n: 0, poll: null } };
    applyFlow(target, [poller], init);

    return target as unknown as { poller: InstanceOf<Poller> };
  }

  it("an enter handler's poll, returned in a named result, stops when a later handler of the same round refuses: the listener runs, and nothing commits", () => {
    const poller = definePoller();

    const polls: Poll[] = [];
    const target = makePoller(poller, (sm) => {
      sm.addEnterHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => startPoll(poller, polls, signal));
      sm.addEnterHandler(poller.polling, () => HandlerResult.rejected("no element"));
    });
    const before = target.poller;

    const result = dispatch(target, start());

    expect(result.message).toBe("no element");
    expect(target.poller).toBe(before);

    expect(polls).toEqual([{ running: false }]);
  });

  it("an update handler's poll stops the same way when a later handler of the same round refuses", () => {
    const poller = definePoller();

    const polls: Poll[] = [];
    const target = makePoller(poller, (sm) => {
      sm.addUpdateHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => startPoll(poller, polls, signal));
      sm.addUpdateHandler(poller.polling, () => HandlerResult.rejected("no element"));
    });

    // start enters polling; the update handlers run only on bump.
    dispatch(target, start());
    const before = target.poller;

    const result = dispatch(target, bump());

    expect(result.message).toBe("no element");
    expect(target.poller).toBe(before);

    expect(polls).toEqual([{ running: false }]);
  });

  it.each<[string, (polls: Poll[]) => { poller: InstanceOf<Poller> }, string]>([
    [
      "a later handler of the same round throws",
      (polls) => {
        const poller = definePoller();

        return makePoller(poller, (sm) => {
          sm.addEnterHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => startPoll(poller, polls, signal));
          sm.addEnterHandler(poller.polling, () => {
            throw new Error("no element");
          });
        });
      },
      "no element",
    ],
    [
      "the named result does not fold: its result reducer throws",
      (polls) => {
        const poller = definePoller(() => {
          throw new Error("the reducer broke");
        });

        return makePoller(poller, (sm) => {
          sm.addEnterHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => startPoll(poller, polls, signal));
        });
      },
      "the reducer broke",
    ],
  ])("the poll stops when %s: the dispatch is an Error, and nothing commits", (_what, make, message) => {
    const polls: Poll[] = [];
    const target = make(polls);
    const before = target.poller;

    const result = dispatch(target, start());

    expect(result.kind).toBe(ResultKind.Error);
    expect(result.error?.message).toBe(message);
    expect(target.poller).toBe(before);

    expect(polls).toEqual([{ running: false }]);
  });

  /** A lamp, a state of the poller's flow that takes start too, so its result reducers come second. */
  function defineLamp() {
    return defineState<{ on: boolean }>()
      .name("lamp")
      .signals({ start })
      .variant("off", { initial: true })
      .variant("on")
      .build();
  }
  type Lamp = ReturnType<typeof defineLamp>;

  it.each<[string, (lamp: Lamp) => StateResult | InstanceOf<Lamp>, string]>([
    [
      "another state's answer to the named result refuses",
      () => StateResult.rejected("the lamp is busy"),
      "the lamp is busy",
    ],
    [
      "a handler of the further round that another state's answer adds refuses, since the step, not the round, commits or not",
      (lamp) => lamp.on({ on: true }),
      "no bulb",
    ],
  ])("the poll stops when %s, and nothing commits", (_what, answer, refusal) => {
    const poller = definePoller();
    const lamp = defineLamp();
    defineFlow(lamp.off, {}, { started: () => answer(lamp) });

    const polls: Poll[] = [];
    const target = { poller: { n: 0, poll: null }, lamp: { on: false } };
    applyFlow(target, [poller, lamp], (sm) => {
      sm.addEnterHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => startPoll(poller, polls, signal));
      sm.addEnterHandler(lamp.on, () => HandlerResult.rejected("no bulb"));
    });
    const before = { ...target };

    const result = dispatch(target, start());

    expect(result.message).toBe(refusal);
    expect(target.poller).toBe(before.poller);
    expect(target.lamp).toBe(before.lamp);

    expect(polls).toEqual([{ running: false }]);
  });

  it("the poll stops when a throw stops the step before its commit, a string form that throws while the step is logged", () => {
    const poller = defineState<PollerProps>()
      .name("poller")
      .signals({ start })
      .variant("idle", { initial: true })
      .variant("polling", { results: { started: (data) => data as { poll: Box<Poll> } } })
      .stringRepr((s) => {
        if (s.poll !== null) {
          throw new Error("no string form with a poll");
        }

        return `n=${s.n}`;
      })
      .build();

    defineFlow(poller.idle, { start: (s) => poller.polling(s) });
    defineFlow(poller.polling, {}, { started: (s, { poll }) => ({ ...s, poll }) });

    const polls: Poll[] = [];
    const target = { poller: { n: 0, poll: null } };
    applyFlow(target, [poller], (sm) => {
      sm.addEnterHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => {
        const poll: Poll = { running: true };
        polls.push(poll);

        signal.addEventListener("abort", () => {
          poll.running = false;
        });

        return poller.polling.results.started({ poll: Box.of(poll) });
      });
    });
    const before = target.poller;

    expect(() => dispatch(target, start())).toThrow("no string form with a poll");

    expect(target.poller).toBe(before);

    expect(polls).toEqual([{ running: false }]);
  });

  it("a committed step never aborts its signal, also when later steps of the node are refused; a refused step aborts its own", () => {
    const poller = definePoller();

    const polls: Poll[] = [];
    const signals: AbortSignal[] = [];
    let refuse = false;
    const target = makePoller(poller, (sm) => {
      sm.addEnterHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => {
        signals.push(signal);
        return startPoll(poller, polls, signal);
      });
      sm.addUpdateHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => {
        signals.push(signal);
        return refuse ? HandlerResult.rejected("refused") : HandlerResult.ok();
      });
      sm.addExitHandler(poller.polling, () => (refuse ? HandlerResult.rejected("refused") : HandlerResult.ok()));
    });

    dispatch(target, start());
    dispatch(target, bump());

    refuse = true;
    dispatch(target, bump());
    dispatch(target, stop());

    expect(String(target.poller)).toMatch(/^poller\.polling\(n=1 poll=Box/);
    expect(target.poller.poll?.deref()).toBe(polls[0]);

    expect(polls).toEqual([{ running: true }]);

    // The enter's step and the first bump's committed; the second bump's was refused.
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false, true]);
  });

  it("a step into failed commits whatever its handlers return, so its signal never aborts, while the refused step's has", () => {
    const poller = defineState<PollerProps>()
      .name("poller")
      .signals({ start })
      .variant("idle", { initial: true })
      .variant("polling", { results: { started: (data) => data as { poll: Box<Poll> } } })
      .variant("stalled", { results: { started: (data) => data as { poll: Box<Poll> } } })
      .build();

    defineFlow(poller.idle, { start: (s) => StateResult.ok(poller.polling(s), poller.stalled(s)) });
    defineFlow(poller.polling, {}, { started: (s, { poll }) => ({ ...s, poll }) });
    defineFlow(poller.stalled, {}, { started: (s, { poll }) => ({ ...s, poll }) });

    const polls: Array<{ variant: string; running: boolean }> = [];
    const target = { poller: { n: 0, poll: null } };
    applyFlow(target, [poller], (sm) => {
      for (const variant of [poller.polling, poller.stalled]) {
        sm.addEnterHandler(variant, (s, _snapshot, _prev, _key, signal) => {
          const poll = { variant: String(s), running: true };
          polls.push(poll);

          signal.addEventListener("abort", () => {
            poll.running = false;
          });

          return variant.results.started({ poll: Box.of(poll) });
        });
        sm.addEnterHandler(variant, () => HandlerResult.rejected("no element"));
      }
    });
    const typed = target as unknown as { poller: InstanceOf<typeof poller> };

    const result = dispatch(target, start());

    // The refusal of polling merged with the step into failed's own refusal, which joins the result as an Error.
    expect(result.kind).toBe(ResultKind.Error);

    expect(String(typed.poller)).toMatch(/^poller\.stalled\(n=0 poll=Box/);

    expect(polls).toEqual([
      { variant: "poller.polling(n=0 poll=N)", running: false },
      { variant: "poller.stalled(n=0 poll=N)", running: true },
    ]);
  });

  it("a declared transition's end step gives its enter handlers a signal of its own, apart from the work's, which aborts when a later handler of the end refuses", async () => {
    const job = defineState<{ poll: Box<Poll> | null }>()
      .name("job")
      .signals({ start })
      .variant("idle", { initial: true })
      .variant("starting", { transitional: true })
      .variant("running", { async: true, results: { started: (data) => data as { poll: Box<Poll> } } })
      .variant("failed")
      .build();

    defineFlow(job.idle, { start: (s) => StateResult.transition(job.running(s), job.starting(s), job.failed(s)) });
    defineFlow(job.running, {}, { started: (s, { poll }) => ({ ...s, poll }) });

    let work: AbortSignal | undefined;
    let end: AbortSignal | undefined;
    const poll: Poll = { running: true };
    const target = { job: { poll: null } };
    applyFlow(target, [job], (sm) => {
      sm.addTransitionHandler(job.running, async (_next, _snapshot, _prev, _key, signal) => {
        work = signal;
        return HandlerResult.ok();
      });
      sm.addEnterHandler(job.running, (_s, _snapshot, _prev, _key, signal) => {
        end = signal;

        signal.addEventListener("abort", () => {
          poll.running = false;
        });

        return job.running.results.started({ poll: Box.of(poll) });
      });
      sm.addEnterHandler(job.running, () => HandlerResult.rejected("no worker"));
    });

    const result = await dispatch(target, start()).done();

    expect(result.message).toBe("no worker");
    expect(String(target.job)).toBe("job.failed(poll=N)");

    expect(poll.running).toBe(false);

    expect(end).toBeInstanceOf(AbortSignal);
    expect(end).not.toBe(work);
  });

  it("the signal aborts inside the dispatch: a listener's synchronous dispatch to its own target throws, as a handler's does", () => {
    const poller = definePoller();

    const thrown: unknown[] = [];
    const target = makePoller(poller, (sm) => {
      sm.addEnterHandler(poller.polling, (_s, _snapshot, _prev, _key, signal) => {
        signal.addEventListener("abort", () => {
          try {
            dispatch(target, stop());
          } catch (err) {
            thrown.push((err as Error).message);
          }
        });

        return HandlerResult.ok();
      });
      sm.addEnterHandler(poller.polling, () => HandlerResult.rejected("no element"));
    });

    dispatch(target, start());

    expect(thrown).toEqual([
      "Cannot dispatch to Object from inside its own dispatch [SF016] Return a named result from the handler, or send after the dispatch returns.",
    ]);
  });
});
