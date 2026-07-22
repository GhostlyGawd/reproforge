import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  deriveWebTenantId,
  resolveWebIdentity,
} from "@/auth/web-session";

const firstCharacter = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
);
const remainingCharacter = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:|-",
);
const subject = fc
  .tuple(
    firstCharacter,
    fc.array(remainingCharacter, { maxLength: 127 }),
  )
  .map(([first, rest]) => `${first}${rest.join("")}`);

describe("web session tenant derivation properties", () => {
  it("is deterministic, opaque, and identical to the missing-claim fallback", () => {
    fc.assert(
      fc.property(subject, (candidate) => {
        const tenantId = deriveWebTenantId(candidate);
        expect(tenantId).toMatch(/^tenant_[a-f0-9]{64}$/);
        expect(deriveWebTenantId(candidate)).toBe(tenantId);
        expect(
          resolveWebIdentity(
            {
              user: {
                iss: "https://tenant.example/",
                sub: candidate,
              },
            },
            "https://reproforge.example/tenant_id",
          ).tenantId,
        ).toBe(tenantId);
      }),
      { numRuns: 250 },
    );
  });
});
