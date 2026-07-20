import { createHash } from "node:crypto";

import { z } from "zod";

import {
  nodeRepositoryProfileSchema,
  sandboxCommandSchema,
  SANDBOX_ROOT,
  SANDBOX_WORKSPACE_ROOT,
  type IsolatedSandboxSession,
  type NodeRepositoryProfile,
} from "@/execution/contracts";
import type { ArchiveManifest } from "@/execution/source-provenance";

const DEPENDENCY_WORKSPACE = `${SANDBOX_WORKSPACE_ROOT}/dependency-acquisition`;
const CACHE_PATH = `${SANDBOX_ROOT}/npm-cache`;
const PACKAGE_JSON_LIMIT = 1024 * 1024;
const LOCKFILE_LIMIT = 20 * 1024 * 1024;
const DEPENDENCY_LIMIT = 10_000;
const DISALLOWED_CONFIG_NAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
]);

export type DependencyPreparationCode =
  | "DEPENDENCY_ACQUISITION_FAILED"
  | "NETWORK_LOCKDOWN_FAILED"
  | "OFFLINE_INSTALL_FAILED"
  | "UNSUPPORTED_SOURCE";

export class DependencyPreparationError extends Error {
  constructor(readonly code: DependencyPreparationCode) {
    super("Repository dependencies did not satisfy the isolated execution policy");
    this.name = "DependencyPreparationError";
  }
}

export const dependencyMetadataSchema = z
  .object({
    dependencyCount: z.number().int().nonnegative().max(DEPENDENCY_LIMIT),
    lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    lockfileVersion: z.union([z.literal(2), z.literal(3)]),
    packageJsonSha256: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: z.literal("node-lock-v1"),
  })
  .strict();

export type DependencyMetadata = z.infer<typeof dependencyMetadataSchema>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeJson(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limit) {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function validateDependencySpecifiers(
  packageJson: Record<string, unknown>,
  profile: NodeRepositoryProfile,
): void {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = packageJson[field];
    if (value === undefined) continue;
    const dependencies = record(value);
    for (const [name, rawSpecifier] of Object.entries(dependencies)) {
      if (
        name.length === 0 ||
        name.length > 214 ||
        typeof rawSpecifier !== "string" ||
        rawSpecifier.length === 0 ||
        rawSpecifier.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(rawSpecifier) ||
        /^(?:https?:|git(?:\+|:)|github:|file:|link:|\/|\.{1,2}\/)/i.test(
          rawSpecifier,
        ) ||
        (rawSpecifier.startsWith("workspace:") && !profile.workspace)
      ) {
        throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
      }
    }
  }
}

function validIntegrity(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  try {
    return Buffer.from(match[1] ?? "", "base64").byteLength === 64;
  } catch {
    return false;
  }
}

function validRegistryResolution(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "registry.npmjs.org" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith("/")
    );
  } catch {
    return false;
  }
}

