import { z } from "zod";

import type { OAuthResourceConfig } from "@/config/oauth";

const protectedResourceSchema = z
  .object({
    authorization_servers: z.array(z.url()),
    bearer_methods_supported: z.array(z.string()),
    resource: z.url(),
    scopes_supported: z.array(z.string()),
  })
  .passthrough();

const authorizationServerMetadataSchema = z
  .object({
    authorization_endpoint: z.url(),
    client_id_metadata_document_supported: z.boolean().optional(),
    code_challenge_methods_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()).optional(),
    issuer: z.url(),
    jwks_uri: z.url(),
    registration_endpoint: z.url().optional(),
    response_types_supported: z.array(z.string()),
    token_endpoint: z.url(),
    token_endpoint_auth_methods_supported: z.array(z.string()),
  })
  .passthrough();

export type AuthorizationServerMetadata = z.infer<
  typeof authorizationServerMetadataSchema
>;

export type OAuthCompatibilityCheckId =
  | "authorization-endpoints"
  | "client-registration"
  | "issuer"
  | "pkce"
  | "protected-resource"
  | "response-flow"
  | "token-authentication";

export type OAuthProviderCompatibilityReport = {
  checks: Array<{
    id: OAuthCompatibilityCheckId;
    status: "fail" | "pass";
  }>;
  ok: boolean;
  registrationMethod: "cimd" | "dcr" | "none";
};

type CompatibilityInput = {
  config: OAuthResourceConfig;
  discovery: unknown;
  protectedResource: unknown;
};

function sameHttpsOrigin(value: string, expectedOrigin: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function evaluateOAuthProviderCompatibility({
  config,
  discovery,
  protectedResource,
}: CompatibilityInput): OAuthProviderCompatibilityReport {
  const checks: OAuthProviderCompatibilityReport["checks"] = [];
  const record = (id: OAuthCompatibilityCheckId, passes: boolean): void => {
    checks.push({ id, status: passes ? "pass" : "fail" });
  };

  const parsedResource = protectedResourceSchema.safeParse(protectedResource);
  record(
    "protected-resource",
    parsedResource.success &&
      parsedResource.data.resource === config.resource &&
      parsedResource.data.authorization_servers.includes(
        config.authorizationServer,
      ) &&
      parsedResource.data.bearer_methods_supported.includes("header") &&
      config.scopes.every((scope) =>
        parsedResource.data.scopes_supported.includes(scope),
      ),
  );

  const parsedDiscovery = authorizationServerMetadataSchema.safeParse(discovery);
  if (!parsedDiscovery.success) {
    record("issuer", false);
    record("authorization-endpoints", false);
    record("response-flow", false);
    record("pkce", false);
    record("token-authentication", false);
    record("client-registration", false);
    return { checks, ok: false, registrationMethod: "none" };
  }

  const metadata = parsedDiscovery.data;
  const authorizationOrigin = new URL(config.authorizationServer).origin;
  record("issuer", metadata.issuer === config.authorizationServer);
  record(
    "authorization-endpoints",
    [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]
      .every((value) => sameHttpsOrigin(value, authorizationOrigin)),
  );
  record(
    "response-flow",
    metadata.response_types_supported.includes("code") &&
      (metadata.grant_types_supported === undefined ||
        metadata.grant_types_supported.includes("authorization_code")),
  );
  record(
    "pkce",
    metadata.code_challenge_methods_supported.includes("S256"),
  );
  record(
    "token-authentication",
    metadata.token_endpoint_auth_methods_supported.some((method) =>
      ["none", "private_key_jwt"].includes(method),
    ),
  );

  const registrationMethod = metadata.client_id_metadata_document_supported
    ? "cimd"
    : metadata.registration_endpoint &&
        sameHttpsOrigin(metadata.registration_endpoint, authorizationOrigin)
      ? "dcr"
      : "none";
  record("client-registration", registrationMethod !== "none");

  return {
    checks,
    ok: checks.every((check) => check.status === "pass"),
    registrationMethod,
  };
}
