import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const child = spawn(
  process.execPath,
  [
    vitest,
    "run",
    "tests/providers/durable-providers.live.test.ts",
    "tests/providers/isolated-execution.live.test.ts",
  ],
  {
    env: {
      ...process.env,
      REPROFORGE_LIVE_PROVIDER_TESTS: "1",
    },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error("The live provider test process could not start safely.");
  console.error(error instanceof Error ? error.message : "Unknown process error");
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`The live provider test process ended with signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