function validateManifest(
  manifest: ArchiveManifest,
  profile: NodeRepositoryProfile,
): void {
  for (const file of manifest.files) {
    const name = file.path.split("/").at(-1)?.toLowerCase() ?? "";
    if (DISALLOWED_CONFIG_NAMES.has(name)) {
      throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
    }
  }
  const paths = new Set(manifest.files.map((file) => file.path));
  if (
    !paths.has("package-lock.json") ||
    !paths.has(profile.workspace ? `${profile.workspace}/package.json` : "package.json")
  ) {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
}

export function validateNodeDependencyMetadata(input: {
  lockBytes: Uint8Array;
  manifest: ArchiveManifest;
  packageBytes: Uint8Array;
  profile: NodeRepositoryProfile;
}): DependencyMetadata {
  const profile = nodeRepositoryProfileSchema.parse(input.profile);
  validateManifest(input.manifest, profile);
  const packageJson = record(decodeJson(input.packageBytes, PACKAGE_JSON_LIMIT));
  const lockJson = record(decodeJson(input.lockBytes, LOCKFILE_LIMIT));
  const scripts = record(packageJson.scripts);
  for (const scriptName of [profile.controlScript, profile.reproductionScript]) {
    const script = scripts[scriptName];
    if (
      typeof script !== "string" ||
      script.length === 0 ||
      script.length > 10_000 ||
      script.includes("\u0000")
    ) {
      throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
    }
  }
  if (
    packageJson.packageManager !== undefined &&
    (typeof packageJson.packageManager !== "string" ||
      !/^npm@[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(
        packageJson.packageManager,
      ))
  ) {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
  validateDependencySpecifiers(packageJson, profile);

  const lockfileVersion = lockJson.lockfileVersion;
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
  const packages = record(lockJson.packages);
  const entries = Object.entries(packages);
  if (entries.length === 0 || entries.length > DEPENDENCY_LIMIT + 1) {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
  let dependencyCount = 0;
  for (const [path, rawEntry] of entries) {
    const entry = record(rawEntry);
    if (path === "" || path === profile.workspace) continue;
    if (!safeRelativePath(path)) {
      throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
    }
    if (!path.split("/").includes("node_modules")) {
      throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
    }
    if (entry.link === true) {
      if (
        !profile.workspace ||
        entry.resolved !== profile.workspace ||
        !safeRelativePath(profile.workspace)
      ) {
        throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
      }
      continue;
    }
    if (!validRegistryResolution(entry.resolved) || !validIntegrity(entry.integrity)) {
      throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
    }
    dependencyCount += 1;
  }
  if (dependencyCount > DEPENDENCY_LIMIT) {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
  return dependencyMetadataSchema.parse({
    dependencyCount,
    lockfileSha256: sha256(input.lockBytes),
    lockfileVersion,
    packageJsonSha256: sha256(input.packageBytes),
    policyVersion: "node-lock-v1",
  });
}

export type PreparedDependencies = DependencyMetadata & {
  installWorkspace: string;
  networkPolicy: "deny-all";
};

function assertSourceWorkspace(path: string): void {
  if (
    !path.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`) ||
    !safeRelativePath(path.slice(SANDBOX_WORKSPACE_ROOT.length + 1))
  ) {
    throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
  }
}

export class NodeDependencyPreparer {
  async prepare(input: {
    manifest: ArchiveManifest;
    profile: NodeRepositoryProfile;
    session: IsolatedSandboxSession;
    sourceWorkspace: string;
  }): Promise<PreparedDependencies> {
    const profile = nodeRepositoryProfileSchema.parse(input.profile);
    assertSourceWorkspace(input.sourceWorkspace);
    const packagePath = profile.workspace
      ? `${input.sourceWorkspace}/${profile.workspace}/package.json`
      : `${input.sourceWorkspace}/package.json`;
    const [packageBytes, lockBytes] = await Promise.all([
      input.session.readFile(packagePath),
      input.session.readFile(`${input.sourceWorkspace}/package-lock.json`),
    ]);
    if (!packageBytes || !lockBytes) {
      throw new DependencyPreparationError("UNSUPPORTED_SOURCE");
    }
    const metadata = validateNodeDependencyMetadata({
      lockBytes,
      manifest: input.manifest,
      packageBytes,
      profile,
    });
    await input.session.makeDirectory(DEPENDENCY_WORKSPACE);
    await input.session.makeDirectory(CACHE_PATH);
    const copied = await input.session.run(
      sandboxCommandSchema.parse({
        args: ["-a", `${input.sourceWorkspace}/.`, DEPENDENCY_WORKSPACE],
        cwd: input.sourceWorkspace,
        executable: "cp",
        phase: "dependency-acquisition",
        timeoutMs: 120_000,
      }),
    );
    if (copied.exitCode !== 0) {
      throw new DependencyPreparationError("DEPENDENCY_ACQUISITION_FAILED");
    }

    let networkMayBeOpen = false;
    try {
      networkMayBeOpen = true;
      await input.session.setNetworkPolicy({
        allowedHosts: ["registry.npmjs.org"],
        kind: "allow-hosts",
        phase: "npm-acquisition",
      });
      const acquired = await input.session.run(
        sandboxCommandSchema.parse({
          args: [
            "ci",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--cache",
            CACHE_PATH,
            "--prefer-online",
          ],
          cwd: DEPENDENCY_WORKSPACE,
          executable: "npm",
          phase: "dependency-acquisition",
          timeoutMs: 120_000,
        }),
      );
      if (acquired.exitCode !== 0) {
        throw new DependencyPreparationError("DEPENDENCY_ACQUISITION_FAILED");
      }
    } catch (error) {
      if (error instanceof DependencyPreparationError) throw error;
      throw new DependencyPreparationError("DEPENDENCY_ACQUISITION_FAILED");
    } finally {
      if (networkMayBeOpen) {
        try {
          await input.session.setNetworkPolicy({ kind: "deny-all" });
        } catch {
          throw new DependencyPreparationError("NETWORK_LOCKDOWN_FAILED");
        }
      }
    }

    const installed = await input.session.run(
      sandboxCommandSchema.parse({
        args: [
          "ci",
          "--ignore-scripts",
          "--offline",
          "--no-audit",
          "--no-fund",
          "--cache",
          CACHE_PATH,
        ],
        cwd: input.sourceWorkspace,
        executable: "npm",
        phase: "offline-install",
        timeoutMs: 120_000,
      }),
    );
    if (installed.exitCode !== 0) {
      throw new DependencyPreparationError("OFFLINE_INSTALL_FAILED");
    }
    return {
      ...metadata,
      installWorkspace: input.sourceWorkspace,
      networkPolicy: "deny-all",
    };
  }
}
