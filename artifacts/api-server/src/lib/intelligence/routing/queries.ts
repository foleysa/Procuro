import { pool } from "@workspace/db";
import type { LeverId } from "@workspace/db";

/**
 * Sentinel categoryCode used by the per-lever rollup in
 * `funnel_snapshots.calibration` (task #218). Mirrors
 * `lib/ooda/funnel.ts:CALIBRATION_ROLLUP_CATEGORY` — duplicated here
 * to avoid pulling the routing module across the ooda boundary.
 */
const CALIBRATION_ROLLUP_CATEGORY = "_all" as const;

/**
 * Verdict gating thresholds for tier classification. Mirrors the ones
 * applied by the funnel snapshot writer (task #185 / #218) so that the
 * `verdict` field on a calibration entry and the `tier` returned here
 * agree on the same dead-band edges.
 */
const TIER_MIN_N = 10;
const TIER_DEAD_BAND_USD = 100;

/**
 * Read-side helpers backed by the `v_category_lever_mappings`
 * materialized view. These are the only queries that should hit the
 * routing tables from outside this module.
 */

export interface LeversForCategoryRow {
  leverId: LeverId;
  band: string;
  fitRank: number;
  confidenceWeight: number;
}

/**
 * Return the levers that apply to a canonical category code, ordered by
 * `confidence_weight` desc then `lever_id` asc for stable tie-break.
 *
 * v1 only returns `fit_rank = 1` rows — rank-2 fallbacks are seeded for
 * future use but kept off the read path until calibration evidence
 * supports surfacing them.
 */
export async function leversForCategory(
  canonicalCode: string,
): Promise<LeversForCategoryRow[]> {
  // Distinct on lever_id — when a category has dual-band coverage
  // (e.g. IRON_STEEL → indexable + concentrated) the same lever can
  // appear once per band. Callers expect one row per applicable
  // lever, so we collapse to the highest-confidence band for each
  // lever_id (DISTINCT ON in the ORDER BY).
  const { rows } = await pool.query<{
    lever_id: string;
    band: string;
    fit_rank: number;
    confidence_weight: number;
  }>(
    `SELECT DISTINCT ON (lever_id)
            lever_id, band, fit_rank, confidence_weight
       FROM v_category_lever_mappings
      WHERE category_code = $1
        AND fit_rank = 1
      ORDER BY lever_id ASC, confidence_weight DESC, band ASC`,
    [canonicalCode],
  );
  // Re-sort by confidence DESC for caller stability (DISTINCT ON
  // forced lever_id ASC ordering above).
  rows.sort((a, b) => {
    if (b.confidence_weight !== a.confidence_weight)
      return Number(b.confidence_weight) - Number(a.confidence_weight);
    return a.lever_id.localeCompare(b.lever_id);
  });
  return rows.map((r) => ({
    leverId: r.lever_id as LeverId,
    band: r.band,
    fitRank: r.fit_rank,
    confidenceWeight: Number(r.confidence_weight),
  }));
}

export interface CategoriesForLeverRow {
  categoryCode: string;
  band: string;
  confidenceWeight: number;
}

/**
 * Return canonical category codes that route to a given lever (rank-1
 * only). Used by analyzers that want to pre-filter their candidate
 * scope set.
 */
export async function categoriesForLever(
  leverId: LeverId,
): Promise<CategoriesForLeverRow[]> {
  // Distinct on category_code — same dual-band reasoning as
  // leversForCategory: a category can appear once per applicable
  // band; callers want one row per category.
  const { rows } = await pool.query<{
    category_code: string;
    band: string;
    confidence_weight: number;
  }>(
    `SELECT DISTINCT ON (category_code)
            category_code, band, confidence_weight
       FROM v_category_lever_mappings
      WHERE lever_id = $1
        AND fit_rank = 1
      ORDER BY category_code ASC, confidence_weight DESC, band ASC`,
    [leverId],
  );
  rows.sort((a, b) => {
    if (b.confidence_weight !== a.confidence_weight)
      return Number(b.confidence_weight) - Number(a.confidence_weight);
    return a.category_code.localeCompare(b.category_code);
  });
  return rows.map((r) => ({
    categoryCode: r.category_code,
    band: r.band,
    confidenceWeight: Number(r.confidence_weight),
  }));
}

/**
 * Determine `mapped_via` provenance for a canonical code. A code is
 * considered explicitly mapped when at least one band assignment exists
 * in `category_bands`; otherwise the routing fell back to the
 * Fragmented band and the resulting opportunities should be tagged
 * `unmapped_default` so calibration can exclude them.
 */
