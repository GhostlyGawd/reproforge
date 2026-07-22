import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { repositoryBundleBytes } from "@/application/repository-durable-worker";
import { validateMaterializedBundle } from "@/domain/bundle";

import {
  PUBLIC_REPOSITORY_CANARY_COMMIT,
  PUBLIC_REPOSITORY_CANARY_SECRET,
  runPublicRepositoryCanary,
} from "./public-repository-canary";

async function main(): Promise<void> {
  const { proof, quarantine } = await runPublicRepositoryCanary();
  if (
    proof.summary.status !== "VERIFIED" ||
    proof.provenance.cleanupStatus !== "clean" ||
    proof.provenance.source.commitSha !== PUBLIC_REPOSITORY_CANARY_COMMIT ||
    quarantine.length !== 0 ||
    !proof.bundle ||
    !validateMaterializedBundle(proof.files).success
  ) {
    throw new Error("The public repository canary did not produce clean proof");
  }
  const bytes = repositoryBundleBytes(proof);
  if (new TextDecoder().decode(bytes).includes(PUBLIC_REPOSITORY_CANARY_SECRET)) {
    throw new Error("The public repository canary evidence was not sanitized");
  }
  const output = new URL(
    "../docs/evidence/milestone-8c/public-canary-bundle.json",
    import.meta.url,
  );
  await writeFile(output, bytes, { flag: "w" });
  console.log(
    JSON.stringify({
      bundleBytes: bytes.byteLength,
      bundleSha256: createHash("sha256").update(bytes).digest("hex"),
      cleanup: "clean",
      commitSha: PUBLIC_REPOSITORY_CANARY_COMMIT,
      result: "VERIFIED",
      runCount: proof.runs.length,
    }),
  );
}

void main();
