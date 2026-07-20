import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessTokenVerifier } from "@/application/ports/auth";
import type { PrincipalDirectory } from "@/application/ports/identity";
import type { RepositoryOperations } from "@/application/repository-operations";
import { CaseService } from "@/application/case-service";
import { OAuthVerificationError } from "@/auth/access-token-verifier";
import { parseOAuthResourceConfig } from "@/config/oauth";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";
import { createReproForgeMcpServer } from "@/mcp/server";

const oauthConfig = parseOAuthResourceConfig({
  AUTH0_DOMAIN: "issuer.reproforge.test",
  REPROFORGE_BASE_URL: "https://reproforge.test",
  REPROFORGE_OAUTH_TENANT_CLAIM: "https://reproforge.dev/tenant_id",
});

function createTrustedService(): CaseService {
  return new CaseService({
    clock: { now: () => new Date("2026-07-20T00:00:00.000Z") },
    identifiers: {
      nextCaseId: () => "mcp-auth-case",
      nextJobId: () => "mcp-auth-job",
    },
    repository: new InMemoryReproductionRepository(),
  });
}

function createRepositoryService(): RepositoryOperations {
  return {
    cancelReproduction: vi.fn(),
    exportReproBundle: vi.fn(),
    getReproduction: vi.fn(),
    listAuthorizedRepositories: vi.fn(async (principal) => ({
      nextCursor: null,
      repositories: [
        {
          defaultBranch: "main",
          fullName: "public/reproforge-canary",
          private: false,
          repositoryId: "repo_public_canary",
        },
      ],
      tenantId: principal.tenantId,
    })),
    startRepositoryReproduction: vi.fn(),
  };
}

function tokenVerifier(scopes: Array<
  | "reproforge:cases:read"
  | "reproforge:cases:write"
  | "reproforge:repositories:read"
  | "reproforge:bundles:read"
>): AccessTokenVerifier {
  return {
    verify: vi.fn(async (authorization) => {
      if (!authorization) {
        throw new OAuthVerificationError(
          "MISSING_TOKEN",
          "A bearer token is required",
        );
      }
      return {
        expiresAt: 1_800_000_300,
        issuer: "https://issuer.reproforge.test/",
        scopes,
        subject: "auth0|principal-alpha",
        tenantId: "tenant-alpha",
      };
    }),
  };
}

const principals: PrincipalDirectory = {
  resolve: vi.fn(async () => ({
    principalId: "principal-alpha",
    status: "ACTIVE",
    tenantId: "tenant-alpha",
  })),
};

async function connect(options?: {
  authorization?: string;
  scopes?: Parameters<typeof tokenVerifier>[0];
}) {
  const repositoryService = createRepositoryService();
  const server = createReproForgeMcpServer({
    authorization: {
      authorizationHeader: options?.authorization ?? null,
      config: oauthConfig,
      directory: principals,
      verifier: tokenVerifier(
        options?.scopes ?? [
          "reproforge:bundles:read",
          "reproforge:cases:read",
          "reproforge:cases:write",
          "reproforge:repositories:read",
        ],
      ),
    },
    repositoryService,
    service: createTrustedService(),
  });
  const client = new Client({ name: "mcp-auth-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    repositoryService,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => vi.clearAllMocks());

describe("MCP v2 authorization contract", () => {
  it("advertises five bounded tools with exact no-auth/OAuth alternatives", async () => {
    const connection = await connect();
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual([
        "start_reproduction",
        "list_authorized_repositories",
        "get_reproduction",
        "cancel_reproduction",
        "export_repro_bundle",
      ]);
      const schemes = Object.fromEntries(
        listed.tools.map((tool) => [tool.name, tool._meta?.securitySchemes]),
      );
      expect(schemes).toEqual({
        cancel_reproduction: [
          { type: "oauth2", scopes: ["reproforge:cases:write"] },
        ],
        export_repro_bundle: [
          { type: "noauth" },
          { type: "oauth2", scopes: ["reproforge:bundles:read"] },
        ],
        get_reproduction: [
          { type: "noauth" },
          { type: "oauth2", scopes: ["reproforge:cases:read"] },
        ],
        list_authorized_repositories: [
          { type: "oauth2", scopes: ["reproforge:repositories:read"] },
        ],
        start_reproduction: [
          { type: "noauth" },
          {
            type: "oauth2",
            scopes: [
              "reproforge:cases:write",
              "reproforge:repositories:read",
            ],
          },
        ],
      });
      expect(JSON.stringify(listed.tools.map(({ inputSchema }) => inputSchema)))
        .not.toMatch(/callerId|principalId|tenantId|api.?key|token|command/i);
    } finally {
      await connection.close();
    }
  });

  it("keeps the trusted synthetic sample keyless through the strict source union", async () => {
    const connection = await connect();
    try {
      const result = await connection.client.callTool({
        arguments: {
          idempotencyKey: "trusted-keyless",
          source: { kind: "trusted_sample", sampleId: "cli-spaces" },
        },
        name: "start_reproduction",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        caseState: "VERIFIED",
        proof: { status: "VERIFIED" },
      });
    } finally {
      await connection.close();
    }
  });

  it("prompts account linking with a sanitized tool-level challenge", async () => {
    const connection = await connect();
    try {
      const result = await connection.client.callTool({
        arguments: {},
        name: "list_authorized_repositories",
      });
      expect(result.isError).toBe(true);
      expect(result._meta?.["mcp/www_authenticate"]).toBe(
        'Bearer resource_metadata="https://reproforge.test/.well-known/oauth-protected-resource", scope="reproforge:repositories:read", error="invalid_token", error_description="Link your ReproForge account to continue"',
      );
      expect(JSON.stringify(result)).not.toContain("principal-alpha");
    } finally {
      await connection.close();
    }
  });

  it("requests only a missing scope, then calls the protected service as the mapped principal", async () => {
    const missing = await connect({
      authorization: "Bearer valid-synthetic-token",
      scopes: ["reproforge:cases:read"],
    });
    try {
      const denied = await missing.client.callTool({
        arguments: {},
        name: "list_authorized_repositories",
      });
      expect(denied._meta?.["mcp/www_authenticate"]).toContain(
        'scope="reproforge:repositories:read"',
      );
      expect(denied._meta?.["mcp/www_authenticate"]).toContain(
        'error="insufficient_scope"',
      );
    } finally {
      await missing.close();
    }

    const allowed = await connect({
      authorization: "Bearer valid-synthetic-token",
      scopes: ["reproforge:repositories:read"],
    });
    try {
      const result = await allowed.client.callTool({
        arguments: {},
        name: "list_authorized_repositories",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        repositories: [{ repositoryId: "repo_public_canary" }],
      });
      expect(
        allowed.repositoryService.listAuthorizedRepositories,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          callerId: "principal-alpha",
          principalId: "principal-alpha",
          tenantId: "tenant-alpha",
        }),
        {},
      );
    } finally {
      await allowed.close();
    }
  });
});
