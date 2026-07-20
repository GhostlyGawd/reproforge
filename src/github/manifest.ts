import { z } from "zod";

const inputSchema = z
  .object({
    baseUrl: z.url().transform((value) => new URL(value)),
    name: z.string().min(1).max(100),
  })
  .strict();

export type GitHubAppManifest = ReturnType<typeof createGitHubAppManifest>;

export function createGitHubAppManifest(input: {
  baseUrl: string;
  name: string;
}) {
  const parsed = inputSchema.parse(input);
  if (
    parsed.baseUrl.protocol !== "https:" ||
    parsed.baseUrl.pathname !== "/" ||
    parsed.baseUrl.username ||
    parsed.baseUrl.password ||
    parsed.baseUrl.search ||
    parsed.baseUrl.hash
  ) {
    throw new Error("GitHub App manifest requires a canonical HTTPS base URL");
  }
  const baseUrl = parsed.baseUrl.toString();
  return {
    callback_urls: [new URL("api/github/callback", baseUrl).toString()],
    default_events: ["installation", "installation_repositories"],
    default_permissions: {
      contents: "read",
      issues: "read",
      metadata: "read",
    },
    description:
      "Read-only source acquisition for machine-verified bug reproductions.",
    hook_attributes: {
      active: true,
      url: new URL("api/github/webhook", baseUrl).toString(),
    },
    name: parsed.name,
    public: false,
    request_oauth_on_install: true,
    setup_on_update: false,
    url: baseUrl,
  } as const;
}
