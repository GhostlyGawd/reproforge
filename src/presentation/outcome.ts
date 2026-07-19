import type { VerificationSummary } from "@/domain/verification";

export type OutcomePresentation = {
  copy: string;
  heading: string;
  label: string;
  tone: "success" | "warning" | "neutral" | "blocked";
};

const presentations: Record<VerificationSummary["status"], OutcomePresentation> = {
  VERIFIED: {
    copy: "The path is reduced, the failure signature is explicit, and the proof survives repeat execution.",
    heading: "Verified reproduction",
    label: "verified",
    tone: "success",
  },
  UNSTABLE: {
    copy: "The candidate matched intermittently. ReproForge preserved the observed rate instead of claiming deterministic proof.",
    heading: "Reproduction is unstable",
    label: "unstable",
    tone: "warning",
  },
  NOT_REPRODUCED: {
    copy: "The candidate did not match the failure oracle in this pinned environment. The evidence remains available for the next hypothesis.",
    heading: "Failure not reproduced",
    label: "not reproduced",
    tone: "neutral",
  },
  BLOCKED: {
    copy: "A required capability or piece of evidence is unavailable. No execution or verification claim was made.",
    heading: "Investigation blocked",
    label: "blocked",
    tone: "blocked",
  },
};

export function outcomePresentation(
  status: VerificationSummary["status"],
): OutcomePresentation {
  return presentations[status];
}
