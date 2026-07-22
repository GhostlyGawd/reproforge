import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const EXPECTED_EVIDENCED_APP_ID = "asdk_app_6a60145796108191a8ab9b93493e5491";

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(process.cwd(), relativePath), "utf8"));
}

describe("repository-local Codex plugin wrapper", () => {
  it("binds validated presentation metadata to the real ReproForge app", async () => {
    const plugin = await readJson("plugins/reproforge/.codex-plugin/plugin.json");
    const appManifest = await readJson("plugins/reproforge/.app.json");
    const hostGate = await readJson(
      "docs/evidence/chatgpt-host/chatgpt-host-gate.json",
    );

    expect(plugin).toMatchObject({
      apps: "./.app.json",
      name: "reproforge",
      version: "0.2.0",
      interface: {
        category: "Developer Tools",
        displayName: "ReproForge",
        privacyPolicyURL: "https://reproforge.vercel.app/privacy",
        termsOfServiceURL: "https://reproforge.vercel.app/terms",
        websiteURL: "https://reproforge.vercel.app",
      },
    });
    expect(plugin).not.toHaveProperty("license");

    const appId = (appManifest as {
      apps?: { reproforge?: { id?: string } };
    }).apps?.reproforge?.id;
    const evidencedAppId = (hostGate as {
      host?: { appId?: string };
    }).host?.appId;

    expect(appId).toMatch(/^asdk_app_[a-f0-9]{32}$/);
    expect(appId).toBe(EXPECTED_EVIDENCED_APP_ID);
    expect(appId).toBe(evidencedAppId);
    expect(JSON.stringify({ appManifest, plugin })).not.toContain("[TODO:");
  });
});
