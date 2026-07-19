import { runResultSchema, type RunResult } from "@/domain/run";

export type RunRequest = {
  command: string;
  repository: string;
};

export interface Runner {
  run(request: RunRequest): Promise<RunResult>;
}

export class ExternalRunnerUnavailable extends Error {
  constructor() {
    super(
      "External repository execution is disabled because no isolated runner is configured.",
    );
    this.name = "ExternalRunnerUnavailable";
  }
}

export class UnavailableExternalRunner implements Runner {
  async run(request: RunRequest): Promise<RunResult> {
    void request;
    throw new ExternalRunnerUnavailable();
  }
}

const fixtureCommands: Readonly<Record<string, Readonly<Record<string, RunResult>>>> = {
  "fixture://cli-spaces": {
    control: {
      id: "fixture-control",
      command: "control",
      durationMs: 8,
      environmentHash: "fixture-cli-spaces-v1",
      exitCode: 0,
      stderr: "",
      stdout: "Loaded config from ./fixtures/config.json",
    },
    reproduce: {
      id: "fixture-reproduce",
      command: "reproduce",
      durationMs: 12,
      environmentHash: "fixture-cli-spaces-v1",
      exitCode: 1,
      stderr: "Error: ENOENT: config path contains spaces",
      stdout: "",
    },
  },
};

export class TrustedFixtureRunner implements Runner {
  async run(request: RunRequest): Promise<RunResult> {
    const fixture = fixtureCommands[request.repository];
    if (!fixture) {
      throw new Error(`Unknown trusted fixture: ${request.repository}`);
    }
    const result = fixture[request.command];
    if (!result) {
      throw new Error(`Command is not allowlisted for trusted fixture: ${request.command}`);
    }
    return runResultSchema.parse(structuredClone(result));
  }
}
