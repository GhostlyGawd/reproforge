import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { REPROFORGE_OAUTH_SCOPES } from "../src/application/ports/auth";
import { evaluateOAuthProviderCompatibility } from "../src/auth/oauth-provider-compatibility";
import type { OAuthResourceConfig } from "../src/config/oauth";

type Arguments = {
  authorizationServer: string;
  baseUrl: string;
  commit?: string;
  output?: string;
};

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function canonicalHttpsRoot(value: string, field: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(`${field} must be an HTTPS origin with a trailing slash`);
  }
  return url.toString();
}

function readArguments(): Arguments {
  const baseUrl = argumentValue("--base-url") ?? process.env.REPROFORGE_BASE_URL;
  const explicitAuthorizationServer =
    argumentValue("--authorization-server") ??
    (process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}/` : undefined);
  if (!baseUrl || !explicitAuthorizationServer) {
    throw new Error(
      "Provide --base-url and --authorization-server (or REPROFORGE_BASE_URL and AUTH0_DOMAIN)",
    );
  }
  return {
    authorizationServer: canonicalHttpsRoot(
      explicitAuthorizationServer,
      "authorization server",
    ),
    baseUrl: canonicalHttpsRoot(baseUrl, "base URL"),
    commit: argumentValue("--commit"),
    output: argumentValue("--output"),
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

async function main(): Promise<void> {
  const args = readArguments();
  const metadataUrl = new URL(
    ".well-known/oauth-protected-resource",
    args.baseUrl,
  ).toString();
  const discoveryUrl = new URL(
    ".well-known/openid-configuration",
    args.authorizationServer,
  ).toString();
  const config: OAuthResourceConfig = {
    authorizationServer: args.authorizationServer,
    baseUrl: args.baseUrl,
    discoveryUrl,
    metadataUrl,
    resource: new URL("mcp", args.baseUrl).toString(),
    scopes: REPROFORGE_OAUTH_SCOPES,
    tenantClaim: new URL("tenant_id", args.baseUrl).toString(),
  };

  const [protectedResource, discovery] = await Promise.all([
    fetchJson(metadataUrl),
    fetchJson(discoveryUrl),
  ]);
  const compatibility = evaluateOAuthProviderCompatibility({
    config,
    discovery,
    protectedResource,
  });
  const report = {
    authorizationServer: args.authorizationServer,
    baseUrl: args.baseUrl,
    capturedAt: new Date().toISOString(),
    commit: args.commit ?? null,
    discoveryUrl,
    metadataUrl,
    ...compatibility,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    const output = resolve(args.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, { encoding: "utf8", mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (!compatibility.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  process.stderr.write(`Hosted OAuth compatibility check failed: ${message}\n`);
  process.exitCode = 1;
});
