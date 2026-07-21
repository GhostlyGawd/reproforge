export type GitHubRuntimeFailureOperation =
  | "install"
  | "list-repositories";

type StableGitHubRuntimeFailureCode =
  | "GITHUB_DEPENDENCY_UNAVAILABLE"
  | "GITHUB_RUNTIME_UNAVAILABLE"
  | "INVALID_GITHUB_CONFIGURATION"
  | "INVALID_RUNTIME_CONFIGURATION"
  | "WEB_PRINCIPAL_UNAVAILABLE";

type FailureSink = Readonly<{ error(line: string): void }>;

const stableCodes = new Set<StableGitHubRuntimeFailureCode>([
  "GITHUB_RUNTIME_UNAVAILABLE",
  "INVALID_GITHUB_CONFIGURATION",
  "INVALID_RUNTIME_CONFIGURATION",
  "WEB_PRINCIPAL_UNAVAILABLE",
]);

function stableFailureCode(error: unknown): StableGitHubRuntimeFailureCode {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "GITHUB_DEPENDENCY_UNAVAILABLE";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
    stableCodes.has(code as StableGitHubRuntimeFailureCode)
    ? (code as StableGitHubRuntimeFailureCode)
    : "GITHUB_DEPENDENCY_UNAVAILABLE";
}

export function createGitHubRuntimeFailureReporter(
  options: {
    clock?: { now(): Date };
    sink?: FailureSink;
  } = {},
) {
  const clock = options.clock ?? { now: () => new Date() };
  const sink = options.sink ?? console;

  return function reportGitHubRuntimeFailure(
    operation: GitHubRuntimeFailureOperation,
    error: unknown,
  ): void {
    sink.error(
      JSON.stringify({
        at: clock.now().toISOString(),
        code: stableFailureCode(error),
        event: "github.runtime.failure",
        operation,
        schemaVersion: "1.0",
      }),
    );
  };
}

export const reportGitHubRuntimeFailure =
  createGitHubRuntimeFailureReporter();
