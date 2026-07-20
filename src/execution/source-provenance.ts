import { createHash } from "node:crypto";

import { z } from "zod";

import type { AuthorizedPrincipal } from "@/application/authorization";
import type { RepositorySourceProvider } from "@/application/ports/repository-source";
import {
  immutableRepositorySourceSchema,
  type ImmutableRepositorySource,
} from "@/execution/contracts";

export const SOURCE_LIMITS = Object.freeze({
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 25_000,
  maxExtractedBytes: 500 * 1024 * 1024,
});

export type SourceValidationCode =
  | "ARCHIVE_LIMIT_EXCEEDED"
  | "DUPLICATE_PATH"
  | "EMPTY_ARCHIVE"
  | "EXTRACTED_LIMIT_EXCEEDED"
  | "INVALID_MANIFEST"
  | "INVALID_ROOT"
  | "MULTIPLE_ROOTS"
  | "PATH_ESCAPE"
  | "REVISION_MISMATCH"
  | "UNSAFE_ENTRY_TYPE";

export class SourceValidationError extends Error {
  constructor(readonly code: SourceValidationCode) {
    super("The immutable source archive did not satisfy execution policy");
    this.name = "SourceValidationError";
  }
}

const archiveEntrySchema = z
  .object({
    path: z.string().min(1).max(4_096),
    size: z.number().int().nonnegative().safe(),
    type: z.enum([
      "file",
      "directory",
      "symlink",
      "hardlink",
      "device",
      "fifo",
      "socket",
    ]),
  })
  .strict();

const archiveInputSchema = z
  .object({
    archiveBytes: z.number().int().nonnegative().safe(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(archiveEntrySchema),
  })
  .strict();

export type ArchiveManifest = {
  archiveBytes: number;
  archiveSha256: string;
  extractedBytes: number;
  fileCount: number;
  files: Array<{ path: string; size: number }>;
  rootDirectory: string;
};

function isSafeArchivePath(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

export function validateArchiveManifest(raw: unknown): ArchiveManifest {
  const parsed = archiveInputSchema.safeParse(raw);
  if (!parsed.success) throw new SourceValidationError("INVALID_MANIFEST");
  const input = parsed.data;
  if (
    input.archiveBytes > SOURCE_LIMITS.maxArchiveBytes ||
    input.entries.length > SOURCE_LIMITS.maxEntries
  ) {
    throw new SourceValidationError("ARCHIVE_LIMIT_EXCEEDED");
  }

  let rootDirectory: string | undefined;
  let extractedBytes = 0;
  const files: Array<{ path: string; size: number }> = [];
  const seen = new Set<string>();

  for (const entry of input.entries) {
    const normalizedPath = entry.path.normalize("NFC");
    if (!isSafeArchivePath(normalizedPath)) {
      throw new SourceValidationError("PATH_ESCAPE");
    }
    const [root, ...relativeSegments] = normalizedPath.split("/");
    if (!root || root === "." || root === "..") {
      throw new SourceValidationError("INVALID_ROOT");
    }
    if (rootDirectory === undefined) rootDirectory = root;
    if (root !== rootDirectory) {
      throw new SourceValidationError("MULTIPLE_ROOTS");
    }
    if (relativeSegments.length === 0) {
      if (entry.type !== "directory") {
        throw new SourceValidationError("INVALID_ROOT");
      }
      continue;
    }
    if (entry.type !== "file" && entry.type !== "directory") {
      throw new SourceValidationError("UNSAFE_ENTRY_TYPE");
    }

    const relativePath = relativeSegments.join("/");
    if (seen.has(relativePath)) {
      throw new SourceValidationError("DUPLICATE_PATH");
    }
    seen.add(relativePath);
    if (entry.type === "directory") continue;

    extractedBytes += entry.size;
    if (
      !Number.isSafeInteger(extractedBytes) ||
      extractedBytes > SOURCE_LIMITS.maxExtractedBytes
    ) {
      throw new SourceValidationError("EXTRACTED_LIMIT_EXCEEDED");
    }
    files.push({ path: relativePath, size: entry.size });
  }

  if (!rootDirectory || files.length === 0) {
    throw new SourceValidationError("EMPTY_ARCHIVE");
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    archiveBytes: input.archiveBytes,
    archiveSha256: input.archiveSha256,
    extractedBytes,
    fileCount: files.length,
    files,
    rootDirectory,
  };
}

const sourceRequestSchema = z
  .object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export async function resolveImmutableRepositorySource(
  provider: RepositorySourceProvider,
  principal: AuthorizedPrincipal,
  rawInput: { commitSha: string; repositoryId: string },
): Promise<ImmutableRepositorySource> {
  const input = sourceRequestSchema.parse(rawInput);
  const resolved = await provider.resolveRevision(principal, input);
  if (
    resolved.commitSha !== input.commitSha ||
    resolved.repositoryId !== input.repositoryId
  ) {
    throw new SourceValidationError("REVISION_MISMATCH");
  }
  return immutableRepositorySourceSchema.parse({
    commitSha: resolved.commitSha,
    fullName: resolved.fullName,
    private: resolved.private,
    provider: resolved.provider,
    repositoryId: resolved.repositoryId,
  });
}

const sourceProvenanceSchema = z
  .object({
    acquiredAt: z.string().datetime({ offset: true }),
    archiveBytes: z.number().int().nonnegative().safe(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    extractedBytes: z.number().int().nonnegative().safe(),
    fileCount: z.number().int().positive().max(SOURCE_LIMITS.maxEntries),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: z.literal("source-archive-v1"),
    provider: z.literal("github"),
    repositoryId: z.string().min(1).max(128),
    schemaVersion: z.literal("1.0"),
  })
  .strict();

export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;

function canonicalManifestJson(manifest: ArchiveManifest): string {
  return JSON.stringify({
    archiveBytes: manifest.archiveBytes,
    archiveSha256: manifest.archiveSha256,
    extractedBytes: manifest.extractedBytes,
    fileCount: manifest.fileCount,
    files: [...manifest.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    rootDirectory: manifest.rootDirectory,
  });
}

export function createSourceProvenance(input: {
  acquiredAt: string;
  manifest: ArchiveManifest;
  source: ImmutableRepositorySource;
}): SourceProvenance {
  const source = immutableRepositorySourceSchema.parse(input.source);
  return sourceProvenanceSchema.parse({
    acquiredAt: input.acquiredAt,
    archiveBytes: input.manifest.archiveBytes,
    archiveSha256: input.manifest.archiveSha256,
    commitSha: source.commitSha,
    extractedBytes: input.manifest.extractedBytes,
    fileCount: input.manifest.fileCount,
    manifestSha256: createHash("sha256")
      .update(canonicalManifestJson(input.manifest))
      .digest("hex"),
    policyVersion: "source-archive-v1",
    provider: source.provider,
    repositoryId: source.repositoryId,
    schemaVersion: "1.0",
  });
}
