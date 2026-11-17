import { listStates } from "@state-flow/core";

/**
 * Every signal of the definitions `states` against every variant of its own definition: one row per variant and
 * signal, with whether the variant has a reducer for it, in listStates' order: definitions as named (one named twice
 * gives its rows twice, as listStates lists it twice), variants as the definition walks them, signals as its signal
 * object lists them.
 */
export function signalTable(states: Parameters<typeof listStates>[0]) {
  return listStates(states).flatMap((state) =>
    state.variants.flatMap((variant) =>
      state.signals.map((signal) => ({
        variant: `${state.name}.${variant.name}`,
        signal,
        reducer: variant.signals.includes(signal),
      })),
    ),
  );
}

/** `rows`, as signalTable gives them, as one Markdown table in their order, a reducer marked "yes" or "no". A "|" in a
 * name is escaped, as a Markdown table cell needs. */
export function signalTableMarkdown(rows: ReturnType<typeof signalTable>): string {
  const lines = rows.map(
    (row) =>
      `| ${row.variant.replaceAll("|", "\\|")} | ${row.signal.replaceAll("|", "\\|")} | ${row.reducer ? "yes" : "no"} |`,
  );
  return ["| variant | signal | reducer |", "| --- | --- | --- |", ...lines].join("\n");
}
