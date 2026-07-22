import type { ReproForgeOAuthScope } from "@/application/ports/auth";
import type { RepositoryPrincipal } from "@/application/ports/repository-source";

export type RepositoryApiAuthorization =
  | { ok: true; principal: RepositoryPrincipal }
  | {
      challenge?: string;
      code:
        | "AUTHENTICATION_REQUIRED"
        | "AUTHORIZATION_UNAVAILABLE"
        | "INSUFFICIENT_SCOPE";
      message: string;
      ok: false;
      status: 401 | 403 | 503;
    };

export type RepositoryApiAuthorizer = (
  request: Request,
  scopes: ReproForgeOAuthScope[],
) => Promise<RepositoryApiAuthorization>;
