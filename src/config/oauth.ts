import { z } from "zod";

import { REPROFORGE_OAUTH_SCOPES } from "@/application/ports/auth";

export type OAuthEnvironment = Readonly<Record<string, string | undefined>>;

const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "must be a hostname without a scheme or path",
  );

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const tenantClaimSchema = z
  .url()
  .refine(isHttpsUrl, "must use HTTPS")
  .refine(
    (value) => !["iss", "sub", "aud", "exp", "nbf", "iat", "scope"].includes(value),
    "must be a namespaced custom claim",
  );

const environmentSchema = z
  .object({
    authorizationDomain: domainSchema,
    baseUrl: z
      .url()
      .transform((value) => new URL(value))
      .refine((value) => value.protocol === "https:", "must use HTTPS")
      .refine(
        (value) => !value.username && !value.password,
        "must not contain credentials",
      ),
    tenantClaim: tenantClaimSchema,
  })
  .strict();

export type OAuthResourceConfig = {
  authorizationServer: string;
  baseUrl: string;
  discoveryUrl: string;
  metadataUrl: string;
  resource: string;
  scopes: readonly (typeof REPROFORGE_OAUTH_SCOPES)[number][];
  tenantClaim: string;
};

export class OAuthConfigurationError extends Error {
  readonly code = "INVALID_OAUTH_CONFIGURATION" as const;

  constructor(readonly fields: string[]) {
    super(`Invalid OAuth configuration: ${[...new Set(fields)].sort().join(", ")}`);
    this.name = "OAuthConfigurationError";
  }
}

function invalidFields(error: z.ZodError): string[] {
  const fieldNames: Record<string, string> = {
    authorizationDomain: "AUTH0_DOMAIN",
    baseUrl: "REPROFORGE_BASE_URL",
    tenantClaim: "REPROFORGE_OAUTH_TENANT_CLAIM",
  };
  return error.issues.map(
    (issue) => fieldNames[String(issue.path[0])] ?? "OAUTH_CONFIGURATION",
  );
}

function canonicalBaseUrl(url: URL): string {
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new OAuthConfigurationError(["REPROFORGE_BASE_URL"]);
  }
  return url.toString();
}

export function parseOAuthResourceConfig(
  environment: OAuthEnvironment,
): OAuthResourceConfig {
  const parsed = environmentSchema.safeParse({
    authorizationDomain: environment.AUTH0_DOMAIN,
    baseUrl: environment.REPROFORGE_BASE_URL,
    tenantClaim: environment.REPROFORGE_OAUTH_TENANT_CLAIM,
  });
  if (!parsed.success) {
    throw new OAuthConfigurationError(invalidFields(parsed.error));
  }

  const baseUrl = canonicalBaseUrl(parsed.data.baseUrl);
  const authorizationServer = `https://${parsed.data.authorizationDomain}/`;
  return {
    authorizationServer,
    baseUrl,
    discoveryUrl: new URL(
      ".well-known/openid-configuration",
      authorizationServer,
    ).toString(),
    metadataUrl: new URL(
      ".well-known/oauth-protected-resource",
      baseUrl,
    ).toString(),
    resource: new URL("mcp", baseUrl).toString(),
    scopes: REPROFORGE_OAUTH_SCOPES,
    tenantClaim: parsed.data.tenantClaim,
  };
}

export function createOAuthResourceConfigLoader(
  readEnvironment: () => OAuthEnvironment,
): () => OAuthResourceConfig {
  let loaded = false;
  let config: OAuthResourceConfig | undefined;
  let failure: unknown;
  return () => {
    if (!loaded) {
      loaded = true;
      try {
        config = parseOAuthResourceConfig(readEnvironment());
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
    return config as OAuthResourceConfig;
  };
}

export const getOAuthResourceConfig = createOAuthResourceConfigLoader(
  () => process.env,
);
