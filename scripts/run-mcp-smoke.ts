import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CaseService } from "@/application/case-service";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";
import {
  createReproForgeMcpServer,
  REPROFORGE_WIDGET_URI,
} from "@/mcp/server";

async function main(): Promise<void> {
let executions = 0;
const service = new CaseService({
  clock: { now: () => new Date("2026-07-19T21:00:00.000Z") },
  executeTrustedSample: async (options) => {
    executions += 1;
    const { runTrustedSample } = await import("@/application/sample-case");
    return runTrustedSample(options);
  },
  identifiers: {
    nextCaseId: () => "smoke-case-1",
    nextJobId: () => "smoke-job-1",
  },
  repository: new InMemoryReproductionRepository(),
});
const server = createReproForgeMcpServer({ callerId: "mcp:smoke", service });
const client = new Client({ name: "reproforge-smoke", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const priorOpenAIKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const resources = await client.listResources();
  const widget = await client.readResource({ uri: REPROFORGE_WIDGET_URI });
  const command = {
    arguments: { idempotencyKey: "smoke-retry", sampleId: "cli-spaces" },
    name: "start_reproduction",
  };
  const first = await client.callTool(command);
  const retry = await client.callTool(command);
  const startView = first.structuredContent as Record<string, unknown>;
  const retryView = retry.structuredContent as Record<string, unknown>;
  const read = await client.callTool({
    arguments: { caseId: startView.caseId },
    name: "get_reproduction",
  });
  const exported = await client.callTool({
    arguments: { caseId: startView.caseId },
    name: "export_repro_bundle",
  });
  const widgetContent = widget.contents[0];

  process.stdout.write(
    `${JSON.stringify(
      {
        auth: { openAIKeyRequired: false, scheme: "noauth" },
        export: exported.structuredContent,
        get: read.structuredContent,
        idempotency: {
          executions,
          sameCase: startView.caseId === retryView.caseId,
          sameJob: startView.jobId === retryView.jobId,
        },
        schemaVersion: "1.0",
        start: first.structuredContent,
        tools: listed.tools.map((tool) => ({
          annotations: tool.annotations,
          inputProperties: Object.keys(tool.inputSchema.properties ?? {}).sort(),
          name: tool.name,
        })),
        transport: "mcp-in-memory-contract-smoke",
        widget: {
          listed: resources.resources.some(
            (resource) => resource.uri === REPROFORGE_WIDGET_URI,
          ),
          meta: widgetContent?._meta,
          mimeType: widgetContent?.mimeType,
          uri: widgetContent?.uri,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (priorOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = priorOpenAIKey;
  await client.close();
  await server.close();
}
}

void main().catch(() => {
  process.stderr.write("ReproForge MCP smoke failed safely.\n");
  process.exitCode = 1;
});
