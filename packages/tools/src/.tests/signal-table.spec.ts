import { defineFlow, defineSignal, defineState, type Items, StateResult } from "@state-flow/core";
import { expect, it } from "vitest";
import { signalTable, signalTableMarkdown } from "..";

// A board loads through a declared transition into ready and holds tasks, a collection of nested states.
const taskSignals = { finish: defineSignal<{ key: string }>("finish") };
const task = defineState<{ title: string }>()
  .name("task")
  .signals(taskSignals)
  .variant("running", { initial: true })
  .variant("done")
  .build();
defineFlow(task.running, { finish: (t, { key }, ctx) => (ctx.key === key ? task.done(t) : StateResult.ignored()) });
const boardSignals = {
  load: defineSignal("load"),
  cancel: defineSignal("cancel"),
  add: defineSignal<{ key: string }>("add"),
};
const board = defineState<{ tasks: Items<typeof task> }>()
  .name("board")
  .signals(boardSignals)
  .variant("idle", { initial: true })
  .variant("loading", { transitional: true })
  .variant("ready", { async: true })
  .build();
defineFlow(board.idle, { load: (s) => StateResult.transition(board.ready(s), board.loading(s), board.idle(s)) });
defineFlow(board.loading, { cancel: (s) => board.idle(s) });
defineFlow(board.ready, {
  add: (s, { key }) => board.ready({ ...s, tasks: s.tasks.with(key, task.running({ title: key })) }),
});

it("tables every signal against every variant of its definition, as data and as Markdown", () => {
  const rows = signalTable([board, task]);
  expect(rows.map((row) => `${row.variant} ${row.signal} ${row.reducer}`)).toEqual([
    "board.idle load true",
    "board.idle cancel false",
    "board.idle add false",
    "board.loading load false",
    "board.loading cancel true",
    "board.loading add false",
    "board.ready load false",
    "board.ready cancel false",
    "board.ready add true",
    "task.running finish true",
    "task.done finish false",
  ]);
  const markdown = [
    "| variant | signal | reducer |",
    "| --- | --- | --- |",
    "| board.idle | load | yes |",
    "| a\\|b | c\\|d | no |",
  ];
  const piped = { variant: "a|b", signal: "c|d", reducer: false };
  expect(signalTableMarkdown([rows[0], piped])).toBe(markdown.join("\n"));
});
