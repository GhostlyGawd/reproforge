import { describe, expect, it, vi } from "vitest";

import type { AuthorizedPrincipal } from "@/application/authorization";
import type {
  EphemeralRepositoryArchiveCredential,
  RepositoryArchiveCredentialProvider,
} from "@/application/ports/repository-source";
import type {
  ImmutableRepositorySource,
  IsolatedSandboxSession,
  SandboxCommand,
  SandboxCommandResult,
  SandboxFile,
  SandboxNetworkPolicy,
} from "@/execution/contracts";
import {
  GitHubArchiveAcquirer,
  SourceAcquisitionError,
} from "@/execution/github-source-acquisition";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ARCHIVE_SHA = "a".repeat(64);
const SECRET = "ghs_synthetic-acquisition-secret";
const principal: AuthorizedPrincipal = {
  callerId: "principal_1",
  expiresAt: Date.parse("2026-07-21T00:00:00.000Z"),
  issuer: "https://auth.example.com/",
  principalId: "principal_1",
  scopes: ["reproforge:repositories:read"],
  subject: "auth0|subject_1",
  tenantId: "tenant_1",
};
const source: ImmutableRepositorySource = {
  commitSha: SHA,
  fullName: "GhostlyGawd/reproforge",
  private: true,
  provider: "github",
  repositoryId: "repo_opaque_1",
};

const encode = (value: string) => new TextEncoder().encode(value);

function commandResult(
  stdout = "",
  stderr = "",
  exitCode = 0,
): SandboxCommandResult {
  return {
    durationMs: 5,
    exitCode,
    stderr: encode(stderr),
    stdout: encode(stdout),
  };
}

function harness(options: { curlFailure?: boolean } = {}) {
  const policies: SandboxNetworkPolicy[] = [];
  const commands: SandboxCommand[] = [];
  const directories: string[] = [];
  const files: SandboxFile[] = [];
  const tarListing = [
    "drwxr-xr-x 0/0 0 2026-07-20 00:00:00.000000000 +0000 GhostlyGawd-reproforge-0123456/",
    "-rw-r--r-- 0/0 12 2026-07-20 00:00:00.000000000 +0000 GhostlyGawd-reproforge-0123456/package.json",
    "-rw-r--r-- 0/0 20 2026-07-20 00:00:00.000000000 +0000 GhostlyGawd-reproforge-0123456/package-lock.json",
  ].join("\n");
  const session: IsolatedSandboxSession = {
    makeDirectory: async (path) => {
      directories.push(path);
    },
    readFile: vi.fn(),
    run: async (command) => {
      commands.push(command);
      if (command.executable === "curl") {
        return options.curlFailure
          ? commandResult("", `provider failed ${SECRET}`, 22)
          : commandResult();
      }
      if (command.executable === "node") return commandResult("1024\n");
      if (command.executable === "sha256sum") {
        return commandResult(`${ARCHIVE_SHA}  source.tar.gz\n`);
      }
      if (command.executable === "tar" && command.args.includes("--list")) {
        return commandResult(`${tarListing}\n`);
      }
      if (command.executable === "tar" && command.args.includes("--extract")) {
        return commandResult();
      }
      throw new Error("unexpected command");
    },
    sandboxId: "sandbox_opaque_1",
    setNetworkPolicy: async (policy) => {
      policies.push(policy);
    },
    snapshot: async () => ({
      delete: async () => undefined,
      snapshotId: "snap_test",
    }),
    stop: vi.fn(),
    usage: async () => ({
      activeCpuMs: null,
      networkEgressBytes: null,
      networkIngressBytes: null,
    }),
    writeFiles: async (input) => {
      files.push(...input);
    },
  };
  const leaseCalls: unknown[] = [];
  const credentialProvider: RepositoryArchiveCredentialProvider = {
    async withArchiveCredential<Result>(
      _principal: AuthorizedPrincipal,
      input: { commitSha: string; fullName: string; repositoryId: string },
      consume: (
        credential: EphemeralRepositoryArchiveCredential,
      ) => Promise<Result>,
    ) {
      leaseCalls.push(input);
      let credential: EphemeralRepositoryArchiveCredential = {
        authorizationHeader: `Bearer ${SECRET}`,
        expiresAt: "2026-07-20T00:59:00.000Z",
      };
      try {
        return await consume(credential);
      } finally {
        credential = { authorizationHeader: "", expiresAt: "" };
        void credential;
      }
    },
  };
  const acquirer = new GitHubArchiveAcquirer({
    clock: { now: () => new Date("2026-07-20T00:00:00.000Z") },
    credentialProvider,
  });
  return {
    acquirer,
    commands,
    directories,
    files,
    leaseCalls,
    policies,
    session,
  };
}

