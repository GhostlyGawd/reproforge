import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  artifactDescriptorSchema,
  auditEventSchema,
  jobLeaseSchema,
  queueMessageSchema,
  type ArtifactStore,
  type AuditSink,
  type DurableReproductionRepository,
  type JobQueue,
  type Outbox,
  type QuotaLedger,
  type TransactionPorts,
  type UnitOfWork,
} from "@/application/ports/production";

describe("production ports", () => {
  it("keeps queue messages identifier-only and strict", () => {
    const parsed = queueMessageSchema.parse({
      caseId: "case_1",
      eventId: "event_1",
      jobId: "job_1",
      kind: "reproduction.requested",
      schemaVersion: "1.0",
      tenantId: "tenant_1",
    });

    expect(parsed.kind).toBe("reproduction.requested");
    expect(() =>
      queueMessageSchema.parse({
        ...parsed,
        source: "private repository body",
        token: "synthetic-secret",
      }),
    ).toThrow();
  });

  it("requires content-addressed private artifact descriptors", () => {
    expect(
      artifactDescriptorSchema.parse({
        artifactId: "artifact_1",
        byteCount: 42,
        caseId: "case_1",
        createdAt: "2026-07-19T20:00:00.000Z",
        kind: "bundle",
        objectKey: "tenants/tenant_1/cases/case_1/bundle/" + "a".repeat(64),
        retentionUntil: "2026-08-18T20:00:00.000Z",
        sha256: "a".repeat(64),
        tenantId: "tenant_1",
      }),
    ).toMatchObject({ byteCount: 42, kind: "bundle" });
    expect(() =>
      artifactDescriptorSchema.parse({
        artifactId: "artifact_1",
        byteCount: 42,
        caseId: "case_1",
        createdAt: "2026-07-19T20:00:00.000Z",
        kind: "bundle",
        objectKey: "public/bundle.zip",
        retentionUntil: "2026-08-18T20:00:00.000Z",
        sha256: "not-a-digest",
        tenantId: "tenant_1",
      }),
    ).toThrow();
  });

  it("requires forward-only leases and secret-free flat audit metadata", () => {
    expect(() =>
      jobLeaseSchema.parse({
        acquiredAt: "2026-07-19T20:01:00.000Z",
        attempt: 1,
        expiresAt: "2026-07-19T20:00:00.000Z",
        jobId: "job_1",
        ownerId: "worker_1",
        tenantId: "tenant_1",
      }),
    ).toThrow();
    expect(() =>
      auditEventSchema.parse({
        action: "case.read",
        actorId: "principal_1",
        eventId: "audit_1",
        metadata: { access_token: "synthetic-secret" },
        occurredAt: "2026-07-19T20:00:00.000Z",
        outcome: "success",
        targetId: "case_1",
        targetType: "case",
        tenantId: "tenant_1",
      }),
    ).toThrow();
  });

  it("composes transaction-scoped and external production ports", async () => {
    const reproductions = {} as DurableReproductionRepository;
    const outbox = {} as Outbox;
    const quotas = {} as QuotaLedger;
    const audit = {} as AuditSink;
    const transaction: TransactionPorts = {
      audit,
      outbox,
      quotas,
      reproductions,
    };
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(transaction),
    };
    const artifacts = {} as ArtifactStore;
    const queue = {} as JobQueue;

    await expect(unitOfWork.run(async (ports) => ports)).resolves.toBe(transaction);
    expect(artifacts).toBeDefined();
    expect(queue).toBeDefined();
  });

  it("keeps provider SDK imports outside application and domain modules", () => {
    const collectTypeScript = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return collectTypeScript(path);
        return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
      });
    const files = [
      ...collectTypeScript(resolve("src/application")),
      ...collectTypeScript(resolve("src/domain")),
    ];
    const forbidden = [
      "@auth0/",
      "@neondatabase/",
      "@octokit/",
      "@vercel/blob",
      "@vercel/queue",
      "@vercel/sandbox",
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const packageName of forbidden) {
        expect(source, `${file} imports ${packageName}`).not.toContain(packageName);
      }
    }
  });
});
