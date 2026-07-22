import { describe, expect, it, vi } from "vitest";

import { createGitHubServiceRegistry } from "@/github/service-registry";

describe("GitHub service registry", () => {
  it("keeps authorization available when execution composition fails", async () => {
    const authorization = { kind: "authorization" } as const;
    const executionFailure = new Error("synthetic execution dependency failure");
    const createAuthorization = vi.fn(async () => authorization);
    const createRuntime = vi.fn(async () => Promise.reject(executionFailure));
    const registry = createGitHubServiceRegistry({
      createAuthorization,
      createRuntime,
    });

    await expect(registry.getRuntimeServices()).rejects.toBe(executionFailure);
    await expect(registry.getAuthorizationServices()).resolves.toBe(authorization);
    await expect(registry.getAuthorizationServices()).resolves.toBe(authorization);

    expect(createAuthorization).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith(authorization);
  });

  it("memoizes authorization and execution independently", async () => {
    const authorization = { kind: "authorization" } as const;
    const runtime = { kind: "runtime" } as const;
    const createAuthorization = vi.fn(async () => authorization);
    const createRuntime = vi.fn(async () => runtime);
    const registry = createGitHubServiceRegistry({
      createAuthorization,
      createRuntime,
    });

    const [firstAuthorization, secondAuthorization, firstRuntime, secondRuntime] =
      await Promise.all([
        registry.getAuthorizationServices(),
        registry.getAuthorizationServices(),
        registry.getRuntimeServices(),
        registry.getRuntimeServices(),
      ]);

    expect(firstAuthorization).toBe(authorization);
    expect(secondAuthorization).toBe(authorization);
    expect(firstRuntime).toBe(runtime);
    expect(secondRuntime).toBe(runtime);
    expect(createAuthorization).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });
});
