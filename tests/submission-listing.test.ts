import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseSubmissionListing } from "@/review/submission-listing";

const submissionDirectory = resolve(process.cwd(), "docs", "submission");

async function loadListingInput(): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve(submissionDirectory, "listing.json"), "utf8"),
  );
}

describe("submission listing draft", () => {
  it("is a complete but explicitly unsubmitted production-origin draft", async () => {
    const listing = parseSubmissionListing(await loadListingInput());

    expect(listing.name).toBe("ReproForge");
    expect(listing.portalStatus).toBe("draft_not_submitted");
    expect(listing.developerIdentity.status).toBe("pending_platform_verification");
    expect(listing.availability).toEqual({ countries: [], status: "not_selected" });
    expect(listing.urls).toEqual({
      mcp: "https://reproforge.vercel.app/mcp",
      privacy: "https://reproforge.vercel.app/privacy",
      support: "https://reproforge.vercel.app/support",
      terms: "https://reproforge.vercel.app/terms",
      website: "https://reproforge.vercel.app/",
    });
  });

  it("uses concise, truthful copy and four adaptable starter prompts", async () => {
    const listing = parseSubmissionListing(await loadListingInput());

    expect(listing.shortDescription.length).toBeLessThanOrEqual(80);
    expect(listing.longDescription).toContain("machine evidence");
    expect(listing.longDescription).toContain("authorized GitHub repository");
    expect(listing.longDescription).toContain("No OpenAI API key");
    expect(listing.starterPrompts).toHaveLength(4);
    expect(new Set(listing.starterPrompts)).toHaveLength(4);
    for (const prompt of listing.starterPrompts) {
      expect(prompt.length).toBeGreaterThanOrEqual(30);
      expect(prompt).not.toMatch(/token|credential|shell command|arbitrary repository/i);
    }
  });

  it("ships original, self-contained logo assets and checksummed screenshot candidates", async () => {
    const listing = parseSubmissionListing(await loadListingInput());
    const logoSvg = await readFile(resolve(submissionDirectory, listing.logo.svg), "utf8");
    const logoPng = await readFile(resolve(submissionDirectory, listing.logo.png));

    expect(logoSvg).toContain('viewBox="0 0 512 512"');
    expect(logoSvg).not.toMatch(/(?:href|src)=["']https?:|<image|<text|lucide/i);
    expect(logoPng.readUInt32BE(16)).toBe(512);
    expect(logoPng.readUInt32BE(20)).toBe(512);
    expect(createHash("sha256").update(logoPng).digest("hex")).toBe(
      listing.logo.pngSha256,
    );

    for (const screenshot of listing.screenshots) {
      const bytes = await readFile(resolve(submissionDirectory, screenshot.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(screenshot.sha256);
      expect(screenshot.alt.length).toBeGreaterThan(40);
      expect(screenshot.caption.length).toBeGreaterThan(20);
      expect(screenshot.provenance).toContain("production");
    }
  });

  it("rejects every non-HTTPS or off-origin public URL mutation", async () => {
    const input = (await loadListingInput()) as {
      urls: Record<string, string>;
    };
    const keys = Object.keys(input.urls);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...keys),
        fc.constantFrom("http://reproforge.vercel.app/", "https://example.invalid/"),
        async (key, value) => {
          const mutated = structuredClone(input);
          mutated.urls[key] = value;
          expect(() => parseSubmissionListing(mutated)).toThrow();
        },
      ),
      { numRuns: 40 },
    );
  });
});
