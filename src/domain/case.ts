import { z } from "zod";

export const CASE_STATES = [
  "DRAFT",
  "INGESTING",
  "INSPECTING",
  "HYPOTHESIZING",
  "EXPERIMENTING",
  "VERIFYING",
  "MINIMIZING",
  "PACKAGING",
  "VERIFIED",
  "UNSTABLE",
  "NOT_REPRODUCED",
  "BLOCKED",
  "CANCELLED",
] as const;

export const ACTIVE_CASE_STATES = [
  "DRAFT",
  "INGESTING",
  "INSPECTING",
  "HYPOTHESIZING",
  "EXPERIMENTING",
  "VERIFYING",
  "MINIMIZING",
  "PACKAGING",
] as const;

export const TERMINAL_CASE_STATES = [
  "VERIFIED",
  "UNSTABLE",
  "NOT_REPRODUCED",
  "BLOCKED",
  "CANCELLED",
] as const;

export const caseStateSchema = z.enum(CASE_STATES);
export type CaseState = z.infer<typeof caseStateSchema>;

const transitionEntrySchema = z
  .object({
    at: z.string().datetime(),
    from: caseStateSchema,
    reason: z.string().min(1),
    to: caseStateSchema,
  })
  .strict();

export const reproCaseSchema = z
  .object({
    createdAt: z.string().datetime(),
    history: z.array(transitionEntrySchema),
    id: z.string().min(1),
    state: caseStateSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ReproCase = z.infer<typeof reproCaseSchema>;

const allowedTransitions: Readonly<Record<CaseState, readonly CaseState[]>> = {
  DRAFT: ["INGESTING", "CANCELLED"],
  INGESTING: ["INSPECTING", "BLOCKED", "CANCELLED"],
  INSPECTING: ["HYPOTHESIZING", "BLOCKED", "CANCELLED"],
  HYPOTHESIZING: ["EXPERIMENTING", "BLOCKED", "CANCELLED"],
  EXPERIMENTING: ["VERIFYING", "BLOCKED", "CANCELLED"],
  VERIFYING: [
    "MINIMIZING",
    "UNSTABLE",
    "NOT_REPRODUCED",
    "BLOCKED",
    "CANCELLED",
  ],
  MINIMIZING: ["PACKAGING", "BLOCKED", "CANCELLED"],
  PACKAGING: ["VERIFIED", "BLOCKED", "CANCELLED"],
  VERIFIED: [],
  UNSTABLE: [],
  NOT_REPRODUCED: [],
  BLOCKED: [],
  CANCELLED: [],
};

export class InvalidCaseTransitionError extends Error {
  constructor(from: CaseState, to: CaseState) {
    super(`Invalid ReproForge case transition: ${from} -> ${to}`);
    this.name = "InvalidCaseTransitionError";
  }
}

export function createCase(id: string, at = new Date()): ReproCase {
  const timestamp = at.toISOString();
  return reproCaseSchema.parse({
    createdAt: timestamp,
    history: [],
    id,
    state: "DRAFT",
    updatedAt: timestamp,
  });
}

export function canTransition(from: CaseState, to: CaseState): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionCase(
  current: ReproCase,
  to: CaseState,
  reason: string,
  at = new Date(),
): ReproCase {
  if (!canTransition(current.state, to)) {
    throw new InvalidCaseTransitionError(current.state, to);
  }

  const timestamp = at.toISOString();
  return reproCaseSchema.parse({
    ...current,
    history: [
      ...current.history,
      { at: timestamp, from: current.state, reason, to },
    ],
    state: to,
    updatedAt: timestamp,
  });
}

