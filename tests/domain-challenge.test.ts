import { describe, expect, it } from "vitest";

import {
  createDomainChallengeHandler,
  parseDomainChallengeToken,
} from "@/http/domain-challenge";

describe("OpenAI Apps domain challenge", () => {
  it("is absent until a portal challenge is explicitly configured", async () => {
    const response = createDomainChallengeHandler(() => null)();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("returns only the exact configured token without caching", async () => {
    const token = "openai-verification-token_1234567890";
    const response = createDomainChallengeHandler(() => token)();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(token);
  });

  it.each(["short", "contains whitespace", "line\nbreak"])(
    "rejects malformed challenge value %s",
    (token) => {
      expect(() =>
        parseDomainChallengeToken({ OPENAI_APPS_CHALLENGE_TOKEN: token }),
      ).toThrowError("Invalid OpenAI Apps challenge token");
    },
  );
});
