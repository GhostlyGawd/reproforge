import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  artifactDescriptorSchema,
  auditEventSchema,
  jobLeaseSchema,
  queueMessageSchema,
} from "@/application/ports/production";

describe("production port properties", () => {
  it("rejects every additional queue payload field", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9_]{0,30}$/).filter(
          (key) =>
            !["caseId", "eventId", "jobId", "kind", "schemaVersion", "tenantId"].includes(
              key,
            ),
        ),
        fc.jsonValue(),
        (key, value) => {
          expect(() =>
            queueMessageSchema.parse({
              caseId: "case_1",
              eventId: "event_1",
              jobId: "job_1",
              kind: "reproduction.requested",
              schemaVersion: "1.0",
              tenantId: "tenant_1",
              [key]: value,
            }),
          ).toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("accepts leases exactly when expiration is after acquisition", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -86_400_000, max: 86_400_000 }),
        (deltaMilliseconds) => {
          const acquired = Date.parse("2026-07-19T20:00:00.000Z");
          const result = jobLeaseSchema.safeParse({
            acquiredAt: new Date(acquired).toISOString(),
            attempt: 1,
            expiresAt: new Date(acquired + deltaMilliseconds).toISOString(),
            jobId: "job_1",
            ownerId: "worker_1",
            tenantId: "tenant_1",
          });
          expect(result.success).toBe(deltaMilliseconds > 0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("binds every artifact key to its tenant, case, kind, and digest", () => {
    const digestArbitrary = fc
      .array(fc.constantFrom(..."0123456789abcdef"), {
        minLength: 64,
        maxLength: 64,
      })
      .map((characters) => characters.join(""));
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), digestArbitrary, (tenant, caseId, digest) => {
        const descriptor = {
          artifactId: "artifact_1",
          byteCount: 1,
          caseId: `case_${caseId}`,
          createdAt: "2026-07-19T20:00:00.000Z",
          kind: "bundle",
          objectKey: `tenants/tenant_${tenant}/cases/case_${caseId}/bundle/${digest}`,
          retentionUntil: "2026-07-20T20:00:00.000Z",
          sha256: digest,
          tenantId: `tenant_${tenant}`,
        } as const;
        expect(artifactDescriptorSchema.safeParse(descriptor).success).toBe(true);
        expect(
          artifactDescriptorSchema.safeParse({
            ...descriptor,
            objectKey: `tenants/other/cases/${descriptor.caseId}/bundle/${digest}`,
          }).success,
        ).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("rejects all credential-bearing audit metadata key families", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "authorization",
          "cookie",
          "credential",
          "password",
          "secret",
          "source",
          "token",
          "command",
        ),
        fc.string({ minLength: 1, maxLength: 64 }),
        (key, value) => {
          expect(
            auditEventSchema.safeParse({
              action: "case.read",
              actorId: "principal_1",
              eventId: "audit_1",
              metadata: { [`request_${key}`]: value },
              occurredAt: "2026-07-19T20:00:00.000Z",
              outcome: "success",
              targetId: "case_1",
              targetType: "case",
              tenantId: "tenant_1",
            }).success,
          ).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
