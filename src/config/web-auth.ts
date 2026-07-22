import { z } from "zod";

export type WebAuthenticationEnvironment = Readonly<
  Record<string, string | undefined>
>;

const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const schema = z
  .object({
    appBaseUrl: z.url().transform((value) => new URL(value)),
    clientId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._~-]+$/),
    clientSecret: z.string().min(16).max(1024),
    cookieSecret: z.string().regex(/^[a-f0-9]{64}$/i),
    domain: z.string().min(1).max(253).regex(domainPattern),
    tenantClaim: z.url(),
  })
  .strict();

export type WebAuthenticationConfig = {
  appBaseUrl: string;
  audience: string;
  clientId: string;
  credentials: {
    clientSecret: string;
    cookieSecret: string;
  };
  domain: string;
  scopes: readonly string[];
  tenantClaim: string;
};

export type WebAuthenticationConfigSummary = {
  appBaseUrl: string;
  audience: string;
  clientConfigured: boolean;
  cookieHttpOnly: true;
  domain: string;
  sameSite: "lax";
  scopes: readonly string[];
};

export class WebAuthenticationConfigurationError extends Error {
  readonly code = "INVALID_WEB_AUTHENTICATION_CONFIGURATION" as const;

  constructor(readonly fields: string[]) {
    super(
      `Invalid web authentication configuration: ${[
        ...new Set(fields),
      ].sort().join(", ")}`,
    );
    this.name = "WebAuthenticationConfigurationError";
  }
}

function fieldNames(error: z.ZodError): string[] {
  const names: Record<string, string> = {
    appBaseUrl: "APP_BASE_URL",
    clientId: "AUTH0_CLIENT_ID",
    clientSecret: "AUTH0_CLIENT_SECRET",
    cookieSecret: "AUTH0_SECRET",
    domain: "AUTH0_DOMAIN",
    tenantClaim: "REPROFORGE_OAUTH_TENANT_CLAIM",
  };
  return error.issues.map(
    (issue) => names[String(issue.path[0])] ?? "WEB_AUTHENTICATION",
  );
}

function validateBaseUrl(url: URL): string {
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new WebAuthenticationConfigurationError(["APP_BASE_URL"]);
  }
  return url.toString();
}

function validateTenantClaim(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("not https");
    return url.toString();
  } catch {
    throw new WebAuthenticationConfigurationError([
      "REPROFORGE_OAUTH_TENANT_CLAIM",
    ]);
  }
}

export function parseWebAuthenticationConfig(
  environment: WebAuthenticationEnvironment,
): WebAuthenticationConfig {
  const parsed = schema.safeParse({
    appBaseUrl: environment.APP_BASE_URL,
    clientId: environment.AUTH0_CLIENT_ID,
    clientSecret: environment.AUTH0_CLIENT_SECRET,
    cookieSecret: environment.AUTH0_SECRET,
    domain: environment.AUTH0_DOMAIN,
    tenantClaim: environment.REPROFORGE_OAUTH_TENANT_CLAIM,
  });
  if (!parsed.success) {
    throw new WebAuthenticationConfigurationError(fieldNames(parsed.error));
  }
  const appBaseUrl = validateBaseUrl(parsed.data.appBaseUrl);
  const tenantClaim = validateTenantClaim(parsed.data.tenantClaim);
  return {
    appBaseUrl,
    audience: new URL("mcp", appBaseUrl).toString(),
    clientId: parsed.data.clientId,
    credentials: {
      clientSecret: parsed.data.clientSecret,
      cookieSecret: parsed.data.cookieSecret,
    },
    domain: parsed.data.domain,
    scopes: [
      "openid",
      "profile",
      "email",
      "reproforge:bundles:read",
      "reproforge:cases:read",
      "reproforge:cases:write",
      "reproforge:repositories:read",
    ],
    tenantClaim,
  };
}

export function summarizeWebAuthenticationConfig(
  config: WebAuthenticationConfig,
): WebAuthenticationConfigSummary {
  return {
    appBaseUrl: config.appBaseUrl,
    audience: config.audience,
    clientConfigured: true,
    cookieHttpOnly: true,
    domain: config.domain,
    sameSite: "lax",
    scopes: config.scopes,
  };
}
