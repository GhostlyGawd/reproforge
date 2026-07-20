import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  CaseServiceError,
  type CaseOperations,
} from "@/application/case-service";
import {
  bundleViewSchema,
  caseInputSchema,
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

const NO_AUTH = [{ type: "noauth" }] as const;

type ServerOptions = {
  callerId: string;
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
        text: "INTERNAL_ERROR: ReproForge could not complete the trusted operation",
      },
    ],
    isError: true as const,
    _meta: {
      reproforge: {
        error: {
          code: "INTERNAL_ERROR",
          message: "ReproForge could not complete the trusted operation",
          retryable: true,
        },
      },
    },
  };
}

function appMeta(options: {
  invoked: string;
  invoking: string;
  resource?: boolean;
  visibility: Array<"model" | "app">;
}) {
  return {
    securitySchemes: NO_AUTH,
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
  callerId,
  service,
}: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "reproforge", version: "0.2.0" },
    {
      instructions: [
        "ReproForge creates machine-checked reproduction proof.",
        "This release accepts only the trusted synthetic cli-spaces fixture.",
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
      title: "Start trusted reproduction",
      description:
        "Run ReproForge's bundled synthetic CLI-spaces fixture in the closed trusted runner. This tool cannot accept a repository URL, arbitrary command, credential, or customer code. Supply a stable idempotency key so a retry reuses the same case.",
      inputSchema: startReproductionInputSchema,
      outputSchema: reproductionViewSchema,
      annotations: START_ANNOTATIONS,
      _meta: appMeta({
        invoked: "Reproduction verified",
        invoking: "Running trusted reproduction",
        resource: true,
        visibility: ["model"],
      }),
    },
    async (input) => {
      try {
        const started = await service.startTrustedReproduction({
          budget: input.budget,
          callerId,
          idempotencyKey: input.idempotencyKey,
          sampleId: input.sampleId,
        });
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
    "get_reproduction",
    {
      title: "Get reproduction proof",
      description:
        "Read the current machine-evidence snapshot for a ReproForge case returned by start_reproduction. This is closed-world and does not access external repositories.",
      inputSchema: caseInputSchema,
      outputSchema: reproductionViewSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: appMeta({
        invoked: "Proof refreshed",
        invoking: "Refreshing proof",
        resource: true,
        visibility: ["model", "app"],
      }),
    },
    async ({ caseId }) => {
      try {
        const snapshot = await service.getReproduction({ callerId, caseId });
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
        "Export the content-addressed Repro Bundle for a verified case. The tool fails closed until machine evidence marks the case VERIFIED.",
      inputSchema: caseInputSchema,
      outputSchema: bundleViewSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: appMeta({
        invoked: "Bundle prepared",
        invoking: "Preparing Repro Bundle",
        visibility: ["model", "app"],
      }),
    },
    async ({ caseId }) => {
      try {
        const exported = await service.exportReproBundle({ callerId, caseId });
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
        return safeError(error);
      }
    },
  );

  return server;
}
