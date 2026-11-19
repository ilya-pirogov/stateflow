import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // ES2020, as 1.2 shipped: an application whose build does not transpile its dependencies ships this bundle as it is,
  // and browsers without native private class members and static blocks cannot parse an ES2022 one.
  target: "es2020",
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".js" };
  },
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
