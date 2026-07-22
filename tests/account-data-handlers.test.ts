import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  AccountDataError,
} from "@/application/account-data-service";
import {
  createAccountDataExportHandler,
  createAccountDeletionHandler,
} from "@/account/handlers";

const principal = {
  callerId: "principal_account_route",
  principalId: "principal_account_route",
  tenantId: "tenant_account_route",
};

function fixture() {
  return {
    actor: vi.fn<() => Promise<typeof principal | null>>(async () => principal),
    service: {
      exportAccountData: vi.fn(async () => ({
        bytes: new TextEncoder().encode('{"portable":true}'),
        contentType: "application/vnd.reproforge.account-export+json" as const,
        filename: "reproforge-account-export-2026-07-20.json",
        manifestSha256: "a".repeat(64),
        sha256: "b".repeat(64),
      })),
      requestAccountDeletion: vi.fn(async () => ({
        created: true,
        requestId: `delete_${"c".repeat(48)}`,
        status: "scheduled" as const,
      })),
    },
  };
}

describe("account data HTTP handlers", () => {
  it("downloads a tenant-safe portable archive with integrity headers", async () => {
    const current = fixture();
    const response = await createAccountDataExportHandler({
      ...current,
      nextRequestId: () => "request_account_export",
    })(
      new Request("https://reproforge.test/api/account/export", {
        headers: { "Idempotency-Key": "export-route-1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="reproforge-account-export-2026-07-20.json"',
    );
    expect(response.headers.get("ETag")).toBe(`"${"b".repeat(64)}"`);
    expect(response.headers.get("X-ReproForge-Manifest-SHA256")).toBe(
      "a".repeat(64),
    );
    expect(await response.text()).toBe('{"portable":true}');
    expect(current.service.exportAccountData).toHaveBeenCalledWith(principal, {
      idempotencyKey: "export-route-1",
    });
  });

  it("requires an authenticated actor before invoking account services", async () => {
    const current = fixture();
    current.actor.mockResolvedValue(null);
    const response = await createAccountDataExportHandler({
      ...current,
      nextRequestId: () => "request_account_unauthorized",
    })(new Request("https://reproforge.test/api/account/export"));

    expect(response.status).toBe(401);
    expect(current.service.exportAccountData).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
      requestId: "request_account_unauthorized",
    });
  });

  it("rejects cross-origin deletion before reading or mutating account data", async () => {
    const current = fixture();
    const response = await createAccountDeletionHandler({
      ...current,
      nextRequestId: () => "request_account_cross_origin",
    })(
      new Request("https://reproforge.test/api/account/delete", {
        body: JSON.stringify({ confirmation: ACCOUNT_DELETION_CONFIRMATION }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "delete-route-cross-origin",
          Origin: "https://attacker.invalid",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(current.actor).not.toHaveBeenCalled();
    expect(current.service.requestAccountDeletion).not.toHaveBeenCalled();
  });

  it("accepts explicit same-origin deletion and returns a stable receipt", async () => {
    const current = fixture();
    const response = await createAccountDeletionHandler({
      ...current,
      nextRequestId: () => "request_account_delete",
    })(
      new Request("https://reproforge.test/api/account/delete", {
        body: JSON.stringify({ confirmation: ACCOUNT_DELETION_CONFIRMATION }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "delete-route-1",
          Origin: "https://reproforge.test",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      data: {
        created: true,
        requestId: `delete_${"c".repeat(48)}`,
        status: "scheduled",
      },
      error: null,
      requestId: "request_account_delete",
      schemaVersion: "1.0",
    });
    expect(current.service.requestAccountDeletion).toHaveBeenCalledWith(
      principal,
      {
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        idempotencyKey: "delete-route-1",
      },
    );
  });

  it("maps internal account failures without reflecting provider details", async () => {
    const current = fixture();
    current.service.exportAccountData.mockRejectedValue(
      new AccountDataError(
        "ACCOUNT_EXPORT_UNAVAILABLE",
        "postgresql://operator:secret@example.invalid/db",
        true,
      ),
    );
    const response = await createAccountDataExportHandler({
      ...current,
      nextRequestId: () => "request_account_failure",
    })(
      new Request("https://reproforge.test/api/account/export", {
        headers: { "Idempotency-Key": "export-route-failure" },
      }),
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(body).toContain("ACCOUNT_EXPORT_UNAVAILABLE");
    expect(body).not.toContain("postgresql");
    expect(body).not.toContain("secret");
  });
});
