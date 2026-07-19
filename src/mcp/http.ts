import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { CaseService } from "@/application/case-service";
import { createReproForgeMcpServer } from "@/mcp/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": [
    "Authorization",
    "Content-Type",
    "Mcp-Protocol-Version",
    "Mcp-Session-Id",
  ].join(", "),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

type McpHttpOptions = {
  callerId: string;
  service: CaseService;
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([name, value]) => headers.set(name, value));
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function methodNotAllowed(): Response {
  return withCors(
    new Response(
      JSON.stringify({
        error: { code: -32000, message: "Method not allowed." },
        id: null,
        jsonrpc: "2.0",
      }),
      {
        headers: {
          Allow: "POST, OPTIONS",
          "Content-Type": "application/json",
        },
        status: 405,
      },
    ),
  );
}

export function createReproForgeMcpHttpHandler({
  callerId,
  service,
}: McpHttpOptions): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    if (request.method !== "POST") return methodNotAllowed();

    const server = createReproForgeMcpServer({ callerId, service });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      return withCors(await transport.handleRequest(request));
    } catch {
      return withCors(
        new Response(
          JSON.stringify({
            error: {
              code: -32603,
              message: "ReproForge MCP request failed safely.",
            },
            id: null,
            jsonrpc: "2.0",
          }),
          { headers: { "Content-Type": "application/json" }, status: 500 },
        ),
      );
    } finally {
      await server.close().catch(() => undefined);
    }
  };
}
