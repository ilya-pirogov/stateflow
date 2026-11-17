import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "es2020",
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".js" };
  },
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
