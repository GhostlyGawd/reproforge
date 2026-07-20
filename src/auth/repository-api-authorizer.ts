import {
  AuthorizationError,
  resolveAuthorizedPrincipal,
} from "@/application/authorization";
import type { AccessTokenVerifier, ReproForgeOAuthScope } from "@/application/ports/auth";
import type {
  RepositoryApiAuthorization,
  RepositoryApiAuthorizer,
} from "@/application/ports/http-authorization";
import type { PrincipalDirectory } from "@/application/ports/identity";
import { OAuthVerificationError } from "@/auth/access-token-verifier";
import { buildBearerChallenge } from "@/auth/challenge";
import type { OAuthResourceConfig } from "@/config/oauth";

type Dependencies = {
  config: OAuthResourceConfig;
  directory: PrincipalDirectory;
  verifier: AccessTokenVerifier;
};

function denied(
  config: OAuthResourceConfig,
  error: unknown,
  requiredScopes: ReproForgeOAuthScope[],
): RepositoryApiAuthorization {
  if (
    (!(error instanceof AuthorizationError) &&
      !(error instanceof OAuthVerificationError)) ||
    (error instanceof OAuthVerificationError &&
      error.code === "VERIFICATION_UNAVAILABLE")
  ) {
    return {
      code: "AUTHORIZATION_UNAVAILABLE",
      message: "ReproForge authorization is temporarily unavailable",
      ok: false,
      status: 503,
    };
  }
  const insufficient =
    error instanceof AuthorizationError &&
    error.code === "INSUFFICIENT_SCOPE";
  const scopes = insufficient ? error.requiredScopes : requiredScopes;
  const message = insufficient
    ? "Additional ReproForge permission is required"
    : "Link your ReproForge account to continue";
  return {
    challenge: buildBearerChallenge(config, {
      description: message,
      error: insufficient ? "insufficient_scope" : "invalid_token",
      scopes,
    }),
    code: insufficient ? "INSUFFICIENT_SCOPE" : "AUTHENTICATION_REQUIRED",
    message,
    ok: false,
    status: insufficient ? 403 : 401,
  };
}

export function createRepositoryApiAuthorizer({
  config,
  directory,
  verifier,
}: Dependencies): RepositoryApiAuthorizer {
  return async (request, requiredScopes) => {
    try {
      const token = await verifier.verify(
        request.headers.get("authorization"),
      );
      const principal = await resolveAuthorizedPrincipal({
        directory,
        requiredScopes,
        token,
      });
      return {
        ok: true,
        principal: {
          callerId: principal.callerId,
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        },
      };
    } catch (error) {
      return denied(config, error, requiredScopes);
    }
  };
}
