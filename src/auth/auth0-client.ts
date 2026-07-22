import "server-only";

import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { NextResponse } from "next/server";

import {
  WebAuthenticationConfigurationError,
  parseWebAuthenticationConfig,
  type WebAuthenticationConfig,
} from "@/config/web-auth";
import {
  projectWebAccount,
  resolveWebIdentity,
  type WebAccountView,
  type WebIdentity,
} from "@/auth/web-session";

let client: Auth0Client | undefined;
let config: WebAuthenticationConfig | undefined;
let failure: unknown;
let loaded = false;

function resolveClient(): {
  client: Auth0Client;
  config: WebAuthenticationConfig;
} {
  if (!loaded) {
    loaded = true;
    try {
      config = parseWebAuthenticationConfig(process.env);
      client = new Auth0Client({
        appBaseUrl: config.appBaseUrl,
        authorizationParameters: {
          audience: config.audience,
          scope: config.scopes.join(" "),
        },
        clientId: config.clientId,
        clientSecret: config.credentials.clientSecret,
        domain: config.domain,
        includeIdTokenHintInOIDCLogoutUrl: true,
        logoutStrategy: "oidc",
        secret: config.credentials.cookieSecret,
        session: {
          absoluteDuration: 8 * 60 * 60,
          cookie: {
            sameSite: "lax",
            secure: new URL(config.appBaseUrl).protocol === "https:",
          },
          inactivityDuration: 60 * 60,
          rolling: true,
        },
        signInReturnToPath: "/repositories",
      });
    } catch (error) {
      failure = error;
    }
  }
  if (failure) throw failure;
  return { client: client as Auth0Client, config: config as WebAuthenticationConfig };
}

export type WebSessionState =
  | { status: "signed_out" }
  | { account: WebAccountView; identity: WebIdentity; status: "signed_in" }
  | { status: "unconfigured" };

export async function getWebSessionState(): Promise<WebSessionState> {
  try {
    const resolved = resolveClient();
    const session = await resolved.client.getSession();
    if (!session) return { status: "signed_out" };
    const identity = resolveWebIdentity(
      session,
      resolved.config.tenantClaim,
      `https://${resolved.config.domain}/`,
    );
    return {
      account: projectWebAccount(identity),
      identity,
      status: "signed_in",
    };
  } catch (error) {
    if (error instanceof WebAuthenticationConfigurationError) {
      return { status: "unconfigured" };
    }
    throw error;
  }
}

export async function auth0Middleware(request: Request): Promise<Response> {
  try {
    return await resolveClient().client.middleware(request);
  } catch (error) {
    if (!(error instanceof WebAuthenticationConfigurationError)) throw error;
    if (new URL(request.url).pathname.startsWith("/auth/")) {
      return NextResponse.json(
        { error: "web_authentication_unavailable" },
        { headers: { "Cache-Control": "no-store" }, status: 503 },
      );
    }
    return NextResponse.next();
  }
}