describe("GitHub archive acquisition", () => {
  it("brokers a JIT token outside the VM and returns to deny-all before extraction", async () => {
    const fixture = harness();
    const acquired = await fixture.acquirer.acquire({
      principal,
      session: fixture.session,
      source,
    });

    expect(fixture.leaseCalls).toEqual([
      {
        commitSha: SHA,
        fullName: source.fullName,
        repositoryId: source.repositoryId,
      },
    ]);
    expect(fixture.policies).toEqual([
      {
        allowedHosts: ["api.github.com", "codeload.github.com"],
        injection: {
          authorizationHeader: `Bearer ${SECRET}`,
          host: "api.github.com",
          method: "GET",
          path: `/repos/GhostlyGawd/reproforge/tarball/${SHA}`,
        },
        kind: "brokered-allow-hosts",
        phase: "github-acquisition",
      },
      { kind: "deny-all" },
    ]);
    const extractIndex = fixture.commands.findIndex((command) =>
      command.args.includes("--extract"),
    );
    expect(extractIndex).toBeGreaterThan(0);
    expect(fixture.policies.at(-1)).toEqual({ kind: "deny-all" });
    expect(acquired).toMatchObject({
      provenance: {
        archiveBytes: 1024,
        archiveSha256: ARCHIVE_SHA,
        commitSha: SHA,
        extractedBytes: 32,
        fileCount: 2,
      },
      workspacePath: "/vercel/sandbox/workspaces/source",
    });
    expect(JSON.stringify(acquired)).not.toContain(SECRET);
    expect(JSON.stringify(fixture.commands)).not.toContain(SECRET);
    expect(JSON.stringify(fixture.files)).not.toContain(SECRET);
    expect(fixture.commands[0]).toMatchObject({
      args: expect.arrayContaining([
        `https://api.github.com/repos/GhostlyGawd/reproforge/tarball/${SHA}`,
      ]),
      executable: "curl",
      phase: "source-acquisition",
    });
  });

  it("closes egress and returns only a stable sanitized error when acquisition fails", async () => {
    const fixture = harness({ curlFailure: true });

    let caught: unknown;
    try {
      await fixture.acquirer.acquire({
        principal,
        session: fixture.session,
        source,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SourceAcquisitionError);
    expect(caught).toMatchObject({ code: "ARCHIVE_DOWNLOAD_FAILED" });
    expect(JSON.stringify(caught)).not.toContain(SECRET);
    expect(fixture.policies.at(-1)).toEqual({ kind: "deny-all" });
    expect(fixture.commands).toHaveLength(1);
  });

  it("rejects an unsafe manifest before the extraction command", async () => {
    const fixture = harness();
    fixture.session.run = async (command) => {
      fixture.commands.push(command);
      if (command.executable === "curl") return commandResult();
      if (command.executable === "node") return commandResult("1024\n");
      if (command.executable === "sha256sum") {
        return commandResult(`${ARCHIVE_SHA}  source.tar.gz\n`);
      }
      if (command.executable === "tar" && command.args.includes("--list")) {
        return commandResult(
          "lrwxrwxrwx 0/0 0 2026-07-20 00:00:00.000000000 +0000 root/escape -> ../../etc/passwd\n",
        );
      }
      throw new Error("extraction must not run");
    };

    await expect(
      fixture.acquirer.acquire({
        principal,
        session: fixture.session,
        source,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(
      fixture.commands.some((command) => command.args.includes("--extract")),
    ).toBe(false);
  });
});
