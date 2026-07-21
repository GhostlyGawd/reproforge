import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseReviewCasePack } from "@/review/case-pack";

async function main() {
  const file = resolve(
    process.cwd(),
    "docs",
    "submission",
    "review-cases.json",
  );
  const pack = parseReviewCasePack(JSON.parse(await readFile(file, "utf8")));
  const positive = pack.cases.filter(({ polarity }) => polarity === "positive");
  const negative = pack.cases.filter(({ polarity }) => polarity === "negative");
  const pendingHosted = pack.cases.filter(
    ({ passEvidence }) => passEvidence.status === "pending_hosted",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        cases: pack.cases.map(({ id, passEvidence, polarity, protocolProbe }) => ({
          evidenceStatus: passEvidence.status,
          id,
          polarity,
          protocolProbe: protocolProbe !== undefined,
        })),
        negative: negative.length,
        pendingHosted: pendingHosted.length,
        positive: positive.length,
        schemaVersion: pack.schemaVersion,
        total: pack.cases.length,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown verification failure";
  process.stderr.write(`Review case verification failed: ${message}\n`);
  process.exitCode = 1;
});
