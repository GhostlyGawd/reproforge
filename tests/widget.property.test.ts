import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createReproForgeWidgetHtml,
  safeJsonForScript,
} from "@/mcp/widget";

describe("ReproForge MCP App widget properties", () => {
  it("round-trips arbitrary text without permitting script-tag breakout", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (value) => {
        const encoded = safeJsonForScript({ value });
        expect(encoded).not.toContain("<");
        expect(JSON.parse(encoded)).toEqual({ value });
      }),
      { numRuns: 100 },
    );
  });

  it("embeds hostile preview data as inert JSON", () => {
    const hostile = "</script><script>globalThis.pwned=true</script>\u2028\u2029";
    const html = createReproForgeWidgetHtml({
      _meta: { reproforge: { evidence: [{ content: hostile }] } },
      structuredContent: {
        caseId: hostile,
        caseState: "VERIFIED",
        evidenceCounts: { inferred: 0, observed: 0, reported: 0, unknown: 0 },
        hypotheses: [],
        jobId: "job-preview",
        jobState: "SUCCEEDED",
        kind: "reproduction",
        proof: {
          bundleHash: null,
          bundleReady: false,
          candidateMatches: 0,
          controlMatched: false,
          oracleId: null,
          oracleVersion: null,
          repeatability: 0,
          requiredRuns: 3,
          status: null,
        },
        runs: [],
        sampleId: "cli-spaces",
        schemaVersion: "1.0",
      },
    });

    expect(html.match(/<script/gi)).toHaveLength(1);
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
    expect(html).not.toContain(hostile);
    expect(html).toContain("ui/initialize");
    expect(html).toContain("ui/notifications/tool-result");
    expect(html).toContain("tools/call");
  });
});
