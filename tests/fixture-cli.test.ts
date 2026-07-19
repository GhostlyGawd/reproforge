import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const script = resolve(root, "fixtures", "cli-spaces", "repro.mjs");

function execute(configPath: string) {
  return spawnSync(process.execPath, [script, "--config", configPath], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("bundled CLI reproduction", () => {
  it("passes for the negative-control path", () => {
    const result = execute("fixtures/cli-spaces/config.json");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Loaded config");
  });

  it("fails with ENOENT for the one-command spaced-path reproduction", () => {
    const result = execute("fixtures/cli-spaces/my config.json");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENOENT");
  });
});
