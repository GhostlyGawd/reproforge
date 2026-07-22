import { z } from "zod";

const tokenSchema = z
  .string()
  .min(16)
  .max(2048)
  .regex(/^[!-~]+$/);

export type DomainChallengeEnvironment = Readonly<
  Record<string, string | undefined>
>;

export function parseDomainChallengeToken(
  environment: DomainChallengeEnvironment,
): string | null {
  const value = environment.OPENAI_APPS_CHALLENGE_TOKEN;
  if (value === undefined || value === "") return null;
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid OpenAI Apps challenge token");
  }
  return parsed.data;
}

export function createDomainChallengeHandler(
  loadToken: () => string | null,
): () => Response {
  return function GET(): Response {
    try {
      const token = loadToken();
      if (token === null) {
        return new Response(null, {
          headers: { "Cache-Control": "no-store" },
          status: 404,
        });
      }
      return new Response(token, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, {
        headers: { "Cache-Control": "no-store" },
        status: 503,
      });
    }
  };
}
