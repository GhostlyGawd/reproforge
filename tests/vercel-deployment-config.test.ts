import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const HOBBY_MAX_DURATION_SECONDS = 60;

describe("Vercel deployment contract", () => {
  it("keeps the queue consumer within the current Hobby duration ceiling", async () => {
    const config = JSON.parse(
      await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
    ) as {
      functions: Record<string, { maxDuration?: number }>;
    };
    const routeSource = await readFile(
      new URL(
        "../src/app/api/queues/reproductions/route.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(
      config.functions["src/app/api/queues/reproductions/route.ts"]
        ?.maxDuration,
    ).toBe(HOBBY_MAX_DURATION_SECONDS);
    expect(routeSource).toContain(
      `export const maxDuration = ${HOBBY_MAX_DURATION_SECONDS};`,
    );
  });
});
