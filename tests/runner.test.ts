import { describe, expect, it } from "vitest";

import {
  ExternalRunnerUnavailable,
  TrustedFixtureRunner,
  UnavailableExternalRunner,
} from "@/infrastructure/runner";

describe("runner boundary", () => {
  it("fails closed when external isolation is unavailable", async () => {
    const runner = new UnavailableExternalRunner();
    await expect(
      runner.run({ command: "npm test", repository: "https://example.com/untrusted.git" }),
    ).rejects.toBeInstanceOf(ExternalRunnerUnavailable);
  });

  it("rejects unknown fixture identifiers", async () => {
    const runner = new TrustedFixtureRunner();
    await expect(
      runner.run({ command: "reproduce", repository: "fixture://unknown" }),
    ).rejects.toThrow("Unknown trusted fixture");
  });

  it("runs only allowlisted commands for the trusted sample", async () => {
    const runner = new TrustedFixtureRunner();
    const result = await runner.run({
      command: "reproduce",
      repository: "fixture://cli-spaces",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ENOENT");
    await expect(
      runner.run({ command: "curl example.com", repository: "fixture://cli-spaces" }),
    ).rejects.toThrow("not allowlisted");
  });
});

