import { createHash } from "node:crypto";

import { z } from "zod";

import type { RepositoryPrincipal } from "@/application/ports/repository-source";
import type { RepositoryOperations } from "@/application/repository-operations";

const optionalInteger = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().int().positive().max(2_147_483_647).optional(),
);

const optionalTitle = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.string().min(1).max(256).optional(),
);

const formSchema = z
  .object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    controlScript: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/),
    expectedExitCode: z.coerce.number().int().min(-255).max(255),
    failureOutput: z.string().min(1).max(256),
    failureStream: z.enum(["stdout", "stderr"]),
    idempotencyKey: z.string().min(1).max(128),
    issueNumber: optionalInteger,
    issueTitle: optionalTitle,
    nodeVersion: z.enum(["22", "24"]),
    reproductionScript: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/),
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.issueTitle !== undefined && value.issueNumber === undefined) {
      context.addIssue({
        code: "custom",
        message: "issue title requires an issue number",
        path: ["issueNumber"],
      });
    }
  });

type Dependencies = {
  actor(): Promise<RepositoryPrincipal | null>;
  baseUrl: string;
  operations: Pick<RepositoryOperations, "startRepositoryReproduction">;
};

function redirect(baseUrl: string, path: string): Response {
  return new Response(null, {
    headers: {
      "Cache-Control": "no-store",
      Location: new URL(path, baseUrl).toString(),
    },
    status: 303,
  });
}

function validOrigin(request: Request, baseUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function validContentType(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/x-www-form-urlencoded") ?? false
  );
}

function oracleId(input: z.infer<typeof formSchema>): string {
  return `web-output-v1-${createHash("sha256")
    .update(
      JSON.stringify({
        expectedExitCode: input.expectedExitCode,
        failureOutput: input.failureOutput,
        failureStream: input.failureStream,
      }),
    )
    .digest("hex")
    .slice(0, 16)}`;
}

export function createWebRepositoryStartHandler(
  dependencies: Dependencies,
): (request: Request) => Promise<Response> {
  return async function POST(request: Request): Promise<Response> {
    if (!validOrigin(request, dependencies.baseUrl) || !validContentType(request)) {
      return redirect(dependencies.baseUrl, "/repositories?start=invalid");
    }
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isFinite(contentLength) || contentLength > 16_384) {
      return redirect(dependencies.baseUrl, "/repositories?start=invalid");
    }

    try {
      const actor = await dependencies.actor();
      if (!actor) {
        return redirect(
          dependencies.baseUrl,
          "/auth/login?returnTo=%2Frepositories",
        );
      }
      const parsed = formSchema.safeParse(
        Object.fromEntries(await request.formData()),
      );
      if (!parsed.success) {
        return redirect(dependencies.baseUrl, "/repositories?start=invalid");
      }
      const input = parsed.data;
      const started = await dependencies.operations.startRepositoryReproduction(
        actor,
        {
          budget: { maxToolCalls: 6, requiredRuns: 3 },
          idempotencyKey: input.idempotencyKey,
          source: {
            commitSha: input.commitSha,
            executionProfile: {
              controlScript: input.controlScript,
              ecosystem: "node",
              lockfile: "package-lock.json",
              nodeVersion: input.nodeVersion,
              packageManager: "npm",
              reproductionScript: input.reproductionScript,
            },
            failureOracle: {
              id: oracleId(input),
              root: {
                children: [
                  { expected: input.expectedExitCode, type: "exit_code" },
                  {
                    stream: input.failureStream,
                    type: "output_contains",
                    value: input.failureOutput,
                  },
                ],
                type: "all",
              },
              version: 1,
            },
            ...(input.issueNumber
              ? {
                  issueEvidence: {
                    number: input.issueNumber,
                    ...(input.issueTitle ? { title: input.issueTitle } : {}),
                  },
                }
              : {}),
            kind: "github",
            repositoryId: input.repositoryId,
          },
        },
      );
      return redirect(
        dependencies.baseUrl,
        `/cases/${encodeURIComponent(started.snapshot.case.id)}`,
      );
    } catch {
      return redirect(dependencies.baseUrl, "/repositories?start=unavailable");
    }
  };
}
