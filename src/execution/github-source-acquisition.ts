import type {
  RepositoryArchiveCredentialProvider,
  RepositoryPrincipal,
} from "@/application/ports/repository-source";
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
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_ARCHIVE_HOST = "codeload.github.com";
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;

export type SourceAcquisitionCode =
  | "ARCHIVE_DOWNLOAD_FAILED"
  | "ARCHIVE_LIMIT_EXCEEDED"
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
  fetcher?: typeof fetch;
};

type AcquireInput = {
  principal: RepositoryPrincipal;
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
  return `https://api.github.com/repos/${owner}/${repository}/tarball/${source.commitSha}`;
}

function archiveHeaders(authorizationHeader?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
    "User-Agent": "ReproForge/0.2",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

function archiveRedirect(response: Response): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
  }
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
  }
  if (
    target.protocol !== "https:" ||
    target.hostname !== GITHUB_ARCHIVE_HOST ||
    target.port ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
  }
  return target;
}

async function readBoundedArchive(response: Response): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const normalized = rawLength.trim();
    if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
      throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
    }
    if (Number(normalized) > SOURCE_LIMITS.maxArchiveBytes) {
      throw new SourceAcquisitionError("ARCHIVE_LIMIT_EXCEEDED");
    }
  }
  if (!response.body) {
    throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteCount += next.value.byteLength;
      if (byteCount > SOURCE_LIMITS.maxArchiveBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SourceAcquisitionError("ARCHIVE_LIMIT_EXCEEDED");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const archive = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

export async function downloadGitHubArchive(input: {
  authorizationHeader?: string;
  fetcher?: typeof fetch;
  source: ImmutableRepositorySource;
}): Promise<Uint8Array> {
  const source = immutableRepositorySourceSchema.parse(input.source);
  const githubArchiveUrl = archiveUrl(source);
  const fetcher = input.fetcher ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    ARCHIVE_DOWNLOAD_TIMEOUT_MS,
  );

  try {
    const redirect = await fetcher(githubArchiveUrl, {
      headers: archiveHeaders(input.authorizationHeader),
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    if (redirect.status !== 302) {
      throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
    }
    const target = archiveRedirect(redirect);
    await redirect.body?.cancel().catch(() => undefined);
    const archive = await fetcher(target, {
      headers: archiveHeaders(),
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!archive.ok) {
      throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
    }
    return await readBoundedArchive(archive);
  } catch (error) {
    if (error instanceof SourceAcquisitionError) throw error;
    throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

export class GitHubArchiveAcquirer {
  private readonly clock: { now(): Date };

  constructor(private readonly dependencies: Dependencies) {
    this.clock = dependencies.clock ?? { now: () => new Date() };
  }

  async acquire(rawInput: AcquireInput): Promise<AcquiredRepositorySource> {
    const source = immutableRepositorySourceSchema.parse(rawInput.source);
    const { principal, session } = rawInput;
    try {
      await session.setNetworkPolicy({ kind: "deny-all" });
    } catch {
      throw new SourceAcquisitionError("NETWORK_LOCKDOWN_FAILED");
    }
    await session.makeDirectory(SANDBOX_WORKSPACE_ROOT);
    await session.makeDirectory(ACQUISITION_WORKSPACE);
    await session.makeDirectory(SOURCE_WORKSPACE);
    let archiveBytes: Uint8Array;
    try {
      archiveBytes = source.private
        ? await this.dependencies.credentialProvider.withArchiveCredential(
            principal,
            {
              commitSha: source.commitSha,
              fullName: source.fullName,
              repositoryId: source.repositoryId,
            },
            (credential) => {
              const expiresAt = Date.parse(credential.expiresAt);
              if (
                !Number.isFinite(expiresAt) ||
                expiresAt <= this.clock.now().getTime() + 30_000
              ) {
                throw new SourceAcquisitionError("CREDENTIAL_UNAVAILABLE");
              }
              return downloadGitHubArchive({
                authorizationHeader: credential.authorizationHeader,
                fetcher: this.dependencies.fetcher,
                source,
              });
            },
          )
        : await downloadGitHubArchive({
            fetcher: this.dependencies.fetcher,
            source,
          });
    } catch (error) {
      if (error instanceof SourceAcquisitionError) throw error;
      throw new SourceAcquisitionError("CREDENTIAL_UNAVAILABLE");
    }

    try {
      await session.writeFiles([
        {
          content: archiveBytes,
          path: `${ACQUISITION_WORKSPACE}/${ARCHIVE_NAME}`,
        },
      ]);
    } catch {
      throw new SourceAcquisitionError("ARCHIVE_DOWNLOAD_FAILED");
    } finally {
      archiveBytes.fill(0);
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
