import { describe, expect, it } from "vitest";

import { applyWebSecurityHeaders } from "@/http/web-security-headers";

describe("hosted web security headers", () => {
  it("adds a closed production policy without changing the response", async () => {
    const response = applyWebSecurityHeaders(
      new Response("reproforge", {
        headers: { "Set-Cookie": "session=opaque; HttpOnly; Secure" },
        status: 202,
      }),
      { development: false, secureTransport: true },
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("reproforge");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    );
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("https:");
    expect(csp).not.toContain("*");
  });

  it("keeps localhost usable without weakening the production policy", () => {
    const response = applyWebSecurityHeaders(new Response(), {
      development: true,
      secureTransport: false,
    });

    expect(response.headers.has("strict-transport-security")).toBe(false);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).toContain("'unsafe-eval'");
  });
});
