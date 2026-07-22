import {
  createDomainChallengeHandler,
  parseDomainChallengeToken,
} from "@/http/domain-challenge";

export const dynamic = "force-dynamic";
export const GET = createDomainChallengeHandler(() =>
  parseDomainChallengeToken(process.env),
);
