// NOTE: this examples file deliberately demonstrates the deprecated bare dispatch() —
// the doc text below contrasts it with the recommended lock() + send() pattern.
import { applyFlow, dispatch, observe, sync } from "./flow";
import { Result } from "./result";
import { defineSignal } from "./signal";
import { defineFlow, defineState } from "./state";
import type { Infer } from "./utils";

//#region State Defs

// At first, we need to define signals we're going to use
const signals = {
  // they may accept arguments
  next: defineSignal<{ allow: boolean; incr: boolean }>("next"),

  err: defineSignal<{ critical: boolean }>("err"),

  // or do not accept
  reset: defineSignal("reset"),
};

// then we need to defina a state with props
const first = defineState<{ perm: boolean }>()
  // the name is important and will be used later
  .name("first")

  // all possible signals defined earlier
  .signals(signals)

  // and all possible variants of state
  // second argument means initial state variant
  .variant("zero", true)
  .variant("uno")
  .variant("duo")
  .variant("tre")

  // stringRepr is optional, it allows to represent state as a string
  .stringRepr((v) => (v.perm ? "allowed" : "forbidden"))

  // finally we nned to call .build()
  .build();
// it will create an object with variants of states

// Infer utility type basically extract props from state definition of state variant
type first = Infer<typeof first>;

// we can specify multiple states
// all of them will be changed at once
const second = defineState<{ counter: number; msg: string }>()
  .name("second")
  .signals(signals)
  .variant("initial", true)
  .variant("good")
  .variant("done")
  .stringRepr((v) => `c=${v.counter};m=${v.msg}`)
  .build();
type second = Infer<typeof second>;

// next we need to define a flow
// the first argument is a state variant
// and second is an object with signals handling this state variant
defineFlow(first.zero, {
  // signal handler should return new state
  reset() {
    return first.zero({ perm: false });
  },

  next(x, p) {
    if (p.allow) {
      return { perm: true };
    }
    // or it may ignore the signal
    return Result.ignore("nothing to do");
  },
});

defineFlow(second.initial, {
  reset() {
    return second.initial({ counter: 0, msg: "" });
  },
  next(x, p, ctx) {
    if (!first(ctx).perm) {
      // also signal handler may reject the signal
      // in that case none of state handlers will be executed
      return Result.reject("first state forbid that");
    }

    return second.good({ ...x, counter: p.incr ? x.counter + 1 : x.counter });
  },
  err(x, p, ctx) {
    if (p.critical) {
      return Result.reject("bad state");
    }

    // if state variant is not changed then it may return just new props
    return { ...x, msg: "bad state" };
  },
});

// flow can be defined only once
// it will trigger an error if we try to define it again
defineFlow(second.good, {
  reset() {
    return second.initial({ counter: 0, msg: "" });
  },
  next(x, p, ctx) {
    if (!first(ctx).perm) {
      return Result.reject("first state forbid that");
    }

    return second.done({ ...x, counter: p.incr ? x.counter + 1 : x.counter });
  },
  err(x, p, ctx) {
    if (p.critical) {
      return Result.reject("still bad state");
    }
    return { ...x, b: "still bad state" };
  },
});

defineFlow(second.done, {
  reset() {
    return second.initial({ counter: 0, msg: "" });
  },
});

//#endregion

//#region First Example

class Impl {
  first: first = { perm: false };

  second: second = { counter: 0, msg: "" };

  good: "true" | "false" | "recovered" = "false";

  constructor() {
    // next step is attaching the state flow to some object
    // it can be a class instance of even plain object
    // second argument is a list of state definitions. the order is important!
    // the last argument is a call bach for adding state handlers
    // that only place where we can add state handlers
    applyFlow(this, [first, second] as const, (sm) => {
      sm.addEnterHandler(second.good, this.makeGood, this);
      sm.addExitHandler(second.good, this.makeNotGood, this);
      sm.addEnterHandler(second.done, this.areWeDone, this);
      sm.addRollbackHandler(second.good, this.rollback, this);
    });
  }

