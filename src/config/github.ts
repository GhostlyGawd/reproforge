import { z } from "zod";

import { isGitHubAppPrivateKey } from "@/github/private-key";

export type GitHubEnvironment = Readonly<Record<string, string | undefined>>;

const schema = z
  .object({
    appId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    appSlug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/),
    baseUrl: z.url().transform((value) => new URL(value)),
    clientId: z.string().min(8).max(255).regex(/^[A-Za-z0-9._~-]+$/),
    clientSecret: z.string().min(20).max(512),
    privateKey: z
      .string()
      .min(256)
      .max(32_768)
      .refine(
        isGitHubAppPrivateKey,
        "must be an RSA private key in PKCS#1 or PKCS#8 PEM format",
      ),
    webhookSecret: z.string().min(32).max(1024),
  })
  .strict();

export type GitHubConfig = {
  apiBaseUrl: "https://api.github.com/";
  appId: string;
  appSlug: string;
  baseUrl: string;
  clientId: string;
  credentials: {
    clientSecret: string;
    privateKey: string;
    webhookSecret: string;
  };
};

export type GitHubConfigSummary = {
  apiBaseUrl: GitHubConfig["apiBaseUrl"];
  appId: string;
  appSlug: string;
  baseUrl: string;
  clientConfigured: true;
  privateKeyConfigured: true;
  webhookConfigured: true;
};

export class GitHubConfigurationError extends Error {
  readonly code = "INVALID_GITHUB_CONFIGURATION" as const;

  constructor(readonly fields: string[]) {
    super(
      `Invalid GitHub App configuration: ${[...new Set(fields)].sort().join(", ")}`,
    );
    this.name = "GitHubConfigurationError";
  }
}

const fieldNames: Record<string, string> = {
  appId: "GITHUB_APP_ID",
  appSlug: "GITHUB_APP_SLUG",
  baseUrl: "REPROFORGE_BASE_URL",
  clientId: "GITHUB_APP_CLIENT_ID",
  clientSecret: "GITHUB_APP_CLIENT_SECRET",
  privateKey: "GITHUB_APP_PRIVATE_KEY",
  webhookSecret: "GITHUB_WEBHOOK_SECRET",
};

function canonicalBaseUrl(url: URL): string {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new GitHubConfigurationError(["REPROFORGE_BASE_URL"]);
  }
  return url.toString();
}

export function parseGitHubConfig(environment: GitHubEnvironment): GitHubConfig {
  const parsed = schema.safeParse({
    appId: environment.GITHUB_APP_ID,
    appSlug: environment.GITHUB_APP_SLUG,
    baseUrl: environment.REPROFORGE_BASE_URL,
    clientId: environment.GITHUB_APP_CLIENT_ID,
    clientSecret: environment.GITHUB_APP_CLIENT_SECRET,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: environment.GITHUB_WEBHOOK_SECRET,
  });
  if (!parsed.success) {
    throw new GitHubConfigurationError(
      parsed.error.issues.map(
        (issue) => fieldNames[String(issue.path[0])] ?? "GITHUB_APP",
      ),
    );
  }
  return {
    apiBaseUrl: "https://api.github.com/",
    appId: parsed.data.appId,
    appSlug: parsed.data.appSlug,
    baseUrl: canonicalBaseUrl(parsed.data.baseUrl),
    clientId: parsed.data.clientId,
    credentials: {
      clientSecret: parsed.data.clientSecret,
      privateKey: parsed.data.privateKey,
      webhookSecret: parsed.data.webhookSecret,
    },
  };
}

export function summarizeGitHubConfig(
  config: GitHubConfig,
): GitHubConfigSummary {
  return {
    apiBaseUrl: config.apiBaseUrl,
    appId: config.appId,
    appSlug: config.appSlug,
    baseUrl: config.baseUrl,
    clientConfigured: true,
    privateKeyConfigured: true,
    webhookConfigured: true,
  };
}

export function createGitHubConfigLoader(
  readEnvironment: () => GitHubEnvironment,
): () => GitHubConfig {
  let loaded = false;
  let config: GitHubConfig | undefined;
  let failure: unknown;
  return () => {
    if (!loaded) {
      loaded = true;
      try {
        config = parseGitHubConfig(readEnvironment());
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
    return config as GitHubConfig;
  };
}

export const getGitHubConfig = createGitHubConfigLoader(() => process.env);
