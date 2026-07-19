import { describe, expect, it } from "vitest";

import { outcomePresentation } from "@/presentation/outcome";

describe("outcome presentation", () => {
  it.each([
    ["VERIFIED", "Verified reproduction"],
    ["UNSTABLE", "Reproduction is unstable"],
    ["NOT_REPRODUCED", "Failure not reproduced"],
    ["BLOCKED", "Investigation blocked"],
  ] as const)("maps %s to an honest terminal heading", (status, heading) => {
    expect(outcomePresentation(status).heading).toBe(heading);
  });
});
