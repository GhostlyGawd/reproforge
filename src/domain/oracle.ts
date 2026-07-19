import { z } from "zod";

import type { RunResult } from "./run";

type StreamName = "stdout" | "stderr";

export type OracleExpression =
  | { type: "exit_code"; expected: number }
  | { type: "output_contains"; stream: StreamName; value: string }
  | { type: "output_regex"; stream: StreamName; pattern: string }
  | { type: "json_field"; stream: StreamName; path: string[]; equals: unknown }
  | { type: "all"; children: OracleExpression[] }
  | { type: "any"; children: OracleExpression[] }
  | { type: "not"; child: OracleExpression };

const validRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

export const oracleExpressionSchema: z.ZodType<OracleExpression> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("exit_code"), expected: z.number().int() }).strict(),
    z
      .object({
        type: z.literal("output_contains"),
        stream: z.enum(["stdout", "stderr"]),
        value: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("output_regex"),
        stream: z.enum(["stdout", "stderr"]),
        pattern: z.string().max(256).refine(validRegex, "Invalid regular expression"),
      })
      .strict(),
    z
      .object({
        type: z.literal("json_field"),
        stream: z.enum(["stdout", "stderr"]),
        path: z.array(z.string()).min(1),
        equals: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("all"),
        children: z.array(oracleExpressionSchema).min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("any"),
        children: z.array(oracleExpressionSchema).min(1),
      })
      .strict(),
    z.object({ type: z.literal("not"), child: oracleExpressionSchema }).strict(),
  ]),
);

export const failureOracleSchema = z
  .object({
    id: z.string().min(1),
    root: oracleExpressionSchema,
    version: z.number().int().positive(),
  })
  .strict();

export type FailureOracle = z.infer<typeof failureOracleSchema>;

export type OracleEvaluation = {
  evidence: string[];
  matched: boolean;
};

function streamValue(run: RunResult, stream: StreamName): string {
  return stream === "stdout" ? run.stdout : run.stderr;
}
function jsonAtPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function evaluateExpression(
  expression: OracleExpression,
  run: RunResult,
): OracleEvaluation {
  switch (expression.type) {
    case "exit_code": {
      const matched = run.exitCode === expression.expected;
      return {
        matched,
        evidence: [`exit code ${run.exitCode} ${matched ? "matched" : "did not match"} ${expression.expected}`],
      };
    }
    case "output_contains": {
      const matched = streamValue(run, expression.stream).includes(expression.value);
      return {
        matched,
        evidence: [
          `${expression.stream} ${matched ? "contained" : "did not contain"} ${JSON.stringify(expression.value)}`,
        ],
      };
    }
    case "output_regex": {
      const matched = new RegExp(expression.pattern).test(
        streamValue(run, expression.stream),
      );
      return {
        matched,
        evidence: [
          `${expression.stream} ${matched ? "matched" : "did not match"} /${expression.pattern}/`,
        ],
      };
    }
    case "json_field": {
      try {
        const parsed: unknown = JSON.parse(streamValue(run, expression.stream));
        const actual = jsonAtPath(parsed, expression.path);
        const matched = JSON.stringify(actual) === JSON.stringify(expression.equals);
        return {
          matched,
          evidence: [
            `${expression.stream}.${expression.path.join(".")} ${matched ? "matched" : "did not match"} expected value`,
          ],
        };
      } catch {
        return {
          matched: false,
          evidence: [`${expression.stream} was not valid JSON`],
        };
      }
    }
    case "all": {
      const children = expression.children.map((child) => evaluateExpression(child, run));
      return {
        matched: children.every((child) => child.matched),
        evidence: children.flatMap((child) => child.evidence),
      };
    }
    case "any": {
      const children = expression.children.map((child) => evaluateExpression(child, run));
      return {
        matched: children.some((child) => child.matched),
        evidence: children.flatMap((child) => child.evidence),
      };
    }
    case "not": {
      const child = evaluateExpression(expression.child, run);
      return {
        matched: !child.matched,
        evidence: child.evidence.map((item) => `not (${item})`),
      };
    }
  }
}

export function evaluateOracle(
  oracle: FailureOracle,
  run: RunResult,
): OracleEvaluation {
  const parsed = failureOracleSchema.parse(oracle);
  return evaluateExpression(parsed.root, run);
}
