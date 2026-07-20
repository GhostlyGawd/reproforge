import "server-only";

import type { AccountDataService } from "@/application/account-data-service";
import type { TenantScope } from "@/application/ports/production";
import { getWebSessionState } from "@/auth/auth0-client";
import { getDefaultGitHubServices } from "@/github/default-services";

export type DefaultAccountContext =
  | { status: "signed_out" | "unconfigured" }
  | { scope: TenantScope; service: AccountDataService; status: "ready" };

export async function getDefaultAccountContext(): Promise<DefaultAccountContext> {
  const session = await getWebSessionState();
  if (session.status !== "signed_in") return { status: session.status };
  const services = await getDefaultGitHubServices();
  const actor = await services.webPrincipals.resolve(session.identity);
  return {
    scope: {
      callerId: actor.principalId,
      principalId: actor.principalId,
      tenantId: actor.tenantId,
    },
    service: services.accountData,
    status: "ready",
  };
}
