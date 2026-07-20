import type { OAuthResourceConfig } from "@/config/oauth";

export const protectedResourceMetadataPath =
  "/.well-known/oauth-protected-resource" as const;

export type ProtectedResourceMetadata = {
  authorization_servers: string[];
  bearer_methods_supported: ["header"];
  resource: string;
  resource_name: "ReproForge";
  scopes_supported: string[];
};

export function buildProtectedResourceMetadata(
  config: OAuthResourceConfig,
): ProtectedResourceMetadata {
  return {
    authorization_servers: [config.authorizationServer],
    bearer_methods_supported: ["header"],
    resource: config.resource,
    resource_name: "ReproForge",
    scopes_supported: [...config.scopes],
  };
}

export function createProtectedResourceMetadataHandler(
  loadConfig: () => OAuthResourceConfig,
) {
  return function GET(): Response {
    try {
      return Response.json(buildProtectedResourceMetadata(loadConfig()), {
        headers: {
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return Response.json(
        {
          error: "oauth_configuration_unavailable",
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
          status: 503,
        },
      );
    }
  };
}
