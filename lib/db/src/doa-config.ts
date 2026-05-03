/**
 * Delegation of Authority (DOA) configuration for S2P savings opportunities.
 *
 * DOA TIERS
 * ---------
 * Four tiers govern who must approve an opportunity and how long it may
 * remain in the `Identified` stage before breaching the approval SLA.
 * Tiers are resolved from the opportunity's `projectedSavingsUsd` (award
 * value). `doaTier` is stored as a denormalised column; the tier config
 * here is the single source of truth for thresholds and approver roles.
 *
 * GATE SLAs
 * ---------
 * Per-gate SLA hours define how long an opportunity may stay in each
 * canonical stage before it is flagged as breaching. These are independent
 * of the DOA tier — every opportunity at the same stage shares the same
 * gate SLA, regardless of value. Gate SLAs apply to the forward-progress
 * gates only (terminal stages have no SLA).
 *
 * COMPUTED FIELDS (query-time only — NOT stored)
 * -----------------------------------------------
 *   timeInCurrentStageHours — (now - stage_entered_at) / 3_600_000
 *   breachingSla            — see gateSlaBreach() below
 */

// ---------------------------------------------------------------------------
// DOA Tier ladder
// ---------------------------------------------------------------------------

export interface DoaTierConfig {
  /** 1 = most strategic/largest; 4 = standard/smallest. */
  tier: 1 | 2 | 3 | 4;
  label: string;
  /** Inclusive lower bound of award value (USD) for this tier. */
  minValueUsd: number;
  /** Human-readable upper bound label (for UI display only). */
  maxLabel: string;
  /** Approver role required for this tier. */
  approverRole: string;
  /**
   * Max hours an opportunity may sit in `Identified` awaiting initial
   * approval before `breachingSla` flips to true. Kept on the tier for
   * backward-compat with the first-pass implementation; gate-level SLAs
   * below are the authoritative source for all other stages.
   */
  identifiedSlaHours: number;
}

/**
 * DOA tier ladder, sorted descending by `minValueUsd`.
 * `resolveDoaTier` short-circuits on the first match.
 *
 * Thresholds:  <$250K | $250K–$1M | $1M–$5M | >$5M
 */
export const DOA_TIERS: readonly DoaTierConfig[] = [
  {
    tier: 1,
    label: "Tier 1 — Strategic (>$5M)",
    minValueUsd: 5_000_000,
    maxLabel: "Unlimited",
    approverRole: "board",
    identifiedSlaHours: 24,
  },
  {
    tier: 2,
    label: "Tier 2 — Major ($1M–$5M)",
    minValueUsd: 1_000_000,
    maxLabel: "<$5M",
    approverRole: "c_suite",
    identifiedSlaHours: 48,
  },
  {
    tier: 3,
    label: "Tier 3 — Significant ($250K–$1M)",
    minValueUsd: 250_000,
    maxLabel: "<$1M",
    approverRole: "vp",
    identifiedSlaHours: 72,
  },
  {
    tier: 4,
    label: "Tier 4 — Standard (<$250K)",
    minValueUsd: 0,
    maxLabel: "<$250K",
    approverRole: "manager",
    identifiedSlaHours: 168,
  },
] as const;

// ---------------------------------------------------------------------------
// Per-gate SLA hours
// ---------------------------------------------------------------------------

/**
 * Maximum hours an opportunity may remain in each forward-progress
 * canonical stage before `breachingSla` flips to true for that gate.
 *
 * Terminal stages (Realized, Closed-No Action, Under Re-evaluation) have
 * no SLA — `null` means "no breach possible in this stage".
 *
 * Gates:
 *   Identified        → time from Identified to Awarded
 *   Awarded           → time from Awarded to In Contracting
 *   In Contracting    → time from In Contracting to In Implementation
 *   In Implementation → time from In Implementation to Realized
 */
export interface GateSlaConfig {
  /** The canonical_stage this SLA applies to. */
  stage: string;
  /**
   * Max hours in this stage before breach. `null` = no SLA
   * (terminal stages or stages with no defined upper bound).
   */
  slaHours: number | null;
  /** Human-readable label for display in the DOA queue UI. */
  label: string;
}

