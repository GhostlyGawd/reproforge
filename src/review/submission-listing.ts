import { z } from "zod";

const productionOrigin = "https://reproforge.vercel.app";

const productionUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).origin === productionOrigin, {
    message: "listing URL must use the reviewed ReproForge production origin",
  });

const relativeAssetSchema = z
  .string()
  .regex(/^assets\/[a-z0-9][a-z0-9.-]*\.(?:png|svg)$/);

const screenshotSchema = z
  .object({
    alt: z.string().min(40).max(500),
    caption: z.string().min(20).max(500),
    file: relativeAssetSchema.refine((value) => value.endsWith(".png")),
    height: z.number().int().positive().max(10_000),
    provenance: z.string().min(20).max(500),
    route: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    width: z.number().int().positive().max(10_000),
  })
  .strict();

export const submissionListingSchema = z
  .object({
    availability: z
      .object({
        countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250),
        status: z.enum(["not_selected", "selected"]),
      })
      .strict(),
    category: z
      .object({
        proposed: z.literal("Developer tools"),
        status: z.literal("confirm_in_portal"),
      })
      .strict(),
    developerIdentity: z
      .object({
        publisher: z.null(),
        status: z.literal("pending_platform_verification"),
      })
      .strict(),
    listingSource: z.literal("https://learn.chatgpt.com/docs/submit-plugins"),
    logo: z
      .object({
        alt: z.string().min(20).max(200),
        height: z.literal(512),
        png: relativeAssetSchema.refine((value) => value.endsWith(".png")),
        pngSha256: z.string().regex(/^[a-f0-9]{64}$/),
        rights: z.string().min(20).max(300),
        source: z.literal("original_repository_artwork"),
        svg: relativeAssetSchema.refine((value) => value.endsWith(".svg")),
        width: z.literal(512),
      })
      .strict(),
    longDescription: z.string().min(120).max(1_500),
    name: z.literal("ReproForge"),
    portalStatus: z.literal("draft_not_submitted"),
    releaseNotes: z.string().min(80).max(1_000),
    schemaVersion: z.literal("1.0"),
    screenshots: z.array(screenshotSchema).min(2).max(6),
    shortDescription: z.string().min(20).max(80),
    starterPrompts: z.array(z.string().min(30).max(300)).min(3).max(6),
    urls: z
      .object({
        mcp: productionUrlSchema.refine((value) => new URL(value).pathname === "/mcp"),
        privacy: productionUrlSchema.refine(
          (value) => new URL(value).pathname === "/privacy",
        ),
        support: productionUrlSchema.refine(
          (value) => new URL(value).pathname === "/support",
        ),
        terms: productionUrlSchema.refine(
          (value) => new URL(value).pathname === "/terms",
        ),
        website: productionUrlSchema.refine(
          (value) => new URL(value).pathname === "/",
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((listing, context) => {
    if (new Set(listing.starterPrompts).size !== listing.starterPrompts.length) {
      context.addIssue({ code: "custom", message: "starter prompts must be unique" });
    }
    if (
      listing.availability.status === "not_selected" &&
      listing.availability.countries.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "an unselected availability draft cannot list countries",
      });
    }
    if (
      listing.availability.status === "selected" &&
      listing.availability.countries.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "selected availability requires at least one country",
      });
    }
  });

export type SubmissionListing = z.infer<typeof submissionListingSchema>;

export function parseSubmissionListing(input: unknown): SubmissionListing {
  return submissionListingSchema.parse(input);
}
