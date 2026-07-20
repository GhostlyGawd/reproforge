import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createGitHubInstallationCallbackHandler,
  type GitHubInstallationVerifier,
} from "@/github/callback";
import {
  InMemoryGitHubInstallationStateStore,
  createGitHubInstallationAuthorization,
} from "@/github/installation-state";
import { createGitHubAppManifest } from "@/github/manifest";
import {
  createGitHubWebhookHandler,
  verifyGitHubWebhookSignature,
} from "@/github/webhook";

const actor = {
  principalId: "principal-alpha",
  tenantId: "tenant-alpha",
};
const now = new Date("2026-07-20T00:00:00.000Z");

describe("least-privilege GitHub App specification", () => {
  it("requests only read permissions and installation lifecycle events", () => {
    expect(
      createGitHubAppManifest({
        baseUrl: "https://reproforge.example",
        name: "ReproForge Development",
      }),
    ).toEqual({
      callback_urls: ["https://reproforge.example/api/github/callback"],
      default_events: ["installation", "installation_repositories"],
      default_permissions: {
        contents: "read",
        issues: "read",
        metadata: "read",
      },
      description:
        "Read-only source acquisition for machine-verified bug reproductions.",
      hook_attributes: {
        active: true,
        url: "https://reproforge.example/api/github/webhook",
      },
      name: "ReproForge Development",
      public: false,
      request_oauth_on_install: true,
      setup_on_update: false,
      url: "https://reproforge.example/",
    });
    const serialized = JSON.stringify(
      createGitHubAppManifest({
        baseUrl: "https://reproforge.example",
        name: "ReproForge Development",
      }),
    );
    expect(serialized).not.toMatch(/write|admin|actions|secret/i);
  });
});

describe("state-bound GitHub installation callback", () => {
  it("binds one verified installation to the initiating actor exactly once", async () => {
    const states = new InMemoryGitHubInstallationStateStore();
    const start = await createGitHubInstallationAuthorization({
      actor,
      appSlug: "reproforge-development",
      clock: { now: () => now },
      randomBytes: () => Buffer.alloc(32, 7),
      states,
    });
    expect(start.url).toBe(
      `https://github.com/apps/reproforge-development/installations/new?state=${start.state}`,
    );
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(states.snapshot())).not.toContain(start.state);
    expect(start.url).not.toMatch(/tenant-alpha|principal-alpha/);

    const verifier: GitHubInstallationVerifier = {
      verify: vi.fn(async () => ({
        accountId: 9001,
        accountLogin: "synthetic-owner",
        installationId: 7001,
        permissions: { contents: "read", issues: "read", metadata: "read" },
        repositorySelection: "selected",
      })),
    };
    const bind = vi.fn(async () => undefined);
    const handler = createGitHubInstallationCallbackHandler({
      actor: async () => actor,
      bind,
      clock: { now: () => new Date(now.getTime() + 60_000) },
      states,
      verifier,
    });
    const callbackUrl = new URL("https://reproforge.example/api/github/callback");
    callbackUrl.searchParams.set("code", "synthetic-github-code");
    callbackUrl.searchParams.set("installation_id", "7001");
    callbackUrl.searchParams.set("state", start.state);

    const accepted = await handler(new Request(callbackUrl));
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(
      "https://reproforge.example/repositories?github=connected",
    );
    expect(verifier.verify).toHaveBeenCalledWith({
      code: "synthetic-github-code",
      installationId: 7001,
    });
    expect(bind).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ installationId: 7001 }),
    );

    const replayed = await handler(new Request(callbackUrl));
    expect(replayed.status).toBe(303);
    expect(replayed.headers.get("location")).toBe(
      "https://reproforge.example/repositories?github=invalid",
    );
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("rejects actor mismatch and expiry before exchanging a code", async () => {
    const states = new InMemoryGitHubInstallationStateStore();
    const start = await createGitHubInstallationAuthorization({
      actor,
      appSlug: "reproforge-development",
      clock: { now: () => now },
      randomBytes: () => Buffer.alloc(32, 9),
      states,
    });
    const verifier: GitHubInstallationVerifier = { verify: vi.fn() };
    const callback = (state: string) =>
      new Request(
        `https://reproforge.example/api/github/callback?code=synthetic-code&installation_id=7001&state=${state}`,
      );

    const mismatch = createGitHubInstallationCallbackHandler({
      actor: async () => ({ ...actor, tenantId: "tenant-other" }),
      bind: vi.fn(),
      clock: { now: () => new Date(now.getTime() + 60_000) },
      states,
      verifier,
    });
    expect((await mismatch(callback(start.state))).headers.get("location")).toContain(
      "github=invalid",
    );
    expect(verifier.verify).not.toHaveBeenCalled();

    const expired = createGitHubInstallationCallbackHandler({
      actor: async () => actor,
      bind: vi.fn(),
      clock: { now: () => new Date(now.getTime() + 11 * 60_000) },
      states,
      verifier,
    });
    expect((await expired(callback(start.state))).headers.get("location")).toContain(
      "github=invalid",
    );
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});

describe("GitHub webhook trust boundary", () => {
  it("matches GitHub's published HMAC-SHA256 test vector", () => {
    expect(
      verifyGitHubWebhookSignature({
        body: new TextEncoder().encode("Hello, World!"),
        secret: "It's a Secret to Everybody",
        signature:
          "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      }),
    ).toBe(true);
  });

  it("verifies raw bytes and required delivery headers before processing", async () => {
    const secret = "synthetic-webhook-secret-with-enough-entropy";
    const body = JSON.stringify({
      action: "suspended",
      installation: { id: 7001, suspended_at: "2026-07-20T00:00:00Z" },
    });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const process = vi.fn(async () => "accepted" as const);
    const handler = createGitHubWebhookHandler({ process, secret });
    const response = await handler(
      new Request("https://reproforge.example/api/github/webhook", {
        body,
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
          "X-GitHub-Event": "installation",
          "X-Hub-Signature-256": signature,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    expect(process).toHaveBeenCalledWith({
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      event: "installation",
      payload: {
        action: "suspended",
        installation: { id: 7001, suspended_at: "2026-07-20T00:00:00Z" },
      },
    });
  });

  it.each([
    ["missing signature", {}],
    ["invalid signature", { "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` }],
    ["missing delivery", { "X-GitHub-Delivery": "" }],
    ["unsupported event", { "X-GitHub-Event": "push" }],
  ])("rejects %s without parsing or processing", async (_label, override) => {
    const secret = "synthetic-webhook-secret-with-enough-entropy";
    const body = "{not-json";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const process = vi.fn();
    const headers = {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "X-GitHub-Event": "installation",
      "X-Hub-Signature-256": signature,
      ...override,
    };
    if (_label === "missing signature") {
      delete (headers as Partial<typeof headers>)["X-Hub-Signature-256"];
    }
    const response = await createGitHubWebhookHandler({ process, secret })(
      new Request("https://reproforge.example/api/github/webhook", {
        body,
        headers,
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(process).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(body);
  });
});
