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
 * snapshot writer and admin UI agree on the format. This is the
 * ANALYTICS bucket key — collisions are EXPECTED (and desired) so
 * the funnel snapshot can roll up multiple drafts into one cohort.
 *
 * Do NOT use this as the dedupe key for the opportunities table.
 * For per-draft dedupe identity, use `composeSignalKey` below.
 */
export function composeCohortKey(
  lever: LeverAnalyzer,
  draft: OpportunityDraft,
): string {
  const primary = draft.supplierId ?? draft.categoryId ?? "";
  const leverKey = lever.cohortKey ? lever.cohortKey(draft) : "";
  return `${lever.leverId}:${primary}:${leverKey}`;
}

/**
 * Compose the per-draft DEDUPE identity key for a draft (task #219).
 * Used as the value of `opportunities.signal_key` against the partial
 * unique index `opps_signal_key_uq`.
 *
 * The contract is: if the SAME underlying signal re-fires on the next
 * cycle (e.g. the same supplier/SKU/contract still trips the same
 * lever rule), the resulting draft MUST produce the SAME signal key
 * so the upsert refreshes the existing row in place — even when the
 * narrative fields (title, rationale) and the metric fields
 * (projected savings, aggregates inside `inputs`) drift cycle to
 * cycle as the source data changes. Conversely, two genuinely
 * different signals (e.g. two SKUs in `sku_price_benchmark`, two
 * contracts in `contract_leakage`) MUST produce DIFFERENT signal
 * keys so they don't collapse.
 *
 * To honour both halves of the contract we use ONLY stable identity
 * fields:
 *   - `lever.leverId` — the lever family.
 *   - `draft.supplierId` / `draft.categoryId` — structural anchors
 *     when present (they're stable IDs, never volatile metrics).
 *   - `lever.cohortKey?.(draft)` — the lever-declared per-signal
 *     identity (e.g. `sku` for `sku_price_benchmark`, `contractId`
 *     for `missed_volume_threshold`). This is the contract method
 *     each lever uses to tell us "what makes this signal unique
 *     within my family". Mutable narrative or metric fields MUST NOT
 *     appear here.
 *
 * Returns `null` when the draft carries no stable identity (no
 * supplier, no category, and the lever doesn't override
 * `cohortKey()`). The cycle Act step writes NULL into `signal_key`,
 * which the partial unique index excludes — so the row inserts
 * without participating in dedupe (legacy escape hatch). This is
 * safer than fabricating a key from volatile fields, which would
 * stack a new row each cycle.
 */
export function composeSignalKey(
  lever: LeverAnalyzer,
  draft: OpportunityDraft,
): string | null {
  const supplier = draft.supplierId ?? "";
  const category = draft.categoryId ?? "";
  const leverKey = lever.cohortKey ? lever.cohortKey(draft) : "";
  // No stable identity at all → don't dedupe, leave signal_key NULL.
  if (!supplier && !category && !leverKey) return null;
  return `${lever.leverId}:${supplier}:${category}:${leverKey}`;
}
