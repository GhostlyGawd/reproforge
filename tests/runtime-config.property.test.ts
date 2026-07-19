import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  RuntimeConfigurationError,
  parseRuntimeConfig,
  summarizeRuntimeConfig,
} from "@/config/runtime";

describe("runtime configuration properties", () => {
  it("never includes arbitrary provider credentials in the public summary", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (databaseSecret, blobSecret) => {
        const config = parseRuntimeConfig({
          BLOB_READ_WRITE_TOKEN: `blob-secret-${blobSecret}`,
          DATABASE_URL: `postgresql://user:db-secret-${databaseSecret}@reproforge.invalid/database`,
          REPROFORGE_BASE_URL: "https://reproforge.example",
          REPROFORGE_RUNTIME_MODE: "production",
        });
        const summary = JSON.stringify(summarizeRuntimeConfig(config));

        expect(summary).not.toContain(databaseSecret);
        expect(summary).not.toContain(blobSecret);
      }),
      { numRuns: 300 },
    );
  });

  it("rejects every generated unknown ReproForge-prefixed variable", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/),
        (suffix) => {
          const variable = `REPROFORGE_UNKNOWN_${suffix}`;
          expect(() =>
            parseRuntimeConfig({
              [variable]: "synthetic-value",
            }),
          ).toThrowError(RuntimeConfigurationError);
        },
      ),
      { numRuns: 300 },
    );
  });
});
