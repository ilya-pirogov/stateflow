import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The gate runs tests before the build, so dist may not exist; and the spec imports packages/core/examples,
      // which imports the engine's source: both paths must resolve to one module.
      "@state-flow/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
