import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";

import {
  sandboxCommandSchema,
  sandboxCreateRequestSchema,
  sandboxNetworkPolicySchema,
  SANDBOX_ROOT,
  type IsolatedSandboxProvider,
  type IsolatedSandboxSession,
  type SandboxCommand,
  type SandboxCommandResult,
  type SandboxCreateRequest,
  type SandboxFile,
  type SandboxNetworkPolicy,
  type SandboxUsage,
} from "@/execution/contracts";

type VercelCreateRequest = {
  networkPolicy: "deny-all";
  persistent: false;
  resources: { vcpus: 2 };
  runtime: "node22" | "node24";
  timeout: number;
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
  stop(): Promise<unknown>;
  update(input: { networkPolicy: NetworkPolicy }): Promise<void>;
  writeFiles(
    files: Array<{ content: string | Uint8Array; path: string }>,
  ): Promise<void>;
};

type VercelSandboxFactory = (
  request: VercelCreateRequest,
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
  return policy.kind === "deny-all"
    ? "deny-all"
    : { allow: [...policy.allowedHosts] };
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

  async create(rawRequest: SandboxCreateRequest): Promise<IsolatedSandboxSession> {
    const request = sandboxCreateRequestSchema.parse(rawRequest);
    const sandbox = await this.createSandbox({
      networkPolicy: "deny-all",
      persistent: false,
      resources: { vcpus: request.vcpus },
      runtime: request.runtime,
      timeout: request.timeoutMs,
    });
    return new VercelSandboxSession(sandbox);
  }
}
