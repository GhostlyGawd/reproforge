import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaseService } from "@/application/case-service";
import { runTrustedSample } from "@/application/sample-case";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";
import {
  createReproForgeMcpServer,
  REPROFORGE_WIDGET_URI,
} from "@/mcp/server";

function createService() {
  let caseSequence = 0;
  let jobSequence = 0;
  const executeTrustedSample = vi.fn(runTrustedSample);
  const service = new CaseService({
    clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
    executeTrustedSample,
    identifiers: {
      nextCaseId: () => `mcp-case-${++caseSequence}`,
      nextJobId: () => `mcp-job-${++jobSequence}`,
    },
    repository: new InMemoryReproductionRepository(),
  });
  return { executeTrustedSample, service };
}

async function connect(service: CaseService) {
  const server = createReproForgeMcpServer({
    callerId: "mcp:test",
    service,
  });
  const client = new Client(
    { name: "reproforge-contract-test", version: "1.0.0" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ReproForge MCP app contract", () => {
  it("publishes exactly three bounded tools with explicit safety annotations", async () => {
    const { service } = createService();
    const connection = await connect(service);

    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "start_reproduction",
        "get_reproduction",
        "export_repro_bundle",
      ]);
      expect(listed.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "start_reproduction",
            annotations: {
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
              readOnlyHint: false,
            },
          }),
          expect.objectContaining({
            name: "get_reproduction",
            annotations: {
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
              readOnlyHint: true,
            },
          }),
          expect.objectContaining({
            name: "export_repro_bundle",
            annotations: {
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
              readOnlyHint: true,
            },
          }),
        ]),
      );

      const serializedInputs = JSON.stringify(
        listed.tools.map((tool) => tool.inputSchema),
      ).toLowerCase();
      expect(serializedInputs).not.toContain("repository");
      expect(serializedInputs).not.toContain("command");
      expect(serializedInputs).not.toContain("api_key");
      expect(serializedInputs).not.toContain("openai");
      expect(listed.tools.every((tool) => tool._meta?.securitySchemes)).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("serves one self-contained MCP App resource with a closed CSP", async () => {
    const { service } = createService();
    const connection = await connect(service);

    try {
      const resources = await connection.client.listResources();
      expect(resources.resources).toEqual([
        expect.objectContaining({
          mimeType: "text/html;profile=mcp-app",
          uri: REPROFORGE_WIDGET_URI,
        }),
      ]);

      const read = await connection.client.readResource({
        uri: REPROFORGE_WIDGET_URI,
      });
      const resource = read.contents[0];
      expect(resource).toMatchObject({
        mimeType: "text/html;profile=mcp-app",
        uri: REPROFORGE_WIDGET_URI,
      });
      expect(resource && "text" in resource ? resource.text : "").toContain(
        "ui/initialize",
      );
      expect(resource?._meta).toMatchObject({
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
          prefersBorder: true,
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("runs keylessly, returns proof, and reuses an idempotent retry", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { executeTrustedSample, service } = createService();
    const connection = await connect(service);
    const args = { idempotencyKey: "mcp-retry", sampleId: "cli-spaces" };

    try {
      const first = await connection.client.callTool({
        arguments: args,
        name: "start_reproduction",
      });
      const second = await connection.client.callTool({
        arguments: args,
        name: "start_reproduction",
      });
      const firstView = first.structuredContent as Record<string, unknown>;
      const secondView = second.structuredContent as Record<string, unknown>;

      expect(first.isError).not.toBe(true);
      expect(firstView).toMatchObject({
        caseState: "VERIFIED",
        jobState: "SUCCEEDED",
        kind: "reproduction",
        proof: {
          bundleReady: true,
          candidateMatches: 3,
          controlMatched: false,
          requiredRuns: 3,
          status: "VERIFIED",
        },
        sampleId: "cli-spaces",
        schemaVersion: "1.0",
      });
      expect(secondView.caseId).toBe(firstView.caseId);
      expect(secondView.jobId).toBe(firstView.jobId);
      expect(second._meta?.reproforge).toMatchObject({ reused: true });
      expect(executeTrustedSample).toHaveBeenCalledTimes(1);
    } finally {
      await connection.close();
    }
  });

  it("reads a completed case and exports its content-addressed bundle", async () => {
    const { service } = createService();
    const connection = await connect(service);

    try {
      const started = await connection.client.callTool({
        arguments: {
          idempotencyKey: "mcp-export",
          sampleId: "cli-spaces",
        },
        name: "start_reproduction",
      });
      const startedView = started.structuredContent as Record<string, unknown>;
      const caseId = String(startedView.caseId);
      const read = await connection.client.callTool({
        arguments: { caseId },
        name: "get_reproduction",
      });
      const exported = await connection.client.callTool({
        arguments: { caseId },
        name: "export_repro_bundle",
      });

      expect(read.structuredContent).toMatchObject({ caseId, caseState: "VERIFIED" });
      expect(exported.structuredContent).toMatchObject({
        bundleSchemaVersion: "1.1",
        caseId,
        kind: "bundle",
        schemaVersion: "1.0",
        status: "VERIFIED",
      });
      const bundleView = exported.structuredContent as Record<string, unknown>;
      expect(bundleView.bundleHash).toMatch(/^[a-f0-9]{64}$/);
      expect(bundleView.fileNames).toContain("REPRO.md");
      expect(exported._meta?.reproforge).toMatchObject({
        files: expect.objectContaining({ "REPRO.md": expect.any(String) }),
      });
    } finally {
      await connection.close();
    }
  });

  it("returns stable sanitized errors without leaking thrown diagnostics", async () => {
    const { service } = createService();
    const connection = await connect(service);

    try {
      const result = await connection.client.callTool({
        arguments: { caseId: "missing-secret-provider-diagnostic" },
        name: "get_reproduction",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "NOT_FOUND: The requested reproduction was not found",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("provider diagnostic");
    } finally {
      await connection.close();
    }
  });
});
