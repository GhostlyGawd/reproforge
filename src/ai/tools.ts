import { z } from "zod";

import { evidenceItemSchema } from "@/domain/evidence";

import { experimentProposalSchema } from "./contracts";

export const recordEvidenceArgumentsSchema = evidenceItemSchema;

export const recordHypothesisArgumentsSchema = z
  .object({
    evidenceIds: z.array(z.string().min(1)).min(1),
    expectedSignal: z.string().min(1),
    falsificationCondition: z.string().min(1),
    id: z.string().min(1),
    priority: z.number().int().min(1).max(5),
    statement: z.string().min(1),
  })
  .strict();

export const proposeExperimentArgumentsSchema = experimentProposalSchema;

type JsonSchemaProperty = Readonly<Record<string, unknown>>;

export type StrictToolDefinition = {
  description: string;
  name: string;
  parameters: {
    additionalProperties: false;
    properties: Readonly<Record<string, JsonSchemaProperty>>;
    required: readonly string[];
    type: "object";
  };
  strict: true;
  type: "function";
};

export const investigatorTools = [
  {
    type: "function",
    name: "record_evidence",
    description: "Record one sourced fact, observation, inference, or explicit unknown.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        classification: {
          type: "string",
          enum: ["reported", "observed", "inferred", "unknown"],
        },
        content: { type: "string", minLength: 1 },
        source: { type: "string", minLength: 1 },
      },
      required: ["id", "classification", "content", "source"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "record_hypothesis",
    description: "Record one falsifiable hypothesis linked to existing evidence.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        statement: { type: "string", minLength: 1 },
        evidenceIds: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
        },
        expectedSignal: { type: "string", minLength: 1 },
        falsificationCondition: { type: "string", minLength: 1 },
      },
      required: [
        "id",
        "priority",
        "statement",
        "evidenceIds",
        "expectedSignal",
        "falsificationCondition",
      ],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_experiment",
    description: "Propose one allowlisted fixture recipe linked to a recorded hypothesis.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        hypothesisId: { type: "string", minLength: 1 },
        recipe: { type: "string", enum: ["control", "reproduce"] },
        expectedSignal: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
      },
      required: ["id", "hypothesisId", "recipe", "expectedSignal", "rationale"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly StrictToolDefinition[];
