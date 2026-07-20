import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "@playwright/test";

test("serves the complete keyless MCP flow through the Next route", async () => {
  const client = new Client({ name: "reproforge-route-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:3000/mcp"),
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "start_reproduction",
      "list_authorized_repositories",
      "get_reproduction",
      "cancel_reproduction",
      "export_repro_bundle",
    ]);
    const result = await client.callTool({
      arguments: {
        idempotencyKey: `playwright-mcp-${Date.now()}`,
        source: { kind: "trusted_sample", sampleId: "cli-spaces" },
      },
      name: "start_reproduction",
    });
    expect(result).toMatchObject({
      structuredContent: {
        caseState: "VERIFIED",
        jobState: "SUCCEEDED",
        proof: {
          candidateMatches: 3,
          controlMatched: false,
          status: "VERIFIED",
        },
      },
    });
  } finally {
    await client.close();
  }
});

test("exposes a permissive preflight only for the keyless synthetic endpoint", async ({
  request,
}) => {
  const response = await request.fetch("/mcp", { method: "OPTIONS" });
  expect(response.status()).toBe(204);
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
  expect(response.headers()["access-control-allow-methods"]).toBe("POST, OPTIONS");
});
