import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import { z } from "zod";

import {
  REPROFORGE_OAUTH_SCOPES,
  type AccessTokenVerifier,
  type ReproForgeOAuthScope,
  type VerifiedAccessToken,
} from "@/application/ports/auth";
import type { OAuthResourceConfig } from "@/config/oauth";

const discoverySchema = z
  .object({
    authorization_endpoint: z.url(),
    code_challenge_methods_supported: z.array(z.string()),
    issuer: z.url(),
    jwks_uri: z.url(),
    response_types_supported: z.array(z.string()),
    token_endpoint: z.url(),
    token_endpoint_auth_methods_supported: z.array(z.string()),
  })
  .passthrough();

const jwksSchema = z
  .object({
    keys: z.array(
      z
        .object({
          alg: z.string().optional(),
          kid: z.string().min(1),
          kty: z.string().min(1),
          use: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .strict();

type VerificationFailureCode =
  | "INVALID_TOKEN"
  | "MISSING_TOKEN"
  | "VERIFICATION_UNAVAILABLE";

export class OAuthVerificationError extends Error {
  constructor(
    readonly code: VerificationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "OAuthVerificationError";
  }
}

type VerifierOptions = {
  cacheTtlMs?: number;
  config: OAuthResourceConfig;
  fetcher?: typeof fetch;
  now?: () => Date;
};

type CachedTrustMaterial = {
  fetchedAt: number;
  jwks: JWK[];
};

function parseBearerCredential(
  authorization: string | null | undefined,
): string {
  if (!authorization) {
    throw new OAuthVerificationError("MISSING_TOKEN", "A bearer token is required");
  }
  const match = /^Bearer ([A-Za-z0-9_\-.]+)$/i.exec(authorization.trim());
  if (!match?.[1]) {
    throw new OAuthVerificationError("INVALID_TOKEN", "The bearer token is malformed");
  }
  return match[1];
}

function requireSameHttpsOrigin(value: string, expectedOrigin: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== expectedOrigin) {
    throw new OAuthVerificationError(
      "VERIFICATION_UNAVAILABLE",
      "Authorization server discovery is not trusted",
    );
  }
  return url;
}

function validateDiscovery(
  input: unknown,
  config: OAuthResourceConfig,
): z.infer<typeof discoverySchema> {
  const result = discoverySchema.safeParse(input);
  if (!result.success || result.data.issuer !== config.authorizationServer) {
    throw new OAuthVerificationError(
      "VERIFICATION_UNAVAILABLE",
      "Authorization server discovery is invalid",
    );
  }
  const origin = new URL(config.authorizationServer).origin;
  requireSameHttpsOrigin(result.data.authorization_endpoint, origin);
  requireSameHttpsOrigin(result.data.token_endpoint, origin);
  requireSameHttpsOrigin(result.data.jwks_uri, origin);
  if (
    !result.data.response_types_supported.includes("code") ||
    !result.data.code_challenge_methods_supported.includes("S256") ||
    !result.data.token_endpoint_auth_methods_supported.some((method) =>
      ["none", "private_key_jwt"].includes(method),
    )
  ) {
    throw new OAuthVerificationError(
      "VERIFICATION_UNAVAILABLE",
      "Authorization server capabilities are incompatible",
    );
  }
  return result.data;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new OAuthVerificationError(
      "VERIFICATION_UNAVAILABLE",
      "Authorization server metadata is unavailable",
    );
  }
  return response.json();
}

function toVerifiedIdentity(
  payload: JWTPayload,
  config: OAuthResourceConfig,
): VerifiedAccessToken {
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const tenant = payload[config.tenantClaim];
  const tenantId = typeof tenant === "string" ? tenant.trim() : "";
  const expiresAt = payload.exp;
  const rawScope = payload.scope;
  if (
    !subject ||
    !tenantId ||
    typeof expiresAt !== "number" ||
    typeof rawScope !== "string"
  ) {
    throw new OAuthVerificationError(
      "INVALID_TOKEN",
      "The bearer token is missing required claims",
    );
  }
  const supported = new Set<string>(REPROFORGE_OAUTH_SCOPES);
  const scopes = [...new Set(rawScope.split(/\s+/).filter(Boolean))]
    .filter((scope): scope is ReproForgeOAuthScope => supported.has(scope))
    .sort();
  if (scopes.length === 0) {
    throw new OAuthVerificationError(
      "INVALID_TOKEN",
      "The bearer token has no ReproForge scope",
    );
  }
  return {
    expiresAt,
    issuer: config.authorizationServer,
    scopes,
    subject,
    tenantId,
  };
}

export function createJwtAccessTokenVerifier({
  cacheTtlMs = 5 * 60 * 1_000,
  config,
  fetcher = fetch,
  now = () => new Date(),
}: VerifierOptions): AccessTokenVerifier {
  let cached: CachedTrustMaterial | undefined;

  async function fetchTrustMaterial(): Promise<CachedTrustMaterial> {
    const discovery = validateDiscovery(
      await readJson(
        await fetcher(config.discoveryUrl, {
          headers: { Accept: "application/json" },
        }),
      ),
      config,
    );
    const jwksResult = jwksSchema.safeParse(
      await readJson(
        await fetcher(discovery.jwks_uri, {
          headers: { Accept: "application/json" },
        }),
      ),
    );
    if (!jwksResult.success || jwksResult.data.keys.length === 0) {
      throw new OAuthVerificationError(
        "VERIFICATION_UNAVAILABLE",
        "Authorization server signing keys are invalid",
      );
    }
    cached = {
      fetchedAt: now().getTime(),
      jwks: jwksResult.data.keys as JWK[],
    };
    return cached;
  }

  async function trustMaterial(forceRefresh = false): Promise<CachedTrustMaterial> {
    if (
      forceRefresh ||
      !cached ||
      now().getTime() - cached.fetchedAt >= cacheTtlMs
    ) {
      return fetchTrustMaterial();
    }
    return cached;
  }

  async function signingKey(token: string): Promise<CryptoKey | Uint8Array> {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
      throw new OAuthVerificationError(
        "INVALID_TOKEN",
        "The bearer token signing algorithm is not allowed",
      );
    }
    let material = await trustMaterial();
    let jwk = material.jwks.find(
      (candidate) =>
        candidate.kid === header.kid &&
        (!candidate.alg || candidate.alg === "RS256") &&
        (!candidate.use || candidate.use === "sig"),
    );
    if (!jwk) {
      material = await trustMaterial(true);
      jwk = material.jwks.find(
        (candidate) =>
          candidate.kid === header.kid &&
          (!candidate.alg || candidate.alg === "RS256") &&
          (!candidate.use || candidate.use === "sig"),
      );
    }
    if (!jwk) {
      throw new OAuthVerificationError(
        "INVALID_TOKEN",
        "The bearer token signing key is not trusted",
      );
    }
    return (await importJWK(jwk, "RS256")) as CryptoKey | Uint8Array;
  }

  return {
    async verify(authorization): Promise<VerifiedAccessToken> {
      try {
        const token = parseBearerCredential(authorization);
        const key = await signingKey(token);
        const verified = await jwtVerify(token, key, {
          algorithms: ["RS256"],
          audience: config.resource,
          currentDate: now(),
          issuer: config.authorizationServer,
          requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
        });
        return toVerifiedIdentity(verified.payload, config);
      } catch (error) {
        if (error instanceof OAuthVerificationError) throw error;
        throw new OAuthVerificationError(
          "INVALID_TOKEN",
          "The bearer token could not be verified",
        );
      }
    },
  };
}
