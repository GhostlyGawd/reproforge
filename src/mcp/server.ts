import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  AuthorizationError,
  resolveAuthorizedPrincipal,
  type AuthorizedPrincipal,
} from "@/application/authorization";
import {
  CaseServiceError,
  type CaseOperations,
} from "@/application/case-service";
import type {
  AccessTokenVerifier,
  ReproForgeOAuthScope,
} from "@/application/ports/auth";
import type { PrincipalDirectory } from "@/application/ports/identity";
import type {
  RepositoryOperations,
  RepositorySource,
} from "@/application/repository-operations";
import { TRUSTED_SAMPLE_CALLER_ID } from "@/application/trusted-sample-identity";
import { OAuthVerificationError } from "@/auth/access-token-verifier";
import { buildBearerChallenge } from "@/auth/challenge";
import type { OAuthResourceConfig } from "@/config/oauth";
import {
  bundleViewSchema,
  cancellationViewSchema,
  cancelReproductionInputSchema,
  caseInputSchema,
  listAuthorizedRepositoriesInputSchema,
  repositoryListViewSchema,
  reproductionViewSchema,
  startReproductionInputSchema,
  toBundleView,
  toReproductionView,
  toReproductionWidgetMeta,
} from "@/mcp/contracts";
import { createReproForgeWidgetHtml } from "@/mcp/widget";

export const REPROFORGE_WIDGET_URI = "ui://reproforge/proof-v1.html";

const READ_ONLY_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

const START_ANNOTATIONS = {
  ...READ_ONLY_ANNOTATIONS,
  readOnlyHint: false,
} as const;

const CANCEL_ANNOTATIONS = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
} as const;

type SecurityScheme =
  | { type: "noauth" }
  | { scopes: ReproForgeOAuthScope[]; type: "oauth2" };

const NO_AUTH: SecurityScheme = { type: "noauth" };

function oauth(...scopes: ReproForgeOAuthScope[]): SecurityScheme {
  return { scopes: [...new Set(scopes)].sort(), type: "oauth2" };
}

const CASES_READ = oauth("reproforge:cases:read");
const CASES_WRITE = oauth("reproforge:cases:write");
const BUNDLES_READ = oauth("reproforge:bundles:read");
const REPOSITORIES_READ = oauth("reproforge:repositories:read");
const REPOSITORY_START = oauth(
  "reproforge:cases:write",
  "reproforge:repositories:read",
);

export type McpAuthorizationDependencies = {
  authorizationHeader: string | null;
  config: OAuthResourceConfig;
  directory: PrincipalDirectory;
  verifier: AccessTokenVerifier;
};

type ServerOptions = {
  authorization?: McpAuthorizationDependencies;
  repositoryService?: RepositoryOperations;
  service: CaseOperations;
};

function safeError(error: unknown) {
  if (error instanceof CaseServiceError) {
    return {
      content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }],
      isError: true as const,
      _meta: {
        reproforge: {
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          },
        },
      },
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: "INTERNAL_ERROR: ReproForge could not complete the operation",
      },
    ],
    isError: true as const,
    _meta: {
      reproforge: {
        error: {
          code: "INTERNAL_ERROR",
          message: "ReproForge could not complete the operation",
          retryable: true,
        },
      },
    },
  };
}

function unavailableError() {
  return {
    content: [
      {
        type: "text" as const,
        text: "SERVICE_UNAVAILABLE: Repository operations are not configured",
      },
    ],
    isError: true as const,
    _meta: {
      reproforge: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Repository operations are not configured",
          retryable: true,
        },
      },
    },
  };
}

function authenticationError(
  config: OAuthResourceConfig,
  error: unknown,
  requiredScopes: ReproForgeOAuthScope[],
) {
  const insufficient =
    error instanceof AuthorizationError &&
    error.code === "INSUFFICIENT_SCOPE";
  const scopes = insufficient ? error.requiredScopes : requiredScopes;
  const challenge = buildBearerChallenge(config, {
    description: insufficient
      ? "Grant the additional ReproForge permission to continue"
      : "Link your ReproForge account to continue",
    error: insufficient ? "insufficient_scope" : "invalid_token",
    scopes,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: insufficient
          ? "AUTHORIZATION_REQUIRED: Additional ReproForge permission is required"
          : "AUTHENTICATION_REQUIRED: Link your ReproForge account to continue",
      },
    ],
    isError: true as const,
    _meta: {
      "mcp/www_authenticate": challenge,
      reproforge: {
        error: {
          code: insufficient ? "INSUFFICIENT_SCOPE" : "AUTHENTICATION_REQUIRED",
          message: insufficient
            ? "Additional ReproForge permission is required"
            : "Link your ReproForge account to continue",
          retryable: false,
        },
      },
    },
  };
}

