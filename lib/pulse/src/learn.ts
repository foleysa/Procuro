import type {
  DefensePackOutcomeCategory,
  DefensePackOutcomeUsed,
  OpportunityStatus,
} from "@workspace/db/schema";

/**
 * Layer C Learn — outcome vs baseline.
 *
 * `unknown` is first-class. Do not train, publish, or sell ROI on a
 * guessed win. Reject / expire / unused-pack never imply `missed`.
 */
export const pulseLearnOutcomes = [
  "saved",
  "missed",
  "unknown",
  "reversed",
] as const;
export type PulseLearnOutcome = (typeof pulseLearnOutcomes)[number];

const LEARN_SET = new Set<string>(pulseLearnOutcomes);

export function isPulseLearnOutcome(
  value: string,
): value is PulseLearnOutcome {
  return LEARN_SET.has(value);
}

export function learnOutcomeFromOpportunity(args: {
  status: OpportunityStatus;
  realizedSavingsUsd?: number | null;
}): PulseLearnOutcome {
  if (args.status !== "realized") {
    return "unknown";
  }
  if (args.realizedSavingsUsd == null) {
    return "unknown";
  }
  return args.realizedSavingsUsd > 0 ? "saved" : "missed";
}

/**
 * Defense-pack Learn hints. `used=unknown` / unused pack → `unknown`.
 * Category labels are operator-reported on that tenant's pack — not a
 * public Pulse metric and not a peer percentile.
 */
export function learnOutcomeFromDefensePack(args: {
  used: DefensePackOutcomeUsed;
  outcomeCategory?: DefensePackOutcomeCategory | null;
}): PulseLearnOutcome {
  if (args.used !== "yes") {
    return "unknown";
  }
  switch (args.outcomeCategory) {
    case "supplier_reduced_price":
    case "supplier_held_price":
      return "saved";
    case "deal_lost":
      return "missed";
    case "deferred":
    case "other":
    case undefined:
    case null:
      return "unknown";
    default: {
      const _exhaustive: never = args.outcomeCategory;
      return _exhaustive;
    }
  }
}

/**
 * No existing desk event maps to `reversed`. Callers must set it
 * explicitly when an earlier Learn is undone.
 */
export function deskCanEmitReversed(): false {
  return false;
}
