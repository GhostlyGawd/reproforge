import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/investigate/route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/investigate", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("investigation API", () => {
  it("defaults to a deterministic offline plan", async () => {
    const response = await POST(
      request({
        issue: "Spaced configuration paths fail.",
        repository: "fixture://cli-spaces",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "offline",
      model: "offline-fixture-v1",
    });
  });

  it("rejects unrecognized request fields", async () => {
    const response = await POST(
      request({
        issue: "Spaced configuration paths fail.",
        repository: "fixture://cli-spaces",
        unrestrictedCommand: "do-not-run",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("refuses live mode when credentials are absent", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const response = await POST(
      request({
        issue: "Spaced configuration paths fail.",
        mode: "live",
        repository: "fixture://cli-spaces",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Live GPT-5.6 investigation is not configured",
    });
  });
});