async function authorize(
  dependencies: McpAuthorizationDependencies | undefined,
  requiredScopes: ReproForgeOAuthScope[],
): Promise<AuthorizedPrincipal> {
  if (!dependencies) {
    throw new OAuthVerificationError(
      "VERIFICATION_UNAVAILABLE",
      "OAuth verification is not configured",
    );
  }
  const token = await dependencies.verifier.verify(
    dependencies.authorizationHeader,
  );
  return resolveAuthorizedPrincipal({
    directory: dependencies.directory,
    requiredScopes,
    token,
  });
}

function appMeta(options: {
  invoked: string;
  invoking: string;
  resource?: boolean;
  securitySchemes: SecurityScheme[];
  visibility: Array<"model" | "app">;
}) {
  return {
    securitySchemes: options.securitySchemes,
    ui: {
      ...(options.resource ? { resourceUri: REPROFORGE_WIDGET_URI } : {}),
      visibility: options.visibility,
    },
    ...(options.resource
      ? {
          "openai/outputTemplate": REPROFORGE_WIDGET_URI,
          "openai/widgetAccessible": true,
        }
      : {}),
    "openai/toolInvocation/invoked": options.invoked,
    "openai/toolInvocation/invoking": options.invoking,
  };
}

export function createReproForgeMcpServer({
  authorization,
  repositoryService,
  service,
}: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "reproforge", version: "0.3.0" },
    {
      instructions: [
        "ReproForge creates machine-checked reproduction proof.",
        "The bundled cli-spaces fixture is trusted and keyless; GitHub repository sources require a linked account and authorized installation.",
        "Start once with start_reproduction, then use the returned caseId to read or export.",
        "Never claim verification unless the tool returns proof.status VERIFIED.",
      ].join(" "),
    },
  );

  registerAppResource(
    server,
    "ReproForge proof card",
    REPROFORGE_WIDGET_URI,
    {
      description: "Interactive, machine-evidence view for one ReproForge case.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          csp: {
            baseUriDomains: [],
            connectDomains: [],
            frameDomains: [],
            resourceDomains: [],
          },
          prefersBorder: true,
        },
        "openai/widgetCSP": {
          connect_domains: [],
          resource_domains: [],
        },
        "openai/widgetDescription":
          "Shows verified runs, the negative control, evidence lanes, hypotheses, and bundle files.",
        "openai/widgetPrefersBorder": true,
      },
    },
    async () => ({
      contents: [
        {
          uri: REPROFORGE_WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: createReproForgeWidgetHtml(),
          _meta: {
            ui: {
              csp: {
                baseUriDomains: [],
                connectDomains: [],
                frameDomains: [],
                resourceDomains: [],
              },
              prefersBorder: true,
            },
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: [],
            },
            "openai/widgetDescription":
              "Shows verified runs, the negative control, evidence lanes, hypotheses, and bundle files.",
            "openai/widgetPrefersBorder": true,
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "start_reproduction",
    {
      title: "Start reproduction",
      description:
        "Run the trusted synthetic fixture without an account, or start bounded work at an immutable commit from an authorized GitHub repository. Inputs never accept credentials, repository URLs, shell strings, or unrestricted network policy.",
      inputSchema: startReproductionInputSchema,
      outputSchema: reproductionViewSchema,
      annotations: START_ANNOTATIONS,
      _meta: appMeta({
        invoked: "Reproduction started",
        invoking: "Starting reproduction",
        resource: true,
        securitySchemes: [NO_AUTH, REPOSITORY_START],
        visibility: ["model"],
      }),
    },
    async (input) => {
      try {
        const started =
          input.source.kind === "trusted_sample"
            ? await service.startTrustedReproduction({
                budget: input.budget,
                callerId: TRUSTED_SAMPLE_CALLER_ID,
                idempotencyKey: input.idempotencyKey,
                sampleId: input.source.sampleId,
              })
            : await (async () => {
                let principal: AuthorizedPrincipal;
                try {
                  principal = await authorize(authorization, [
                    "reproforge:cases:write",
                    "reproforge:repositories:read",
                  ]);
                } catch (error) {
                  return { authorizationFailure: error } as const;
                }
                if (!repositoryService) return { unavailable: true } as const;
                return repositoryService.startRepositoryReproduction(
                  principal,
                  {
                    budget: input.budget,
                    idempotencyKey: input.idempotencyKey,
                    source: input.source as RepositorySource,
                  },
                );
              })();

        if ("authorizationFailure" in started) {
          return authenticationError(
            authorization?.config ?? oauthConfigUnavailable(),
            started.authorizationFailure,
            ["reproforge:cases:write", "reproforge:repositories:read"],
          );
        }
        if ("unavailable" in started) return unavailableError();
        const view = toReproductionView(started.snapshot);
        return {
          content: [
            {
              type: "text" as const,
              text:
                view.proof.status === "VERIFIED"
                  ? `Verified case ${view.caseId}: ${view.proof.candidateMatches}/${view.proof.requiredRuns} candidate runs matched and the negative control stayed clear.`
                  : `Case ${view.caseId} is ${view.caseState}; read it again before making a verification claim.`,
            },
          ],
          structuredContent: view,
          _meta: {
            reproforge: toReproductionWidgetMeta(
              started.snapshot,
              started.reused,
            ),
          },
        };
      } catch (error) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_authorized_repositories",
    {
      title: "List authorized repositories",
      description:
        "List sanitized repositories selected through the tenant's read-only GitHub App installation.",
      inputSchema: listAuthorizedRepositoriesInputSchema,
      outputSchema: repositoryListViewSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: appMeta({
        invoked: "Repositories listed",
        invoking: "Listing authorized repositories",
        securitySchemes: [REPOSITORIES_READ],
        visibility: ["model", "app"],
      }),
    },
    async (input) => {
      try {
        let principal: AuthorizedPrincipal;
        try {
          principal = await authorize(authorization, [
            "reproforge:repositories:read",
          ]);
        } catch (error) {
          return authenticationError(
            authorization?.config ?? oauthConfigUnavailable(),
            error,
            ["reproforge:repositories:read"],
          );
        }
        if (!repositoryService) return unavailableError();
        const listed = await repositoryService.listAuthorizedRepositories(
          principal,
          input,
        );
        const view = repositoryListViewSchema.parse({
          kind: "repository_list",
          nextCursor: listed.nextCursor,
          repositories: listed.repositories,
          schemaVersion: "1.0",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Listed ${view.repositories.length} authorized repositories.`,
            },
          ],
          structuredContent: view,
        };
      } catch (error) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_reproduction",
    {
      title: "Get reproduction proof",
      description:
        "Read current machine evidence for a trusted-sample case or an authenticated tenant case without revealing whether another tenant owns an identifier.",
      inputSchema: caseInputSchema,
      outputSchema: reproductionViewSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: appMeta({
        invoked: "Proof refreshed",
        invoking: "Refreshing proof",
        resource: true,
        securitySchemes: [NO_AUTH, CASES_READ],
        visibility: ["model", "app"],
      }),
    },
    async ({ caseId }) => {
      try {
        const snapshot = authorization?.authorizationHeader
          ? await (async () => {
              let principal: AuthorizedPrincipal;
              try {
                principal = await authorize(authorization, [
                  "reproforge:cases:read",
                ]);
              } catch (error) {
                return { authorizationFailure: error } as const;
              }
              if (!repositoryService) return { unavailable: true } as const;
              return repositoryService.getReproduction(principal, { caseId });
            })()
          : await service.getReproduction({
              callerId: TRUSTED_SAMPLE_CALLER_ID,
              caseId,
            });
        if ("authorizationFailure" in snapshot) {
          return authenticationError(
            authorization?.config ?? oauthConfigUnavailable(),
            snapshot.authorizationFailure,
            ["reproforge:cases:read"],
          );
        }
        if ("unavailable" in snapshot) return unavailableError();
        const view = toReproductionView(snapshot);
        return {
          content: [
            {
              type: "text" as const,
              text: `Case ${view.caseId} is ${view.caseState}; proof status is ${view.proof.status ?? "not ready"}.`,
            },
          ],
          structuredContent: view,
          _meta: { reproforge: toReproductionWidgetMeta(snapshot) },
        };
      } catch (error) {
        if (
          authorization &&
          !authorization.authorizationHeader &&
          error instanceof CaseServiceError &&
          error.code === "NOT_FOUND"
        ) {
          return authenticationError(authorization.config, error, [
            "reproforge:cases:read",
          ]);
        }
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "cancel_reproduction",
    {
      title: "Cancel reproduction",
      description:
        "Idempotently request cancellation for active work in the authenticated tenant.",
      inputSchema: cancelReproductionInputSchema,
      outputSchema: cancellationViewSchema,
      annotations: CANCEL_ANNOTATIONS,
      _meta: appMeta({
        invoked: "Cancellation recorded",
        invoking: "Cancelling reproduction",
        securitySchemes: [CASES_WRITE],
        visibility: ["model", "app"],
      }),
    },
    async ({ jobId }) => {
      try {
        let principal: AuthorizedPrincipal;
        try {
          principal = await authorize(authorization, [
            "reproforge:cases:write",
          ]);
        } catch (error) {
          return authenticationError(
            authorization?.config ?? oauthConfigUnavailable(),
            error,
            ["reproforge:cases:write"],
          );
        }
        if (!repositoryService) return unavailableError();
        const result = await repositoryService.cancelReproduction(principal, {
          jobId,
        });
        const view = cancellationViewSchema.parse({
          ...result,
          kind: "cancellation",
          schemaVersion: "1.0",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Cancellation ${view.disposition} for case ${view.caseId}.`,
            },
          ],
          structuredContent: view,
        };
      } catch (error) {
        return safeError(error);
      }
    },
  );

  registerAppTool(
    server,
    "export_repro_bundle",
    {
      title: "Export verified Repro Bundle",
      description:
        "Export a content-addressed Repro Bundle only after machine evidence marks the case VERIFIED.",
      inputSchema: caseInputSchema,
      outputSchema: bundleViewSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: appMeta({
        invoked: "Bundle prepared",
        invoking: "Preparing Repro Bundle",
        securitySchemes: [NO_AUTH, BUNDLES_READ],
        visibility: ["model", "app"],
      }),
    },
    async ({ caseId }) => {
      try {
        const exported = authorization?.authorizationHeader
          ? await (async () => {
              let principal: AuthorizedPrincipal;
              try {
                principal = await authorize(authorization, [
                  "reproforge:bundles:read",
                ]);
              } catch (error) {
                return { authorizationFailure: error } as const;
              }
              if (!repositoryService) return { unavailable: true } as const;
              return repositoryService.exportReproBundle(principal, { caseId });
            })()
          : await service.exportReproBundle({
              callerId: TRUSTED_SAMPLE_CALLER_ID,
              caseId,
            });
        if ("authorizationFailure" in exported) {
          return authenticationError(
            authorization?.config ?? oauthConfigUnavailable(),
            exported.authorizationFailure,
            ["reproforge:bundles:read"],
          );
        }
        if ("unavailable" in exported) return unavailableError();
        const view = toBundleView(exported);
        return {
          content: [
            {
              type: "text" as const,
              text: `Exported verified bundle ${view.bundleHash} with ${view.fileNames.length} portable files.`,
            },
          ],
          structuredContent: view,
          _meta: {
            reproforge: {
              bundle: exported.bundle,
              files: exported.files,
            },
          },
        };
      } catch (error) {
        if (
          authorization &&
          !authorization.authorizationHeader &&
          error instanceof CaseServiceError &&
          error.code === "NOT_FOUND"
        ) {
          return authenticationError(authorization.config, error, [
            "reproforge:bundles:read",
          ]);
        }
        return safeError(error);
      }
    },
  );

  return server;
}

function oauthConfigUnavailable(): OAuthResourceConfig {
  throw new OAuthVerificationError(
    "VERIFICATION_UNAVAILABLE",
    "OAuth challenge configuration is unavailable",
  );
}
