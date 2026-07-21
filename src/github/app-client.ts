import { SignJWT } from "jose";
import { z } from "zod";

import type {
  GitHubInstallationVerifier,
  VerifiedGitHubInstallation,
  VerifiedGitHubRepository,
} from "@/github/callback";
import type { GitHubLiveRepositoryClient } from "@/github/repository-provider";
import type { EphemeralRepositoryArchiveCredential } from "@/application/ports/repository-source";
import {
  isGitHubAppPrivateKey,
  parseGitHubAppPrivateKey,
} from "@/github/private-key";

const API_VERSION = "2026-03-10";
const REQUESTED_PERMISSIONS = Object.freeze({
  contents: "read" as const,
  issues: "read" as const,
  metadata: "read" as const,
});

const configSchema = z
  .object({
    apiBaseUrl: z
      .url()
      .transform((value) => new URL(value))
      .refine((value) => value.protocol === "https:", "must use HTTPS"),
    appId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    clientId: z.string().min(8).max(255),
    clientSecret: z.string().min(20).max(512),
    privateKey: z
      .string()
      .min(256)
      .max(32_768)
      .refine(
        isGitHubAppPrivateKey,
        "must be an RSA private key in PKCS#1 or PKCS#8 PEM format",
      ),
  })
  .strict();
const permissionsSchema = z
  .object({
    contents: z.literal("read"),
    issues: z.literal("read"),
    metadata: z.literal("read"),
  })
  .strict();
const installationSchema = z.object({
  account: z.object({
    id: z.number().int().positive().safe(),
    login: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  }),
  id: z.number().int().positive().safe(),
  permissions: permissionsSchema,
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: z.string().datetime({ offset: true }).nullable(),
  updated_at: z.string().datetime({ offset: true }).optional(),
});
const installationTokenSchema = z.object({
  expires_at: z.string().datetime({ offset: true }),
  permissions: permissionsSchema,
  repository_selection: z.enum(["all", "selected"]),
  token: z.string().min(1).max(4096),
});
const repositorySchema = z.object({
  default_branch: z.string().min(1).max(255),
  full_name: z.string().min(3).max(255).regex(/^[^/\s]+\/[^/\s]+$/),
  id: z.number().int().positive().safe(),
  private: z.boolean(),
});
const repositoryPageSchema = z.object({
  repositories: z.array(repositorySchema).max(100),
  total_count: z.number().int().nonnegative().max(10_000),
});
const userInstallationPageSchema = z.object({
  installations: z.array(
    z.object({ id: z.number().int().positive().safe() }),
  ).max(100),
  total_count: z.number().int().nonnegative().max(10_000),
});
const exchangeSchema = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
});
const revisionSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });

export type GitHubAppClientConfig = z.input<typeof configSchema>;

export class GitHubProviderError extends Error {
  constructor(
    readonly code:
      | "INSTALLATION_UNAVAILABLE"
      | "INVALID_PROVIDER_RESPONSE"
      | "PROVIDER_REQUEST_FAILED"
      | "REVISION_UNAVAILABLE"
      | "SETUP_ACTOR_UNAUTHORIZED",
  ) {
    super("GitHub repository authorization could not be verified");
    this.name = "GitHubProviderError";
  }
}

type Dependencies = {
  clock?: { now(): Date };
  fetch?: typeof fetch;
};

