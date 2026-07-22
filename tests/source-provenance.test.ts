import { describe, expect, it, vi } from "vitest";

import type { AuthorizedPrincipal } from "@/application/authorization";
import type { RepositorySourceProvider } from "@/application/ports/repository-source";
import {
  createSourceProvenance,
  resolveImmutableRepositorySource,
  SOURCE_LIMITS,
  SourceValidationError,
  validateArchiveManifest,
} from "@/execution/source-provenance";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ARCHIVE_SHA = "a".repeat(64);
const principal: AuthorizedPrincipal = {
  callerId: "oauth:issuer:subject",
  expiresAt: Date.parse("2026-07-21T00:00:00.000Z"),
  issuer: "https://auth.example.com/",
  principalId: "principal_1",
  scopes: ["reproforge:repositories:read"],
  subject: "auth0|subject_1",
  tenantId: "tenant_1",
};

describe("immutable source provenance", () => {
  it("rechecks and canonicalizes the exact authorized revision", async () => {
    const resolveRevision = vi.fn(async () => ({
      commitSha: SHA,
      defaultBranch: "main",
      fullName: "GhostlyGawd/reproforge",
      private: true,
      provider: "github" as const,
      repositoryId: "repo_opaque_1",
    }));
    const provider: RepositorySourceProvider = {
      listAuthorizedRepositories: vi.fn(),
      resolveRevision,
    };

    await expect(
      resolveImmutableRepositorySource(provider, principal, {
        commitSha: SHA,
        repositoryId: "repo_opaque_1",
      }),
    ).resolves.toEqual({
      commitSha: SHA,
      fullName: "GhostlyGawd/reproforge",
      private: true,
      provider: "github",
      repositoryId: "repo_opaque_1",
    });
    expect(resolveRevision).toHaveBeenCalledWith(principal, {
      commitSha: SHA,
      repositoryId: "repo_opaque_1",
    });
  });

  it("rejects a provider response that substitutes another revision", async () => {
    const provider: RepositorySourceProvider = {
      listAuthorizedRepositories: vi.fn(),
      resolveRevision: vi.fn(async () => ({
        commitSha: "f".repeat(40),
        defaultBranch: "main",
        fullName: "GhostlyGawd/reproforge",
        private: false,
        provider: "github" as const,
        repositoryId: "repo_opaque_1",
      })),
    };

    await expect(
      resolveImmutableRepositorySource(provider, principal, {
        commitSha: SHA,
        repositoryId: "repo_opaque_1",
      }),
    ).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
  });

  it("strips exactly one archive root and returns a sorted regular-file manifest", () => {
    expect(
      validateArchiveManifest({
        archiveBytes: 1_024,
        archiveSha256: ARCHIVE_SHA,
        entries: [
          {
            path: "GhostlyGawd-reproforge-0123456/src/index.ts",
            size: 12,
            type: "file",
          },
          {
            path: "GhostlyGawd-reproforge-0123456",
            size: 0,
            type: "directory",
          },
          {
            path: "GhostlyGawd-reproforge-0123456/package-lock.json",
            size: 20,
            type: "file",
          },
        ],
      }),
    ).toEqual({
      archiveBytes: 1_024,
      archiveSha256: ARCHIVE_SHA,
      extractedBytes: 32,
      fileCount: 2,
      files: [
        { path: "package-lock.json", size: 20 },
        { path: "src/index.ts", size: 12 },
      ],
      rootDirectory: "GhostlyGawd-reproforge-0123456",
    });
  });

  it.each([
    ["absolute path", "/etc/passwd", "PATH_ESCAPE"],
    ["drive path", "C:/Windows/system.ini", "PATH_ESCAPE"],
    ["backslash traversal", "root\\..\\escape", "PATH_ESCAPE"],
    ["dot traversal", "root/../escape", "PATH_ESCAPE"],
    ["mixed roots", "other/package.json", "MULTIPLE_ROOTS"],
  ])("rejects %s", (_label, maliciousPath, code) => {
    const entries = [
      { path: "root/package.json", size: 10, type: "file" as const },
      { path: maliciousPath, size: 1, type: "file" as const },
    ];
    expect(() =>
      validateArchiveManifest({
        archiveBytes: 100,
        archiveSha256: ARCHIVE_SHA,
        entries,
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it.each(["symlink", "hardlink", "device", "fifo", "socket"] as const)(
    "rejects %s archive entries",
    (type) => {
      expect(() =>
        validateArchiveManifest({
          archiveBytes: 100,
          archiveSha256: ARCHIVE_SHA,
          entries: [{ path: "root/item", size: 0, type }],
        }),
      ).toThrow(expect.objectContaining({ code: "UNSAFE_ENTRY_TYPE" }));
    },
  );

  it("enforces archive bytes, file count, and extracted bytes before execution", () => {
    expect(() =>
      validateArchiveManifest({
        archiveBytes: SOURCE_LIMITS.maxArchiveBytes + 1,
        archiveSha256: ARCHIVE_SHA,
        entries: [{ path: "root/file", size: 1, type: "file" }],
      }),
    ).toThrow(expect.objectContaining({ code: "ARCHIVE_LIMIT_EXCEEDED" }));
    expect(() =>
      validateArchiveManifest({
        archiveBytes: 100,
        archiveSha256: ARCHIVE_SHA,
        entries: [
          {
            path: "root/file",
            size: SOURCE_LIMITS.maxExtractedBytes + 1,
            type: "file",
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "EXTRACTED_LIMIT_EXCEEDED" }));
  });

  it("records stable sanitized provenance without acquisition credentials", () => {
    const manifest = validateArchiveManifest({
      archiveBytes: 1_024,
      archiveSha256: ARCHIVE_SHA,
      entries: [
        { path: "root/package.json", size: 12, type: "file" },
        { path: "root/package-lock.json", size: 20, type: "file" },
      ],
    });
    const provenance = createSourceProvenance({
      acquiredAt: "2026-07-20T00:00:00.000Z",
      manifest,
      source: {
        commitSha: SHA,
        fullName: "GhostlyGawd/reproforge",
        private: true,
        provider: "github",
        repositoryId: "repo_opaque_1",
      },
    });

    expect(provenance).toMatchObject({
      archiveBytes: 1_024,
      archiveSha256: ARCHIVE_SHA,
      commitSha: SHA,
      extractedBytes: 32,
      fileCount: 2,
      policyVersion: "source-archive-v1",
      provider: "github",
      repositoryId: "repo_opaque_1",
      schemaVersion: "1.0",
    });
    expect(provenance.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(provenance)).not.toContain("token");
    expect(JSON.stringify(provenance)).not.toContain("Authorization");
    expect(SourceValidationError).toBeTypeOf("function");
  });
});
