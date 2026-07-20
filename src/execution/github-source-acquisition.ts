import type { AuthorizedPrincipal } from "@/application/authorization";
import type { RepositoryArchiveCredentialProvider } from "@/application/ports/repository-source";
import {
  immutableRepositorySourceSchema,
  sandboxCommandSchema,
  SANDBOX_WORKSPACE_ROOT,
  type ImmutableRepositorySource,
  type IsolatedSandboxSession,
  type SandboxCommandResult,
} from "@/execution/contracts";
import {
  createSourceProvenance,
  SOURCE_LIMITS,
  SourceValidationError,
  validateArchiveManifest,
  type ArchiveManifest,
  type SourceProvenance,
} from "@/execution/source-provenance";

const ACQUISITION_WORKSPACE = `${SANDBOX_WORKSPACE_ROOT}/acquisition`;
const SOURCE_WORKSPACE = `${SANDBOX_WORKSPACE_ROOT}/source`;
const ARCHIVE_NAME = "source.tar.gz";
const GITHUB_HOSTS = ["api.github.com", "codeload.github.com"] as const;

export type SourceAcquisitionCode =
  | "ARCHIVE_DOWNLOAD_FAILED"
  | "ARCHIVE_INSPECTION_FAILED"
  | "CREDENTIAL_UNAVAILABLE"
  | "EXTRACTION_FAILED"
  | "NETWORK_LOCKDOWN_FAILED"
  | "UNSAFE_ARCHIVE";

export class SourceAcquisitionError extends Error {
  constructor(readonly code: SourceAcquisitionCode) {
    super("The authorized repository source could not be acquired safely");
    this.name = "SourceAcquisitionError";
  }
}

type Dependencies = {
  clock?: { now(): Date };
  credentialProvider: RepositoryArchiveCredentialProvider;
};

type AcquireInput = {
  principal: AuthorizedPrincipal;
  session: IsolatedSandboxSession;
  source: ImmutableRepositorySource;
};

export type AcquiredRepositorySource = {
  manifest: ArchiveManifest;
  provenance: SourceProvenance;
  workspacePath: string;
};

function decode(result: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(result);
}

async function run(
  session: IsolatedSandboxSession,
  command: Parameters<IsolatedSandboxSession["run"]>[0],
): Promise<SandboxCommandResult> {
  return session.run(sandboxCommandSchema.parse(command));
}

function tarEntryType(mode: string) {
  switch (mode) {
    case "-":
      return "file" as const;
    case "d":
      return "directory" as const;
    case "l":
      return "symlink" as const;
    case "h":
      return "hardlink" as const;
    case "b":
    case "c":
      return "device" as const;
    case "p":
      return "fifo" as const;
    case "s":
      return "socket" as const;
    default:
      throw new SourceAcquisitionError("ARCHIVE_INSPECTION_FAILED");
  }
}

function parseTarListing(listing: string) {
  const lines = listing.endsWith("\n")
    ? listing.slice(0, -1).split("\n")
    : listing.split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new SourceAcquisitionError("ARCHIVE_INSPECTION_FAILED");
  }
  return lines.map((line) => {
    const match = /^([bcdhlps-])\S*\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+[+-]\d{4}\s+(.+)$/u.exec(
      line,
    );
    if (!match) {
      throw new SourceAcquisitionError("ARCHIVE_INSPECTION_FAILED");
    }
    const type = tarEntryType(match[1] ?? "");
    const rawPath = match[3] ?? "";
    return {
      path:
        type === "directory" && rawPath.endsWith("/")
          ? rawPath.slice(0, -1)
          : rawPath,
      size: Number(match[2]),
      type,
    };
  });
}

function archiveUrl(source: ImmutableRepositorySource) {
  const [owner, repository] = source.fullName.split("/") as [string, string];
  const path = `/repos/${owner}/${repository}/tarball/${source.commitSha}`;
  return { path, url: `https://api.github.com${path}` };
}

export class GitHubArchiveAcquirer {
  private readonly clock: { now(): Date };

  constructor(private readonly dependencies: Dependencies) {
    this.clock = dependencies.clock ?? { now: () => new Date() };
  }

