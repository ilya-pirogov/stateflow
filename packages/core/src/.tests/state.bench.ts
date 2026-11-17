import { bench, describe } from "vitest";

import { applyFlow, Box, defineFlow, defineSignal, defineState, lock } from "..";

// (a) small POD ------------------------------------------------------------
const small = defineState<{ count: number }>()
  .name("small")
  .signals({ inc: defineSignal("inc") })
  .variant("idle", true)
  .build();

// (b) large nested POD (exercises the sealProps deep-freeze cost) -----------
interface Big {
  meta: { a: number; b: string; nested: { x: number[]; y: Record<string, number> } };
  list: { id: number; name: string }[];
}
const big = defineState<Big>()
  .name("big")
  .signals({ noop: defineSignal("noop") })
  .variant("idle", true)
  .build();
const bigProps: Big = {
  meta: { a: 1, b: "x", nested: { x: [1, 2, 3, 4, 5], y: { p: 1, q: 2, r: 3 } } },
  list: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `n${i}` })),
};

// (c) realistic VDC-shaped state (driver / media-loader-like) ----------------
interface MediaLike {
  options: { polling: { intervalMs: number; enabled: boolean }; params: Record<string, string> };
  meta: { type: string; codecs: string[] };
  qualities: { name: string; id: number }[];
}
const media = defineState<MediaLike>()
  .name("media")
  .signals({ update: defineSignal("update") })
  .variant("idle", true)
  .build();
const mediaProps: MediaLike = {
  options: { polling: { intervalMs: 5000, enabled: true }, params: { a: "1", b: "2" } },
  meta: { type: "manifest", codecs: ["avc1.42e01f", "mp4a.40.2"] },
  qualities: Array.from({ length: 6 }, (_, i) => ({ name: `q${i}`, id: i })),
};

describe("state construction", () => {
  bench("small POD", () => {
    small.idle({ count: 1 });
  });
  bench("large nested POD", () => {
    big.idle(structuredClone(bigProps));
  });
  bench("realistic VDC-shaped", () => {
    media.idle(structuredClone(mediaProps));
  });
});

// (d) Box-wrapped construction — Box is skipped entirely by sealProps' freeze walk -----------
class Live {}
const boxed = defineState<{ handle: Box<Live> }>()
  .name("boxed")
  .signals({ noop: defineSignal("noopB") })
  .variant("idle", true)
  .build();

describe("state construction (boxed)", () => {
  bench("Box-wrapped construction", () => {
    boxed.idle({ handle: Box.of(new Live()) });
  });
});

// dispatch throughput (exercises the reducer-scope wrap) ---------------------
// NOTE: `player` must be registered via `applyFlow` before `lock()` will recognize it — a
// freshly-built StateInstance assigned to a plain object is NOT enough (lock() looks the
// target up in an internal WeakMap populated by applyFlow). Registering once, outside the
// timed callback, measures the steady-state round-trip cost rather than one-time setup.
const setVol = defineSignal<{ v: number }>("setVol");
const audio = defineState<{ volume: number }>().name("audio").signals({ setVol }).variant("playing", true).build();
defineFlow(audio.playing, { setVol: (_s, a) => audio.playing({ volume: a.v }) });
const player = { audio: audio.playing({ volume: 0 }) };
applyFlow(player, [audio], () => {});

describe("dispatch", () => {
  bench("lock+send round-trip", async () => {
    await using send = await lock(player);
    await send(setVol({ v: 1 })).done();
  });
});
