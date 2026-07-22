import {
  REPROFORGE_OAUTH_SCOPES,
  type ReproForgeOAuthScope,
  type VerifiedAccessToken,
} from "@/application/ports/auth";
import type { PrincipalDirectory } from "@/application/ports/identity";

export type AuthorizedPrincipal = VerifiedAccessToken & {
  callerId: string;
  principalId: string;
};

export type AuthorizationErrorCode =
  | "INSUFFICIENT_SCOPE"
  | "INVALID_PRINCIPAL";

export class AuthorizationError extends Error {
  constructor(
    readonly code: AuthorizationErrorCode,
    readonly requiredScopes: ReproForgeOAuthScope[],
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

type ResolveAuthorizedPrincipalInput = {
  directory: PrincipalDirectory;
  requiredScopes: ReproForgeOAuthScope[];
  token: VerifiedAccessToken;
};

function canonicalRequiredScopes(
  scopes: ReproForgeOAuthScope[],
): ReproForgeOAuthScope[] {
  const supported = new Set<string>(REPROFORGE_OAUTH_SCOPES);
  if (scopes.length === 0 || scopes.some((scope) => !supported.has(scope))) {
    throw new Error("Authorization policy requires supported scopes");
  }
  return [...new Set(scopes)].sort();
}

export async function resolveAuthorizedPrincipal({
  directory,
  requiredScopes: rawRequiredScopes,
  token,
}: ResolveAuthorizedPrincipalInput): Promise<AuthorizedPrincipal> {
  const requiredScopes = canonicalRequiredScopes(rawRequiredScopes);
  const mapped = await directory.resolve({
    issuer: token.issuer,
    subject: token.subject,
  });
  if (
    !mapped ||
    mapped.status !== "ACTIVE" ||
    mapped.tenantId !== token.tenantId
  ) {
    throw new AuthorizationError(
      "INVALID_PRINCIPAL",
      [],
      "The linked ReproForge principal is unavailable",
    );
  }
  const granted = new Set(token.scopes);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new AuthorizationError(
      "INSUFFICIENT_SCOPE",
      missing,
      "Additional ReproForge permission is required",
    );
  }
  return {
    ...token,
    callerId: mapped.principalId,
    principalId: mapped.principalId,
    tenantId: mapped.tenantId,
  };
}
