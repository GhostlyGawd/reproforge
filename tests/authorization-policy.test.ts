import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationError,
  resolveAuthorizedPrincipal,
} from "@/application/authorization";
import type {
  PrincipalDirectory,
  PrincipalRecord,
} from "@/application/ports/identity";
import type { VerifiedAccessToken } from "@/application/ports/auth";

const token: VerifiedAccessToken = {
  expiresAt: 1_800_000_300,
  issuer: "https://issuer.reproforge.test/",
  scopes: [
    "reproforge:cases:read",
    "reproforge:repositories:read",
  ],
  subject: "auth0|principal-alpha",
  tenantId: "tenant-alpha",
};

const record: PrincipalRecord = {
  principalId: "principal-alpha",
  status: "ACTIVE",
  tenantId: "tenant-alpha",
};

function directory(value: PrincipalRecord | null = record): PrincipalDirectory {
  return { resolve: vi.fn(async () => value) };
}

describe("principal and tenant authorization", () => {
  it("derives the caller and tenant only from a verified token and server mapping", async () => {
    const principals = directory();

    await expect(
      resolveAuthorizedPrincipal({
        directory: principals,
        requiredScopes: ["reproforge:cases:read"],
        token,
      }),
    ).resolves.toEqual({
      callerId: "principal-alpha",
      expiresAt: token.expiresAt,
      issuer: token.issuer,
      principalId: "principal-alpha",
      scopes: token.scopes,
      subject: token.subject,
      tenantId: "tenant-alpha",
    });
    expect(principals.resolve).toHaveBeenCalledWith({
      issuer: token.issuer,
      subject: token.subject,
    });
  });

  it("ignores injected caller and tenant fields at the transport boundary", async () => {
    const candidate = {
      callerId: "attacker",
      directory: directory(),
      principalId: "attacker",
      requiredScopes: ["reproforge:cases:read"],
      tenantId: "tenant-other",
      token,
    } as unknown as Parameters<typeof resolveAuthorizedPrincipal>[0];

    await expect(resolveAuthorizedPrincipal(candidate)).resolves.toMatchObject({
      callerId: "principal-alpha",
      principalId: "principal-alpha",
      tenantId: "tenant-alpha",
    });
  });

  it.each([
    ["missing mapping", null],
    ["suspended tenant", { ...record, status: "SUSPENDED" as const }],
    ["deleted tenant", { ...record, status: "DELETED" as const }],
    ["claim/mapping mismatch", { ...record, tenantId: "tenant-other" }],
  ])("fails closed for %s", async (_label, mapped) => {
    await expect(
      resolveAuthorizedPrincipal({
        directory: directory(mapped),
        requiredScopes: ["reproforge:cases:read"],
        token,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PRINCIPAL",
    });
  });

  it("returns a precise insufficient-scope decision without leaking identity", async () => {
    await expect(
      resolveAuthorizedPrincipal({
        directory: directory(),
        requiredScopes: [
          "reproforge:cases:write",
          "reproforge:repositories:read",
        ],
        token,
      }),
    ).rejects.toEqual(
      new AuthorizationError(
        "INSUFFICIENT_SCOPE",
        ["reproforge:cases:write"],
        "Additional ReproForge permission is required",
      ),
    );
  });
});
