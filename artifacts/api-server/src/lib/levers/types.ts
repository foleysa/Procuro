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

export interface LeverAnalyzer {
  readonly leverId: LeverId;
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly label: string;
  readonly description: string;
  /** Run the analyzer against the tenant's data. */
  analyze(ctx: LeverContext): Promise<OpportunityDraft[]>;
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
