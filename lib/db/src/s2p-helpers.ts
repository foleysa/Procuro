import type { CanonicalStage, SavingsType } from "./schema/opportunities";

export function s2pForStatusTransition(newStatus: string): {
  canonicalStage: CanonicalStage;
  savingsType: SavingsType;
} {
  switch (newStatus) {
    case "approved":
      return { canonicalStage: "Awarded", savingsType: "Negotiated" };
    case "executing":
      return { canonicalStage: "In Implementation", savingsType: "Implemented" };
    case "realized":
      return { canonicalStage: "Realized", savingsType: "Realized" };
    case "rejected":
    case "expired":
      return { canonicalStage: "Closed-No Action", savingsType: "Identified" };
    default:
      return { canonicalStage: "Identified", savingsType: "Identified" };
  }
}

export interface BaselineValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateBaselineForRealized(args: {
  savingsType: string | null;
  baselineValue: string | null;
  baselineMethod: string | null;
}): BaselineValidationResult {
  if (args.savingsType !== "Realized") {
    return { valid: true };
  }

  if (args.baselineValue !== null && args.baselineValue !== undefined) {
    return { valid: true };
  }

  if (args.baselineMethod === "N/A — Soft") {
    return { valid: true };
  }

  return {
    valid: false,
    reason:
      "Realized savings require either a non-null baseline_value OR baseline_method = 'N/A — Soft'",
  };
}

export const BACKFILL_DEFAULTS = {
  savingsClassification: "Hard" as const,
  classificationNeedsReview: true,
  baselineMethod: "Internal Estimate" as const,
  baselineValue: null,
  baselineSource: "BACKFILL — needs review",
  sourcingStrategy: "Unclassified" as const,
} as const;
