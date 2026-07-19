import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { CaseService } from "@/application/case-service";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";
import { createReproForgeMcpHttpHandler } from "@/mcp/http";

function createService(): CaseService {
  return new CaseService({
    clock: { now: () => new Date("2026-07-19T20:30:00.000Z") },
    identifiers: {
      nextCaseId: () => "http-case-1",
      nextJobId: () => "http-job-1",
    },
    repository: new InMemoryReproductionRepository(),
  });
}

describe("ReproForge Streamable HTTP transport", () => {
  it("completes MCP initialization, discovery, and a tool call over HTTP", async () => {
    const handler = createReproForgeMcpHttpHandler({
      callerId: "mcp:http-test",
      service: createService(),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://reproforge.test/mcp"),
      {
        fetch: async (input, init) => {
          const url = input instanceof Request ? input.url : input.toString();
          return handler(new Request(url, init));
        },
      },
    );
    const client = new Client({ name: "http-contract-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          { name: "start_reproduction" },
          { name: "get_reproduction" },
          { name: "export_repro_bundle" },
        ],
      });
      await expect(
        client.callTool({
          arguments: {
            idempotencyKey: "http-start",
            sampleId: "cli-spaces",
          },
          name: "start_reproduction",
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          caseState: "VERIFIED",
          proof: { status: "VERIFIED" },
        },
      });
    } finally {
      await client.close();
    }
  });

  it("answers preflight and rejects unsupported HTTP methods with CORS", async () => {
    const handler = createReProForgeHandlerForTest();
    const preflight = await handler(
      new Request("http://reproforge.test/mcp", { method: "OPTIONS" }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "Mcp-Protocol-Version",
    );

    const unsupported = await handler(
      new Request("http://reproforge.test/mcp", { method: "PUT" }),
    );
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("access-control-allow-origin")).toBe("*");
  });
});

function createReProForgeHandlerForTest() {
  return createReproForgeMcpHttpHandler({
    callerId: "mcp:http-cors-test",
    service: createService(),
  });
}
