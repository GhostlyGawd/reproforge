import { describe, expect, it } from "vitest";

import type {
  IsolatedSandboxSession,
  NodeRepositoryProfile,
  SandboxCommand,
  SandboxCommandResult,
  SandboxNetworkPolicy,
} from "@/execution/contracts";
import {
  DependencyPreparationError,
  NodeDependencyPreparer,
  validateNodeDependencyMetadata,
} from "@/execution/dependency-preparation";
import type { ArchiveManifest } from "@/execution/source-provenance";

const profile: NodeRepositoryProfile = {
  controlScript: "test:control",
  ecosystem: "node",
  lockfile: "package-lock.json",
  nodeVersion: "24",
  packageManager: "npm",
  reproductionScript: "test:reproduce",
};
const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function metadata(overrides: {
  lock?: Record<string, unknown>;
  package?: Record<string, unknown>;
} = {}) {
  const packageJson = {
    dependencies: { "safe-package": "1.0.0" },
    name: "synthetic-reproduction",
    private: true,
    scripts: {
      "test:control": "node control.mjs",
      "test:reproduce": "node reproduce.mjs",
    },
    version: "1.0.0",
    ...overrides.package,
  };
  const lockJson = {
    lockfileVersion: 3,
    name: "synthetic-reproduction",
    packages: {
      "": {
        dependencies: { "safe-package": "1.0.0" },
        name: "synthetic-reproduction",
        version: "1.0.0",
      },
      "node_modules/safe-package": {
        integrity,
        resolved: "https://registry.npmjs.org/safe-package/-/safe-package-1.0.0.tgz",
        version: "1.0.0",
      },
    },
    requires: true,
    version: "1.0.0",
    ...overrides.lock,
  };
  return {
    lockBytes: new TextEncoder().encode(JSON.stringify(lockJson)),
    packageBytes: new TextEncoder().encode(JSON.stringify(packageJson)),
  };
}

const manifest: ArchiveManifest = {
  archiveBytes: 1_024,
  archiveSha256: "a".repeat(64),
  extractedBytes: 2_048,
  fileCount: 2,
  files: [
    { path: "package-lock.json", size: 1_024 },
    { path: "package.json", size: 1_024 },
  ],
  rootDirectory: "root",
};

