import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/.tests/*.spec.ts"],
    exclude: ["lib-cjs/**", "lib-esm/**", "types/**"],
    environment: "node",
  },
  benchmark: {
    include: ["src/**/.tests/*.bench.ts"],
  },
});