export async function isCanonicalCodeRouted(
  canonicalCode: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM category_bands
      WHERE category_code = $1`,
    [canonicalCode],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/**
 * Look up the highest-ranked band assignment for a canonical code (the
 * one a category would resolve into for lever applicability decisions).
 * Returns `null` if the code is unrouted.
 */
export async function bandForCategory(
  canonicalCode: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ band: string }>(
    `SELECT band
       FROM category_bands
      WHERE category_code = $1
      ORDER BY confidence_weight DESC, band ASC
      LIMIT 1`,
    [canonicalCode],
  );
  return rows[0]?.band ?? null;
}

/**
 * Return the union of `lever_id`s allowed under the Fragmented
 * fallback band. This is the applicability set for any category that
 * is unrouted (no `category_bands` row) — without this gate, the
 * category × band × lever spine has no teeth on uncategorized drafts
 * and a "concentrated"-only lever can persist against an unmapped
 * category. Distinct on lever_id so dual-band rows collapse.
 */
export async function leversInFragmentedFallback(): Promise<Set<string>> {
  const { rows } = await pool.query<{ lever_id: string }>(
    `SELECT DISTINCT lever_id
       FROM v_category_lever_mappings
      WHERE band = 'fragmented'`,
  );
  return new Set(rows.map((r) => r.lever_id));
}

// ─────────────────────────────────────────────────────────────────────
// Tier suggestion (task #218)
// ─────────────────────────────────────────────────────────────────────

export type TierSuggestion =
  | "tier_a"
  | "tier_b"
  | "tier_c_or_d"
  | "insufficient_data";

export interface SuggestTierResult {
  tier: TierSuggestion;
  improvementUsd: number | null;
  n: number | null;
  window: "30d" | "90d";
  /**
   * True when the per-(lever, category) bucket was missing for the
   * tenant's latest snapshot and the helper fell back to the
   * `<leverId>:_all` rollup. Callers can use this to badge the
   * suggestion as a coarser estimate.
   */
  fellBackToLeverRollup: boolean;
}

interface CalibrationEntry {
  leverId?: string;
  categoryCode?: string;
  window?: string;
  n?: number;
  rawMedianAbsErrorUsd?: number;
  rescaledMedianAbsErrorUsd?: number;
  improvementUsd?: number;
  verdict?: string;
}

/**
 * Per-(category, lever) tier classification backed by the most-recent
 * `funnel_snapshots.calibration` block for the tenant (task #218).
 *
 * Reads the latest snapshot's calibration map, looks up the
 * `<leverId>:<categoryCode>:<window>` entry, and classifies the
 * `improvementUsd` field against the same dead-band the funnel writer
 * uses for its `verdict`:
 *
 *   - `n < 10`                      → `insufficient_data`
 *   - `improvementUsd > +$100`      → `tier_a`        (priors helping)
 *   - `improvementUsd ∈ [-100,+100]` → `tier_b`       (priors neutral)
 *   - `improvementUsd < -$100`      → `tier_c_or_d`  (priors hurting)
 *
 * When the per-(category, lever) bucket is missing, the helper falls
 * back to the `<leverId>:_all` rollup and sets
 * `fellBackToLeverRollup: true` so callers can badge the answer as a
 * coarser, cross-category estimate.
 *
 * Returns `insufficient_data` with null metrics when no snapshot
 * exists for the org or neither bucket is present in the latest one.
 */
export async function suggestTierForCategoryLever(args: {
  orgId: string;
  categoryCode: string;
  leverId: LeverId;
  window?: "30d" | "90d";
}): Promise<SuggestTierResult> {
  const window = args.window ?? "90d";
  const { rows } = await pool.query<{ calibration: Record<string, unknown> | null }>(
    `SELECT calibration
       FROM funnel_snapshots
      WHERE org_id = $1
      ORDER BY cycle_generation DESC
      LIMIT 1`,
    [args.orgId],
  );
  const calibration = rows[0]?.calibration ?? null;
  if (!calibration) {
    return {
      tier: "insufficient_data",
      improvementUsd: null,
      n: null,
      window,
      fellBackToLeverRollup: false,
    };
  }
  const map = calibration as Record<string, CalibrationEntry>;
  const primaryKey = `${args.leverId}:${args.categoryCode}:${window}`;
  const fallbackKey = `${args.leverId}:${CALIBRATION_ROLLUP_CATEGORY}:${window}`;
  let entry = map[primaryKey];
  let fellBack = false;
  if (!entry) {
    entry = map[fallbackKey];
    fellBack = true;
  }
  if (!entry || typeof entry.n !== "number") {
    return {
      tier: "insufficient_data",
      improvementUsd: null,
      n: null,
      window,
      fellBackToLeverRollup: false,
    };
  }
  const n = entry.n;
  const improvementUsd =
    typeof entry.improvementUsd === "number" ? entry.improvementUsd : null;
  if (n < TIER_MIN_N || improvementUsd == null) {
    return {
      tier: "insufficient_data",
      improvementUsd,
      n,
      window,
      fellBackToLeverRollup: fellBack,
    };
  }
  let tier: TierSuggestion;
  if (improvementUsd > TIER_DEAD_BAND_USD) {
    tier = "tier_a";
  } else if (improvementUsd < -TIER_DEAD_BAND_USD) {
    tier = "tier_c_or_d";
  } else {
    tier = "tier_b";
  }
  return {
    tier,
    improvementUsd,
    n,
    window,
    fellBackToLeverRollup: fellBack,
  };
}
