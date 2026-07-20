import {
  Sandbox,
  type NetworkPolicy,
  type NetworkPolicyRule,
} from "@vercel/sandbox";
import { z } from "zod";

import {
  sandboxCommandSchema,
  sandboxCreateRequestSchema,
  sandboxNetworkPolicySchema,
  sandboxSnapshotCreateRequestSchema,
  SANDBOX_ROOT,
  SANDBOX_SNAPSHOT_MAX_EXPIRATION_MS,
  SANDBOX_SNAPSHOT_MIN_EXPIRATION_MS,
  type IsolatedSandboxProvider,
  type IsolatedSandboxSession,
  type IsolatedSandboxSnapshot,
  type SandboxCommand,
  type SandboxCommandResult,
  type SandboxCreateRequest,
  type SandboxFile,
  type SandboxNetworkPolicy,
  type SandboxSnapshotCreateRequest,
  type SandboxUsage,
} from "@/execution/contracts";

type VercelCreateRequest = {
  networkPolicy: "deny-all";
  persistent: false;
  resources: { vcpus: 2 };
  runtime: "node22" | "node24";
  signal?: AbortSignal;
  timeout: number;
};

type VercelSnapshotCreateRequest = Omit<VercelCreateRequest, "runtime"> & {
  source: { snapshotId: string; type: "snapshot" };
};

type VercelCommandFinished = {
  durationMs?: number;
  exitCode: number;
  stderr(options?: { signal?: AbortSignal }): Promise<string>;
  stdout(options?: { signal?: AbortSignal }): Promise<string>;
};

type VercelSandboxHandle = {
  readonly activeCpuUsageMs?: number;
  readonly name: string;
  readonly networkTransfer?: { egress: number; ingress: number };
  mkDir(path: string): Promise<void>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  runCommand(input: {
    args: string[];
    cmd: string;
    cwd: string;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<VercelCommandFinished>;
  snapshot(input: { expiration: number; signal?: AbortSignal }): Promise<{
    delete(): Promise<unknown>;
    snapshotId: string;
  }>;
  stop(): Promise<unknown>;
  update(input: { networkPolicy: NetworkPolicy }): Promise<void>;
  writeFiles(
    files: Array<{ content: string | Uint8Array; path: string }>,
  ): Promise<void>;
};

type VercelSandboxFactory = (
  request: VercelCreateRequest | VercelSnapshotCreateRequest,
) => Promise<VercelSandboxHandle>;

function assertSandboxPath(path: string): void {
  if (
    !path.startsWith(`${SANDBOX_ROOT}/`) ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path
      .slice(SANDBOX_ROOT.length + 1)
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError("File IO requires a canonical sandbox path");
  }
}

function toVercelNetworkPolicy(policy: SandboxNetworkPolicy): NetworkPolicy {
  if (policy.kind === "deny-all") return "deny-all";
  if (policy.kind === "allow-hosts") {
    return { allow: [...policy.allowedHosts] };
  }
  const allow: Record<string, NetworkPolicyRule[]> = Object.fromEntries(
    policy.allowedHosts.map((host) => [host, []]),
  );
  allow[policy.injection.host] = [
    {
      match: {
        method: [policy.injection.method],
        path: { exact: policy.injection.path },
      },
      transform: [
        {
          headers: {
            authorization: policy.injection.authorizationHeader,
          },
        },
      ],
    },
  ];
  return { allow };
}

class VercelSandboxSession implements IsolatedSandboxSession {
  private stopPromise?: Promise<void>;

  constructor(private readonly sandbox: VercelSandboxHandle) {}

  get sandboxId(): string {
    return this.sandbox.name;
  }

  async makeDirectory(path: string): Promise<void> {
    assertSandboxPath(path);
    await this.sandbox.mkDir(path);
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    assertSandboxPath(path);
    const content = await this.sandbox.readFileToBuffer({ path });
    return content === null ? null : new Uint8Array(content);
  }

  async run(
    rawCommand: SandboxCommand,
    options: { signal?: AbortSignal } = {},
  ): Promise<SandboxCommandResult> {
    const command = sandboxCommandSchema.parse(rawCommand);
    const startedAt = performance.now();
    const result = await this.sandbox.runCommand({
      args: command.args,
      cmd: command.executable,
      cwd: command.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: command.timeoutMs,
    });
    const [stdout, stderr] = await Promise.all([
      result.stdout(options),
      result.stderr(options),
    ]);
    return {
      durationMs:
        result.durationMs ?? Math.max(0, Math.round(performance.now() - startedAt)),
      exitCode: result.exitCode,
      stderr: new TextEncoder().encode(stderr),
      stdout: new TextEncoder().encode(stdout),
    };
  }

  async setNetworkPolicy(rawPolicy: SandboxNetworkPolicy): Promise<void> {
    const policy = sandboxNetworkPolicySchema.parse(rawPolicy);
    await this.sandbox.update({ networkPolicy: toVercelNetworkPolicy(policy) });
  }

  async snapshot(
    expirationMs: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<IsolatedSandboxSnapshot> {
    const expiration = z
      .number()
      .int()
      .min(SANDBOX_SNAPSHOT_MIN_EXPIRATION_MS)
      .max(SANDBOX_SNAPSHOT_MAX_EXPIRATION_MS)
      .parse(expirationMs);
    const snapshot = await this.sandbox.snapshot({
      expiration,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.stopPromise ??= Promise.resolve();
    let deletePromise: Promise<void> | undefined;
    return {
      delete: () => {
        deletePromise ??= snapshot.delete().then(() => undefined);
        return deletePromise;
      },
      snapshotId: snapshot.snapshotId,
    };
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.sandbox.stop().then(() => undefined);
    return this.stopPromise;
  }

  async usage(): Promise<SandboxUsage> {
    return {
      activeCpuMs: this.sandbox.activeCpuUsageMs ?? null,
      networkEgressBytes: this.sandbox.networkTransfer?.egress ?? null,
      networkIngressBytes: this.sandbox.networkTransfer?.ingress ?? null,
    };
  }

  async writeFiles(files: SandboxFile[]): Promise<void> {
    const validated = files.map((file) => {
      assertSandboxPath(file.path);
      return { content: file.content, path: file.path };
    });
    await this.sandbox.writeFiles(validated);
  }
}

export class VercelSandboxProvider implements IsolatedSandboxProvider {
  private readonly createSandbox: VercelSandboxFactory;

  constructor(
    dependencies: { create?: VercelSandboxFactory } = {},
  ) {
    this.createSandbox =
      dependencies.create ??
      (async (request) => Sandbox.create(request));
  }

  async create(
    rawRequest: SandboxCreateRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<IsolatedSandboxSession> {
    const request = sandboxCreateRequestSchema.parse(rawRequest);
    const sandbox = await this.createSandbox({
      networkPolicy: "deny-all",
      persistent: false,
      resources: { vcpus: request.vcpus },
      runtime: request.runtime,
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: request.timeoutMs,
    });
    return new VercelSandboxSession(sandbox);
  }

  async createFromSnapshot(
    rawRequest: SandboxSnapshotCreateRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<IsolatedSandboxSession> {
    const request = sandboxSnapshotCreateRequestSchema.parse(rawRequest);
    const sandbox = await this.createSandbox({
      networkPolicy: "deny-all",
      persistent: false,
      resources: { vcpus: request.vcpus },
      ...(options.signal ? { signal: options.signal } : {}),
      source: { snapshotId: request.snapshotId, type: "snapshot" },
      timeout: request.timeoutMs,
    });
    return new VercelSandboxSession(sandbox);
  }
}
