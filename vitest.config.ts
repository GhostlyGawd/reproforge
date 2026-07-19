import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    // PGlite boots a real Postgres-WASM runtime. Serial files prevent its
    // initialization from starving subprocess- and timer-sensitive suites.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
  },
});