export const GATE_SLAS: readonly GateSlaConfig[] = [
  {
    stage: "Identified",
    slaHours: 72,
    label: "Identified → Awarded (72 h)",
  },
  {
    stage: "Awarded",
    slaHours: 120,
    label: "Awarded → In Contracting (120 h)",
  },
  {
    stage: "In Contracting",
    slaHours: 168,
    label: "In Contracting → In Implementation (168 h)",
  },
  {
    stage: "In Implementation",
    slaHours: 720,
    label: "In Implementation → Realized (720 h / 30 d)",
  },
  { stage: "Realized", slaHours: null, label: "Realized (terminal)" },
  {
    stage: "Closed-No Action",
    slaHours: null,
    label: "Closed-No Action (terminal)",
  },
  {
    stage: "Under Re-evaluation",
    slaHours: 336,
    label: "Under Re-evaluation → resolution (336 h / 14 d)",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the DOA tier config for a given projected award value (USD). */
export function resolveDoaTier(awardValueUsd: number): DoaTierConfig {
  for (const tierConfig of DOA_TIERS) {
    if (awardValueUsd >= tierConfig.minValueUsd) {
      return tierConfig;
    }
  }
  return DOA_TIERS[DOA_TIERS.length - 1]!;
}

/** Convenience wrapper — returns just the numeric tier (1–4). */
export function resolveDoaTierNumber(awardValueUsd: number): 1 | 2 | 3 | 4 {
  return resolveDoaTier(awardValueUsd).tier;
}

/** Resolve the gate SLA config for a given canonical stage. */
export function resolveGateSla(stage: string): GateSlaConfig | undefined {
  return GATE_SLAS.find((g) => g.stage === stage);
}

/**
 * Compute hours elapsed since the opportunity entered its current stage.
 * Returns `null` when `stageEnteredAt` is not set (legacy / pre-backfill).
 */
export function computeTimeInCurrentStageHours(
  stageEnteredAt: Date | null,
  nowMs?: number,
): number | null {
  if (!stageEnteredAt) return null;
  const now = nowMs ?? Date.now();
  return (now - stageEnteredAt.getTime()) / (1_000 * 60 * 60);
}

/**
 * Gate SLA breach result — returned by `gateSlaBreach()` for every
 * opportunity in an API response.
 */
export interface GateSlaBreach {
  /** The opportunity's current canonical_stage. */
  stage: string | null;
  /** Gate SLA hours for the current stage; null for terminal stages. */
  slaHours: number | null;
  /** true iff the opportunity has exceeded its gate SLA. */
  breaching: boolean;
}

/**
 * Compute whether an opportunity is breaching its gate SLA.
 *
 * A breach occurs when:
 *   - `canonicalStage` has a defined SLA (non-terminal stage)
 *   - `stageEnteredAt` is set
 *   - `timeInCurrentStageHours` exceeds `slaHours`
 *
 * Null `stageEnteredAt` → non-breaching (avoids false positives on
 * legacy rows that pre-date the S2P field additions).
 */
export function gateSlaBreach(args: {
  canonicalStage: string | null;
  stageEnteredAt: Date | null;
  nowMs?: number;
}): GateSlaBreach {
  const gateConfig = args.canonicalStage
    ? resolveGateSla(args.canonicalStage)
    : undefined;
  const slaHours = gateConfig?.slaHours ?? null;

  if (slaHours === null || !args.stageEnteredAt) {
    return { stage: args.canonicalStage, slaHours, breaching: false };
  }

  const elapsed = computeTimeInCurrentStageHours(
    args.stageEnteredAt,
    args.nowMs,
  );
  const breaching = elapsed !== null && elapsed > slaHours;
  return { stage: args.canonicalStage, slaHours, breaching };
}

/**
 * Determine whether an opportunity is currently breaching its DOA SLA
 * specifically in the `Identified` stage (backward-compat helper used by
 * existing code paths that only care about the approval-queue breach).
 */
export function computeBreachingDoaSla(args: {
  canonicalStage: string | null;
  stageEnteredAt: Date | null;
  doaTier: number | null;
  nowMs?: number;
}): boolean {
  if (args.canonicalStage !== "Identified") return false;
  if (!args.stageEnteredAt) return false;
  if (!args.doaTier) return false;

  const tierConfig = DOA_TIERS.find((t) => t.tier === args.doaTier);
  if (!tierConfig) return false;

  const elapsed = computeTimeInCurrentStageHours(
    args.stageEnteredAt,
    args.nowMs,
  );
  return elapsed !== null && elapsed > tierConfig.identifiedSlaHours;
}
