import { createHash, randomBytes as secureRandomBytes } from "node:crypto";

import { z } from "zod";

const actorSchema = z
  .object({
    principalId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    tenantId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export type GitHubInstallationActor = z.infer<typeof actorSchema>;

export type GitHubInstallationStateRecord = GitHubInstallationActor & {
  consumedAt: string | null;
  createdAt: string;
  expiresAt: string;
  stateHash: string;
};

export interface GitHubInstallationStateStore {
  create(record: GitHubInstallationStateRecord): Promise<void>;
  consume(input: GitHubInstallationActor & {
    at: string;
    stateHash: string;
  }): Promise<GitHubInstallationStateRecord | null>;
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export class InMemoryGitHubInstallationStateStore
  implements GitHubInstallationStateStore
{
  private readonly records = new Map<string, GitHubInstallationStateRecord>();

  async create(record: GitHubInstallationStateRecord): Promise<void> {
    if (this.records.has(record.stateHash)) {
      throw new Error("GitHub installation state collision");
    }
    this.records.set(record.stateHash, structuredClone(record));
  }

  async consume(
    input: GitHubInstallationActor & { at: string; stateHash: string },
  ): Promise<GitHubInstallationStateRecord | null> {
    const record = this.records.get(input.stateHash);
    if (
      !record ||
      record.consumedAt ||
      record.principalId !== input.principalId ||
      record.tenantId !== input.tenantId ||
      Date.parse(input.at) > Date.parse(record.expiresAt)
    ) {
      return null;
    }
    const consumed = { ...record, consumedAt: input.at };
    this.records.set(input.stateHash, consumed);
    return structuredClone(consumed);
  }

  snapshot(): GitHubInstallationStateRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}

export async function createGitHubInstallationAuthorization(input: {
  actor: GitHubInstallationActor;
  appSlug: string;
  clock?: { now(): Date };
  randomBytes?: () => Uint8Array;
  states: GitHubInstallationStateStore;
}): Promise<{ expiresAt: string; state: string; url: string }> {
  const actor = actorSchema.parse(input.actor);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(input.appSlug)) {
    throw new Error("Invalid GitHub App slug");
  }
  const now = (input.clock ?? { now: () => new Date() }).now();
  const bytes = (input.randomBytes ?? (() => secureRandomBytes(32)))();
  if (bytes.byteLength !== 32) throw new Error("Invalid installation state entropy");
  const state = Buffer.from(bytes).toString("base64url");
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await input.states.create({
    ...actor,
    consumedAt: null,
    createdAt: now.toISOString(),
    expiresAt,
    stateHash: hashState(state),
  });
  const url = new URL(
    `https://github.com/apps/${input.appSlug}/installations/new`,
  );
  url.searchParams.set("state", state);
  return { expiresAt, state, url: url.toString() };
}

export function githubInstallationStateHash(state: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("Invalid state");
  return hashState(state);
}
