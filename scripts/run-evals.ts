import { resolve } from "node:path";

import { evaluateFixtureDirectory } from "@/evaluation/evaluate";

async function main() {
  const report = await evaluateFixtureDirectory(
    resolve(process.cwd(), "evals", "fixtures"),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown evaluation failure";
  process.stderr.write(`Evaluation failed: ${message}\n`);
  process.exitCode = 1;
});
