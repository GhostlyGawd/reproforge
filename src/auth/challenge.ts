import type { ReproForgeOAuthScope } from "@/application/ports/auth";
import type { OAuthResourceConfig } from "@/config/oauth";

const challengeError = new Set(["invalid_token", "insufficient_scope"]);

type ChallengeOptions = {
  description: string;
  error: "invalid_token" | "insufficient_scope";
  scopes: ReproForgeOAuthScope[];
};

function sanitizeDescription(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/Authorization:\s*Bearer\s+[^\s\"]+/gi, "Authorization: [REDACTED]")
    .replace(/["\\]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function buildBearerChallenge(
  config: OAuthResourceConfig,
  options: ChallengeOptions,
): string {
  if (!challengeError.has(options.error)) {
    throw new Error("Unsupported OAuth challenge error");
  }
  const supported = new Set(config.scopes);
  const scopes = [...new Set(options.scopes)]
    .filter((scope) => supported.has(scope))
    .sort();
  if (scopes.length === 0) throw new Error("OAuth challenge requires a scope");
  const description = sanitizeDescription(options.description);
  if (!description) throw new Error("OAuth challenge requires a description");
  return [
    `Bearer resource_metadata="${config.metadataUrl}"`,
    `scope="${scopes.join(" ")}"`,
    `error="${options.error}"`,
    `error_description="${description}"`,
  ].join(", ");
}