describe("Node dependency preparation", () => {
  it("accepts a strict npm lock and returns only hashed metadata", () => {
    const input = metadata();
    const result = validateNodeDependencyMetadata({
      ...input,
      manifest,
      profile,
    });

    expect(result).toMatchObject({
      dependencyCount: 1,
      lockfileVersion: 3,
      policyVersion: "node-lock-v1",
    });
    expect(result.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.packageJsonSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("node control.mjs");
    expect(JSON.stringify(result)).not.toContain("safe-package-1.0.0.tgz");
  });

  it.each([
    [
      "undeclared reproduction script",
      metadata({ package: { scripts: { "test:control": "node control.mjs" } } }),
    ],
    [
      "URL dependency",
      metadata({
        package: {
          dependencies: { unsafe: "https://attacker.example/package.tgz" },
        },
      }),
    ],
    [
      "unapproved registry",
      metadata({
        lock: {
          packages: {
            "": {},
            "node_modules/unsafe": {
              integrity,
              resolved: "https://attacker.example/unsafe.tgz",
            },
          },
        },
      }),
    ],
    [
      "missing integrity",
      metadata({
        lock: {
          packages: {
            "": {},
            "node_modules/unsafe": {
              resolved: "https://registry.npmjs.org/unsafe/-/unsafe-1.0.0.tgz",
            },
          },
        },
      }),
    ],
  ])("rejects %s", (_label, input) => {
    expect(() =>
      validateNodeDependencyMetadata({
        ...input,
        manifest,
        profile,
      }),
    ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_SOURCE" }));
  });

  it("rejects repository-controlled package-manager configuration", () => {
    expect(() =>
      validateNodeDependencyMetadata({
        ...metadata(),
        manifest: {
          ...manifest,
          fileCount: 3,
          files: [...manifest.files, { path: ".npmrc", size: 20 }],
        },
        profile,
      }),
    ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_SOURCE" }));
  });

  it("supports a selected npm workspace without allowing filesystem links", () => {
    const workspaceProfile = { ...profile, workspace: "packages/cli" };
    const workspaceManifest: ArchiveManifest = {
      ...manifest,
      fileCount: 3,
      files: [
        ...manifest.files,
        { path: "packages/cli/package.json", size: 500 },
      ],
    };
    const input = metadata({
      lock: {
        packages: {
          "": {},
          "node_modules/synthetic-reproduction": {
            link: true,
            resolved: "packages/cli",
          },
          "node_modules/safe-package": {
            integrity,
            resolved:
              "https://registry.npmjs.org/safe-package/-/safe-package-1.0.0.tgz",
          },
          "packages/cli": {
            dependencies: { "safe-package": "1.0.0" },
          },
        },
      },
      package: {
        dependencies: { "safe-package": "workspace:*" },
      },
    });

    expect(
      validateNodeDependencyMetadata({
        ...input,
        manifest: workspaceManifest,
        profile: workspaceProfile,
      }),
    ).toMatchObject({ dependencyCount: 1, lockfileVersion: 3 });
  });

  it("populates cache with scripts disabled, locks egress, then installs offline", async () => {
    const fixture = harness();
    const prepared = await fixture.preparer.prepare({
      manifest,
      profile,
      session: fixture.session,
      sourceWorkspace: "/vercel/sandbox/workspaces/source",
    });

    expect(fixture.timeline).toEqual([
      "mkdir:/vercel/sandbox/workspaces/dependency-acquisition",
      "mkdir:/vercel/sandbox/npm-cache",
      "command:dependency-acquisition:cp",
      "policy:npm-acquisition",
      "command:dependency-acquisition:npm",
      "policy:deny-all",
      "command:offline-install:npm",
    ]);
    const npmCommands = fixture.commands.filter(
      (command) => command.executable === "npm",
    );
    expect(npmCommands).toHaveLength(2);
    expect(npmCommands[0]?.args).toEqual(
      expect.arrayContaining(["ci", "--ignore-scripts", "--cache"]),
    );
    expect(npmCommands[0]?.args).not.toContain("--offline");
    expect(npmCommands[1]?.args).toEqual(
      expect.arrayContaining(["ci", "--ignore-scripts", "--offline"]),
    );
    expect(fixture.policies).toEqual([
      {
        allowedHosts: ["registry.npmjs.org"],
        kind: "allow-hosts",
        phase: "npm-acquisition",
      },
      { kind: "deny-all" },
    ]);
    expect(prepared).toMatchObject({
      dependencyCount: 1,
      installWorkspace: "/vercel/sandbox/workspaces/source",
      networkPolicy: "deny-all",
    });
  });

  it("returns to deny-all and sanitizes provider output when cache population fails", async () => {
    const fixture = harness({ onlineFailure: true });
    let caught: unknown;
    try {
      await fixture.preparer.prepare({
        manifest,
        profile,
        session: fixture.session,
        sourceWorkspace: "/vercel/sandbox/workspaces/source",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DependencyPreparationError);
    expect(caught).toMatchObject({ code: "DEPENDENCY_ACQUISITION_FAILED" });
    expect(JSON.stringify(caught)).not.toContain("synthetic-provider-secret");
    expect(fixture.policies.at(-1)).toEqual({ kind: "deny-all" });
    expect(
      fixture.commands.some((command) => command.phase === "offline-install"),
    ).toBe(false);
  });
});

function harness(options: { onlineFailure?: boolean } = {}) {
  const files = metadata();
  const policies: SandboxNetworkPolicy[] = [];
  const commands: SandboxCommand[] = [];
  const timeline: string[] = [];
  const result = (
    exitCode = 0,
    stderr = "",
  ): SandboxCommandResult => ({
    durationMs: 10,
    exitCode,
    stderr: new TextEncoder().encode(stderr),
    stdout: new Uint8Array(),
  });
  const session: IsolatedSandboxSession = {
    makeDirectory: async (path) => {
      timeline.push(`mkdir:${path}`);
    },
    readFile: async (path) =>
      path.endsWith("package-lock.json") ? files.lockBytes : files.packageBytes,
    run: async (command) => {
      commands.push(command);
      timeline.push(`command:${command.phase}:${command.executable}`);
      if (
        options.onlineFailure &&
        command.executable === "npm" &&
        command.phase === "dependency-acquisition"
      ) {
        return result(1, "synthetic-provider-secret");
      }
      return result();
    },
    sandboxId: "sandbox_1",
    setNetworkPolicy: async (policy) => {
      policies.push(policy);
      timeline.push(
        `policy:${policy.kind === "deny-all" ? policy.kind : policy.phase}`,
      );
    },
    snapshot: async () => ({
      delete: async () => undefined,
      snapshotId: "snap_test",
    }),
    stop: async () => undefined,
    usage: async () => ({
      activeCpuMs: null,
      networkEgressBytes: null,
      networkIngressBytes: null,
    }),
    writeFiles: async () => undefined,
  };
  return {
    commands,
    policies,
    preparer: new NodeDependencyPreparer(),
    session,
    timeline,
  };
}
