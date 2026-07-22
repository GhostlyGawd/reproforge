export const REPROFORGE_OAUTH_SCOPES = [
  "reproforge:account:delete",
  "reproforge:bundles:read",
  "reproforge:cases:read",
  "reproforge:cases:write",
  "reproforge:repositories:read",
] as const;

export type ReproForgeOAuthScope = (typeof REPROFORGE_OAUTH_SCOPES)[number];

export type VerifiedAccessToken = {
  expiresAt: number;
  issuer: string;
  scopes: ReproForgeOAuthScope[];
  subject: string;
  tenantId: string;
};

export interface AccessTokenVerifier {
  verify(authorization: string | null | undefined): Promise<VerifiedAccessToken>;
}
