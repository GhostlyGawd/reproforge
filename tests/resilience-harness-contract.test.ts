import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  RESILIENCE_CATEGORIES,
  resilienceHarnessRegistrySchema,
} from "@/evaluation/resilience-harness";

const registryPath = "docs/resilience-harness.json";

describe("private-beta resilience harness contract", () => {
  it("registers all eight deterministic campaigns with executable tests", () => {
    const registry = resilienceHarnessRegistrySchema.parse(
      JSON.parse(readFileSync(registryPath, "utf8")),
    );
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const command = packageJson.scripts["test:resilience"] ?? "";

    expect(registry.scenarios.map(({ category }) => category).sort()).toEqual(
      [...RESILIENCE_CATEGORIES].sort(),
    );
    expect(new Set(registry.scenarios.map(({ deterministicSeed }) =>
      deterministicSeed,
    )).size).toBe(8);
    for (const scenario of registry.scenarios) {
      expect(scenario.invariant.length).toBeGreaterThan(20);
      expect(scenario.testFiles.length).toBeGreaterThan(0);
      for (const file of scenario.testFiles) {
        expect(existsSync(file), `${file} must exist`).toBe(true);
        expect(command, `${file} must be in test:resilience`).toContain(file);
      }
    }
    expect(JSON.stringify(registry)).not.toMatch(
      /token|secret|tenant_|repository name|provider resource/i,
    );
  });
});
