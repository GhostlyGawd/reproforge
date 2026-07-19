import { describe, expect, it } from "vitest";

import { runTrustedSample } from "@/application/sample-case";
import { validateMaterializedBundle } from "@/domain/bundle";

describe("trusted sample vertical slice", () => {
  it("moves from issue evidence to a verified portable bundle", async () => {
    const result = await runTrustedSample();

    expect(result.case.state).toBe("VERIFIED");
    expect(result.case.history.map((entry) => entry.to)).toEqual([
      "INGESTING",
      "INSPECTING",
      "HYPOTHESIZING",
      "EXPERIMENTING",
      "VERIFYING",
      "MINIMIZING",
      "PACKAGING",
      "VERIFIED",
    ]);
    expect(result.summary.status).toBe("VERIFIED");
    expect(result.summary.candidateMatches).toBe(3);
    expect(result.summary.controlMatched).toBe(false);
    expect(validateMaterializedBundle(result.files)).toEqual({
      success: true,
      errors: [],
    });
  });
});
