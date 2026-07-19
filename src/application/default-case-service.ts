import { randomUUID } from "node:crypto";

import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";

import { CaseService } from "./case-service";
import type { ReproductionSnapshot } from "./reproduction-contracts";
import type { SampleCaseResult } from "./sample-case";

const serviceGlobal = globalThis as typeof globalThis & {
  __reproForgeCaseService?: CaseService;
};

export const defaultCaseService =
  serviceGlobal.__reproForgeCaseService ??
  new CaseService({
    clock: { now: () => new Date() },
    identifiers: {
      nextCaseId: () => `case_${randomUUID()}`,
      nextJobId: () => `job_${randomUUID()}`,
    },
    repository: new InMemoryReproductionRepository(),
  });

if (process.env.NODE_ENV !== "production") {
  serviceGlobal.__reproForgeCaseService = defaultCaseService;
}

const WEB_DEMO_CALLER = "web:trusted-demo";
const WEB_DEMO_KEY = "trusted-home-v2";

export async function getTrustedWebSample(): Promise<SampleCaseResult> {
  const snapshot = await getTrustedWebSnapshot();
  if (!snapshot.result) {
    throw new Error("The trusted web sample did not complete inline");
  }
  return snapshot.result;
}

export async function getTrustedWebSnapshot(): Promise<ReproductionSnapshot> {
  const started = await defaultCaseService.startTrustedReproduction({
    callerId: WEB_DEMO_CALLER,
    idempotencyKey: WEB_DEMO_KEY,
    sampleId: "cli-spaces",
  });
  return started.snapshot;
}

