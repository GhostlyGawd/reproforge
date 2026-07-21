import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseReviewCasePack } from "@/review/case-pack";
import { parseSubmissionListing } from "@/review/submission-listing";

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main() {
  const directory = resolve(process.cwd(), "docs", "submission");
  const listing = parseSubmissionListing(
    JSON.parse(await readFile(resolve(directory, "listing.json"), "utf8")),
  );
  const cases = parseReviewCasePack(
    JSON.parse(await readFile(resolve(directory, "review-cases.json"), "utf8")),
  );

  const logoDigest = await sha256(resolve(directory, listing.logo.png));
  if (logoDigest !== listing.logo.pngSha256) {
    throw new Error("listing logo digest does not match listing.json");
  }
  for (const screenshot of listing.screenshots) {
    if ((await sha256(resolve(directory, screenshot.file))) !== screenshot.sha256) {
      throw new Error(`listing screenshot digest does not match: ${screenshot.file}`);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        assetsVerified: listing.screenshots.length + 1,
        availabilityStatus: listing.availability.status,
        developerIdentityStatus: listing.developerIdentity.status,
        negativeCases: cases.cases.filter(({ polarity }) => polarity === "negative").length,
        portalStatus: listing.portalStatus,
        positiveCases: cases.cases.filter(({ polarity }) => polarity === "positive").length,
        productionOrigin: new URL(listing.urls.website).origin,
        starterPrompts: listing.starterPrompts.length,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown verification failure";
  process.stderr.write(`Submission draft verification failed: ${message}\n`);
  process.exitCode = 1;
});
