import type { LeverId, RejectionReasonCode } from "@workspace/db";

export interface LeverContext {
  orgId: string;
  cycleId: string;
}

export interface OpportunityDraft {
  leverId: LeverId;
  title: string;
  rationale: string;
  recommendedAction: string;
  supplierId?: string | null;
  categoryId?: string | null;
  rawProjectedSavingsUsd: number;
  /** Refs / signals / observations driving the decision; persisted on the row. */
  inputs: Record<string, unknown>;
}

/**
 * Result of a single lever's `analyze()` call. Drafts plus per-cycle
 * lineage + cardinality the funnel substrate needs (task #185):
 *
 *   - drafts:               opportunity drafts the lever produced
 *   - consultedSignalIds:   `market_signals.id`s the analyzer actually
 *                            looked at this cycle. Used by the snapshot
 *                            writer to attribute the "Signals Analyzed"
 *                            stage to specific signals so an admin can
 *                            see _which_ FX/PPI rows fed the analysis.
 *                            Empty for levers that only consult tenant
 *                            data (Tier-1 SKU benchmarking, etc.).
 *   - candidatesEvaluated:  raw count of internal candidates the
 *                            lever considered before producing drafts.
 *                            Defaults to drafts.length if the lever
 *                            doesn't track it explicitly.
 */
export interface AnalyzeResult {
  drafts: OpportunityDraft[];
  consultedSignalIds: string[];
  candidatesEvaluated?: number;
}

export interface LeverAnalyzer {
  readonly leverId: LeverId;
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly label: string;
  readonly description: string;
  /**
   * Run the analyzer against the tenant's data. Backwards-compatible
   * return shape: a lever may return either a bare draft array
   * (legacy) or the richer `AnalyzeResult`. The cycle runner normalises
   * both into `AnalyzeResult` before passing them to the funnel writer.
   */
  analyze(ctx: LeverContext): Promise<OpportunityDraft[] | AnalyzeResult>;
  /**
   * Cohort identity tuple component. The funnel substrate identifies a
   * cohort by the triple `(leverId, primaryEntityId, leverSpecificKey)`:
   *
   *   - leverId             — the LeverId itself (always the same for
   *                           a lever's drafts)
   *   - primaryEntityId     — the most-actionable entity the draft
   *                           targets. By convention: supplierId if
   *                           set, else categoryId, else "".
   *   - leverSpecificKey    — returned by this method. The free-form
   *                           discriminator that distinguishes cohorts
   *                           within one lever (currency pair for FX,
   *                           material/index code for PPI levers, ""
   *                           for everything else).
   *
   * The snapshot writer composes the three into a single string key
   * (`<lever>:<entity>:<leverKey>`) and stores cohort counts under
   * each window bucket. Defaults to "" if the lever doesn't override.
   */
  cohortKey?(draft: OpportunityDraft): string;
}

export type ExclusionFilter = (draft: OpportunityDraft) => boolean;

export interface RejectionReasonInfo {
  code: RejectionReasonCode;
  label: string;
  /** Description of the exclusion rule emitted by the OODA Learn step. */
  exclusionDescription: string;
  /**
   * Translates a rejection on this opportunity into a structured exclusion-rule
   * payload for the OODA Learn step. May return null if no rule should be made.
   */
  toExclusionRule(args: {
    leverId: LeverId;
    supplierId: string | null;
    categoryId: string | null;
  }): {
    leverId: LeverId | null;
    supplierId: string | null;
    categoryId: string | null;
    description: string;
  } | null;
}

/**
 * Normalize either return shape into `AnalyzeResult`. Used by the cycle
 * runner so analyzer modules can keep returning bare arrays (most do)
 * but the snapshot writer always sees the structured result.
 */
export function toAnalyzeResult(
  res: OpportunityDraft[] | AnalyzeResult,
): AnalyzeResult {
  if (Array.isArray(res)) {
    return {
      drafts: res,
      consultedSignalIds: [],
      candidatesEvaluated: res.length,
    };
  }
  return {
    drafts: res.drafts,
    consultedSignalIds: res.consultedSignalIds ?? [],
    candidatesEvaluated: res.candidatesEvaluated ?? res.drafts.length,
  };
}

/**
 * Compose the cohort identity key for a draft. Centralised so the
 * snapshot writer and admin UI agree on the format.
 */
export function composeCohortKey(
  lever: LeverAnalyzer,
  draft: OpportunityDraft,
): string {
  const primary = draft.supplierId ?? draft.categoryId ?? "";
  const leverKey = lever.cohortKey ? lever.cohortKey(draft) : "";
  return `${lever.leverId}:${primary}:${leverKey}`;
}