export class GitHubAppClient
  implements GitHubInstallationVerifier, GitHubLiveRepositoryClient
{
  private readonly apiBaseUrl: URL;
  private readonly appId: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly clock: { now(): Date };
  private readonly fetch: typeof fetch;
  private readonly privateKey: ReturnType<typeof parseGitHubAppPrivateKey>;

  constructor(rawConfig: GitHubAppClientConfig, dependencies: Dependencies = {}) {
    const config = configSchema.parse(rawConfig);
    this.apiBaseUrl = config.apiBaseUrl;
    this.appId = config.appId;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.clock = dependencies.clock ?? { now: () => new Date() };
    this.fetch = dependencies.fetch ?? fetch;
    this.privateKey = parseGitHubAppPrivateKey(config.privateKey);
  }

  async verify(input: {
    code: string;
    installationId: number;
  }): Promise<VerifiedGitHubInstallation> {
    const parsed = z
      .object({
        code: z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/),
        installationId: z.number().int().positive().safe(),
      })
      .strict()
      .parse(input);
    let userToken = await this.exchangeSetupCode(parsed.code);
    try {
      if (!(await this.userCanAccessInstallation(userToken, parsed.installationId))) {
        throw new GitHubProviderError("SETUP_ACTOR_UNAUTHORIZED");
      }
      const installation = await this.getLiveInstallation(parsed.installationId);
      let installationToken = await this.mintInstallationToken(
        parsed.installationId,
      );
      try {
        const repositories = await this.listInstallationRepositories(
          installationToken.token,
        );
        return {
          accountId: installation.account.id,
          accountLogin: installation.account.login,
          installationId: installation.id,
          permissions: installation.permissions,
          ...(installation.updated_at
            ? { providerUpdatedAt: installation.updated_at }
            : {}),
          repositories,
          repositorySelection: installation.repository_selection,
        };
      } finally {
        installationToken = { expiresAt: "", token: "" };
      }
    } finally {
      userToken = "";
    }
  }

  async assertRepositoryRevision(input: {
    commitSha: string;
    fullName: string;
    installationId: number;
    providerRepositoryId: number;
  }): Promise<{ commitSha: string }> {
    const parsed = z
      .object({
        commitSha: z.string().regex(/^[a-f0-9]{40}$/),
        fullName: z.string().min(3).max(255).regex(/^[^/\s]+\/[^/\s]+$/),
        installationId: z.number().int().positive().safe(),
        providerRepositoryId: z.number().int().positive().safe(),
      })
      .strict()
      .parse(input);
    await this.getLiveInstallation(parsed.installationId);
    let installationToken = await this.mintInstallationToken(
      parsed.installationId,
      parsed.providerRepositoryId,
    );
    try {
      const [owner, repository] = parsed.fullName.split("/") as [string, string];
      const response = await this.apiRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${parsed.commitSha}`,
        { token: installationToken.token },
      );
      if (!response.ok) throw new GitHubProviderError("REVISION_UNAVAILABLE");
      const revision = this.parseResponse(revisionSchema, await response.json());
      if (revision.sha !== parsed.commitSha) {
        throw new GitHubProviderError("REVISION_UNAVAILABLE");
      }
      return { commitSha: revision.sha };
    } finally {
      installationToken = { expiresAt: "", token: "" };
    }
  }

  async withRepositoryArchiveCredential<Result>(
    rawInput: { installationId: number; providerRepositoryId: number },
    consume: (
      credential: EphemeralRepositoryArchiveCredential,
    ) => Promise<Result>,
  ): Promise<Result> {
    const input = z
      .object({
        installationId: z.number().int().positive().safe(),
        providerRepositoryId: z.number().int().positive().safe(),
      })
      .strict()
      .parse(rawInput);
    await this.getLiveInstallation(input.installationId);
    let installationToken = await this.mintInstallationToken(
      input.installationId,
      input.providerRepositoryId,
    );
    try {
      return await consume({
        authorizationHeader: `Bearer ${installationToken.token}`,
        expiresAt: installationToken.expiresAt,
      });
    } finally {
      installationToken = { expiresAt: "", token: "" };
    }
  }

  private async exchangeSetupCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
    });
    const response = await this.fetch(
      "https://github.com/login/oauth/access_token",
      {
        body,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        redirect: "error",
      },
    );
    if (!response.ok) throw new GitHubProviderError("PROVIDER_REQUEST_FAILED");
    return this.parseResponse(exchangeSchema, await response.json()).access_token;
  }

  private async userCanAccessInstallation(
    userToken: string,
    installationId: number,
  ): Promise<boolean> {
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.apiRequest(
        `/user/installations?per_page=100&page=${page}`,
        { token: userToken },
      );
      if (!response.ok) throw new GitHubProviderError("PROVIDER_REQUEST_FAILED");
      const result = this.parseResponse(
        userInstallationPageSchema,
        await response.json(),
      );
      if (result.installations.some(({ id }) => id === installationId)) return true;
      if (page * 100 >= result.total_count || result.installations.length === 0) {
        return false;
      }
    }
    return false;
  }

  private async getLiveInstallation(installationId: number) {
    const response = await this.apiRequest(`/app/installations/${installationId}`, {
      token: await this.createAppJwt(),
    });
    if (!response.ok) throw new GitHubProviderError("INSTALLATION_UNAVAILABLE");
    const installation = this.parseResponse(
      installationSchema,
      await response.json(),
    );
    if (installation.id !== installationId || installation.suspended_at !== null) {
      throw new GitHubProviderError("INSTALLATION_UNAVAILABLE");
    }
    return installation;
  }

  private async mintInstallationToken(
    installationId: number,
    providerRepositoryId?: number,
  ): Promise<{ expiresAt: string; token: string }> {
    const response = await this.apiRequest(
      `/app/installations/${installationId}/access_tokens`,
      {
        body: JSON.stringify({
          permissions: REQUESTED_PERMISSIONS,
          ...(providerRepositoryId === undefined
            ? {}
            : { repository_ids: [providerRepositoryId] }),
        }),
        method: "POST",
        token: await this.createAppJwt(),
      },
    );
    if (!response.ok) throw new GitHubProviderError("INSTALLATION_UNAVAILABLE");
    const result = this.parseResponse(
      installationTokenSchema,
      await response.json(),
    );
    const expiresAt = Date.parse(result.expires_at);
    const now = this.clock.now().getTime();
    if (expiresAt <= now || expiresAt > now + 61 * 60_000) {
      throw new GitHubProviderError("INVALID_PROVIDER_RESPONSE");
    }
    return { expiresAt: result.expires_at, token: result.token };
  }

  private async listInstallationRepositories(
    installationToken: string,
  ): Promise<VerifiedGitHubRepository[]> {
    const repositories: VerifiedGitHubRepository[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.apiRequest(
        `/installation/repositories?per_page=100&page=${page}`,
        { token: installationToken },
      );
      if (!response.ok) throw new GitHubProviderError("PROVIDER_REQUEST_FAILED");
      const result = this.parseResponse(repositoryPageSchema, await response.json());
      repositories.push(
        ...result.repositories.map((repository) => ({
          defaultBranch: repository.default_branch,
          fullName: repository.full_name,
          private: repository.private,
          repositoryId: repository.id,
        })),
      );
      if (repositories.length >= result.total_count || result.repositories.length === 0) {
        return repositories;
      }
    }
    throw new GitHubProviderError("INVALID_PROVIDER_RESPONSE");
  }

  private async createAppJwt(): Promise<string> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000) - 60;
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.clientId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 10 * 60)
      .sign(await this.privateKey);
  }

  private apiRequest(
    path: string,
    input: { body?: string; method?: string; token: string },
  ): Promise<Response> {
    return this.fetch(new URL(path, this.apiBaseUrl), {
      body: input.body,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        ...(input.body ? { "Content-Type": "application/json" } : {}),
        "User-Agent": `ReproForge-GitHub-App/${this.appId}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
      method: input.method ?? "GET",
      redirect: "error",
    });
  }

  private parseResponse<Output>(schema: z.ZodType<Output>, value: unknown): Output {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new GitHubProviderError("INVALID_PROVIDER_RESPONSE");
    }
    return parsed.data;
  }
}