  async acquire(rawInput: AcquireInput): Promise<AcquiredRepositorySource> {
    const source = immutableRepositorySourceSchema.parse(rawInput.source);
    const { principal, session } = rawInput;
    await session.makeDirectory(SANDBOX_WORKSPACE_ROOT);
    await session.makeDirectory(ACQUISITION_WORKSPACE);
    await session.makeDirectory(SOURCE_WORKSPACE);
    const githubArchive = archiveUrl(source);

    try {
      await this.dependencies.credentialProvider.withArchiveCredential(
        principal,
        {
          commitSha: source.commitSha,
          fullName: source.fullName,
          repositoryId: source.repositoryId,
        },
        async (credential) => {
          const expiresAt = Date.parse(credential.expiresAt);
          if (
            !Number.isFinite(expiresAt) ||
            expiresAt <= this.clock.now().getTime() + 30_000
          ) {
            throw new SourceAcquisitionError("CREDENTIAL_UNAVAILABLE");
          }
          let networkOpened = false;
          try {
            networkOpened = true;
            await session.setNetworkPolicy({
              allowedHosts: [...GITHUB_HOSTS],
              injection: {
                authorizationHeader: credential.authorizationHeader,
                host: "api.github.com",
                method: "GET",
                path: githubArchive.path,
              },
              kind: "brokered-allow-hosts",
              phase: "github-acquisition",
            });
            const downloaded = await run(session, {
              args: [
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--proto",
                "=https",
                "--max-filesize",
                String(SOURCE_LIMITS.maxArchiveBytes),
                "--output",
                ARCHIVE_NAME,
                githubArchive.url,
              ],
              cwd: ACQUISITION_WORKSPACE,
              executable: "curl",
              phase: "source-acquisition",
              timeoutMs: 120_000,
            });
            if (downloaded.exitCode !== 0) {
              throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
            }
          } finally {
            if (networkOpened) {
              try {
                await session.setNetworkPolicy({ kind: "deny-all" });
              } catch {
                throw new SourceAcquisitionError("NETWORK_LOCKDOWN_FAILED");
              }
            }
          }
        },
      );
    } catch (error) {
      if (error instanceof SourceAcquisitionError) throw error;
      throw new SourceAcquisitionError("CREDENTIAL_UNAVAILABLE");
    }

    const manifest = await this.inspectArchive(session);
    const extracted = await run(session, {
      args: [
        "--extract",
        "--gzip",
        "--file",
        ARCHIVE_NAME,
        "--directory",
        SOURCE_WORKSPACE,
        "--strip-components",
        "1",
        "--no-same-owner",
        "--no-same-permissions",
        "--delay-directory-restore",
      ],
      cwd: ACQUISITION_WORKSPACE,
      executable: "tar",
      phase: "source-acquisition",
      timeoutMs: 120_000,
    });
    if (extracted.exitCode !== 0) {
      throw new SourceAcquisitionError("EXTRACTION_FAILED");
    }
    return {
      manifest,
      provenance: createSourceProvenance({
        acquiredAt: this.clock.now().toISOString(),
        manifest,
        source,
      }),
      workspacePath: SOURCE_WORKSPACE,
    };
  }

  private async inspectArchive(
    session: IsolatedSandboxSession,
  ): Promise<ArchiveManifest> {
    try {
      const measured = await run(session, {
        args: [
          "-e",
          "const{statSync}=require('node:fs');process.stdout.write(String(statSync(process.argv[1]).size))",
          ARCHIVE_NAME,
        ],
        cwd: ACQUISITION_WORKSPACE,
        executable: "node",
        phase: "source-acquisition",
        timeoutMs: 10_000,
      });
      const hashed = await run(session, {
        args: [ARCHIVE_NAME],
        cwd: ACQUISITION_WORKSPACE,
        executable: "sha256sum",
        phase: "source-acquisition",
        timeoutMs: 120_000,
      });
      const listed = await run(session, {
        args: [
          "--list",
          "--verbose",
          "--gzip",
          "--numeric-owner",
          "--full-time",
          "--quoting-style=escape",
          "--file",
          ARCHIVE_NAME,
        ],
        cwd: ACQUISITION_WORKSPACE,
        executable: "tar",
        phase: "source-acquisition",
        timeoutMs: 120_000,
      });
      if (
        measured.exitCode !== 0 ||
        hashed.exitCode !== 0 ||
        listed.exitCode !== 0
      ) {
        throw new SourceAcquisitionError("ARCHIVE_INSPECTION_FAILED");
      }
      const archiveBytesText = decode(measured.stdout).trim();
      const archiveBytes = Number(archiveBytesText);
      if (!/^(?:0|[1-9][0-9]*)$/.test(archiveBytesText)) {
        throw new SourceAcquisitionError("ARCHIVE_INSPECTION_FAILED");
      }
      const hashMatch = /^([a-f0-9]{64})\s+source\.tar\.gz\s*$/u.exec(
        decode(hashed.stdout),
      );
      if (!hashMatch) {
        throw new SourceAcquisitionError("ARCHIVE_INSPECTION_FAILED");
      }
      try {
        return validateArchiveManifest({
          archiveBytes,
          archiveSha256: hashMatch[1],
          entries: parseTarListing(decode(listed.stdout)),
        });
      } catch (error) {
        if (error instanceof SourceValidationError) {
          throw new SourceAcquisitionError("UNSAFE_ARCHIVE");
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof SourceAcquisitionError) throw error;
      throw new SourceAcquisitionError("ARCHIVE_INSPECTION_FAILED");
    }
  }
}
