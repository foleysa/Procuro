import type { LeverId } from "@workspace/db";

/**
 * A single data-readiness blocker for a lever.
 *
 * `missingPct` is the share of rows in the relevant base table whose
 * required field is null/blank for this check. `0` means fully populated;
 * `100` means no usable rows. `missingCount` and `totalCount` are the raw
 * inputs that produced `missingPct`, surfaced verbatim so the UI can
 * render exact tallies in the "fix this" deep-link.
 */
export interface ReadinessBlocker {
  /** Stable id for the blocker, e.g. `suppliers.billing_currency`. */
  id: string;
  /** Logical field path readable to a non-technical operator. */
  field: string;
  /** Short human-readable explanation of what's missing and why it matters. */
  message: string;
  /** Share of rows missing the field (0–100). */
  missingPct: number;
  missingCount: number;
  totalCount: number;
  /** Deep-link URL the readiness card sends the operator to fix it. */
  fixUrl: string;
  /** Whether this blocker fully prevents the lever from running. */
  hard: boolean;
}

export interface LeverReadiness {
  leverId: LeverId;
  label: string;
  tier: 1 | 2 | 3 | 4 | 5;
  /** 0 = unusable, 100 = fully ready. */
  score: number;
  blockers: ReadinessBlocker[];
}

export interface ReadinessResult {
  /** Average of the per-lever scores, rounded to a whole number. */
  overallScore: number;
  /** False when *no* tenant data has been ingested yet. */
  hasIngestedData: boolean;
  /** Whether sample data is currently installed in the tenant. */
  sampleDataInstalled: boolean;
  levers: LeverReadiness[];
}

export interface ReadinessContext {
  orgId: string;
  /**
   * Base path the FE is served on (e.g. `/`). Blockers concatenate this
   * with the relevant page route so deep-links resolve through the proxy.
   */
  basePath?: string;
}