  run() {
    console.log(" --- Run first example ---");
    // observe method is used to observe for changes
    // it can be used any time and returns disposable object
    // for stopping observing
    using _ = observe(
      this,
      [second.good, second.done],
      (s) => {
        console.log("{a} was really changed: ", String(s));
      },
      (prev, cur) => {
        return prev.counter !== cur.counter;
      },
    );

    // now we can start manipulating states
    // dispatch is the only way to alter state

    // Rejected: first state forbid that
    dispatch(this, signals.next({ allow: false, incr: true }));

    // Rejected: bad state
    dispatch(this, signals.err({ critical: true }));

    // false
    console.log(this.good);

    // OK
    dispatch(this, signals.next({ allow: true, incr: true }));

    // true
    console.log(this.good);

    // Rejected: still bad state
    dispatch(this, signals.err({ critical: true }));

    // OK but b=still bad state
    dispatch(this, signals.err({ critical: false }));

    // Rejected: we are not done yet! a=1
    dispatch(this, signals.next({ allow: false, incr: false }));

    // recovered
    console.log(this.good);

    // OK
    dispatch(this, signals.next({ allow: false, incr: true }));

    // Ignored: State second.done(a=2;b=still bad state) doesn't accept next signal; nothing to do
    dispatch(this, signals.next({ allow: false, incr: true }));

    // OK
    dispatch(this, signals.reset());
  }

  makeGood(state: second, ctx: unknown): Result {
    this.good = "true";
    return Result.ok();
  }

  areWeDone(state: second, ctx: unknown): Result {
    if (state.counter < 2) {
      return Result.reject(`we are not done yet! counter=${state.counter} < 2`);
    }
    return Result.ok();
  }

  makeNotGood(state: second, ctx: unknown): Result {
    this.good = "false";
    return Result.ok();
  }

  rollback(state: second, ctx: unknown): Result {
    this.good = "recovered";
    return Result.ok();
  }

  [Symbol.dispose]() {}
}
const i = new Impl();
i.run();

// doesn't trigger observer anymore
dispatch(i, signals.next({ allow: true, incr: true }));

//#endregion

//#region Second Example

const stateCtrl = {
  first: { perm: false },
  second: { counter: 0, msg: "" },
};

applyFlow(stateCtrl, [first, second], (sm) => {
  sm.addEnterHandler(second.good, doBackendRequest);
  sm.addEnterHandler(second.done, doBackendRequest);
});

function doBackendRequest(state: second, ctx: unknown): Result {
  // if state handler need some async action
  // then it may return `transition` result
  // in that case state will be changed only when it finishes
  // it has second argument - timeout, to limit time on execution
  return Result.transition(async () => {
    const resp = await fetch(`http://example.com/${state.msg}`, { method: "GET" });

    if (!resp.ok) {
      return Result.reject(resp.statusText);
    }
    return Result.ok();
  });
}

async function main() {
  console.log(" --- Run second example ---");

  // if some state handler returned `transition` result
  // then state flow cannot be used until it finishes

  // async OK
  dispatch(stateCtrl, signals.next({ allow: true, incr: true }));

  try {
    // so this won't work because of transition stat
    dispatch(stateCtrl, signals.next({ allow: true, incr: true }));
  } catch (_err) {
    // Error: States are in transitioning. Use `await sync(obj)` or await a previous result
  }

  // to make sure we don't get an error because of transition state
  // we can use `sync` method. it makes sure that state flow is ready
  // to accept new signals
  await sync(stateCtrl);
  // async Ok
  const result = dispatch(stateCtrl, signals.next({ allow: true, incr: true }));

  // alternatively, we can wait for prev result with using .done() method
  await result.done();

  // OK
  dispatch(stateCtrl, signals.next({ allow: true, incr: true }));
}

main().catch(() => {});
