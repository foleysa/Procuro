import { pool } from "@workspace/db";
import { logger } from "../../logger";
import { refreshCategoryLeverMappings } from "./materialized-view";

interface HealthMetadata {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  consecutiveFailures: number;
}

const metadata: HealthMetadata = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
};

export function getRoutingHealthMetadata(): HealthMetadata {
  return { ...metadata };
}

/**
 * Routing health check — row-by-row consistency.
 *
 * The materialized view `v_category_lever_mappings` is a snapshot of
 * the truth-table join `category_bands ⋈ lever_bands`. Three failure
 * modes can desynchronize them:
 *
 *   1. INSERT into a truth table without a refresh
 *      → view is missing rows
 *   2. DELETE from a truth table without a refresh
 *      → view has stale rows
 *   3. UPDATE of `confidence_weight` on a truth-table row without a
 *      refresh → row sets match but values differ. A pure count check
 *      cannot detect this; downstream `confidence_weight` ordering
 *      silently goes wrong.
 *
 * Per spec ("Consistency check") we therefore do a full row-level
 * diff every run, comparing the joined identity tuple AND the
 * confidence_weight value via FULL OUTER JOIN. Any divergence is a
 * snapshot-failure-style alert.
 *
 * Failure recovery: if `autoRefreshOnDrift` is true (the default) we
 * trigger one refresh and re-scan to absorb transient staleness from
 * a write that landed between the trigger fire and our SELECT. If the
 * second scan is still divergent we surface as `ok = false`.
 */
export interface DriftSample {
  /** Row exists in truth tables but is missing from the view. */
  side: "expected_only" | "view_only" | "weight_mismatch";
  categoryCode: string;
  leverId: string;
  band: string;
  expectedConfidenceWeight: number | null;
  viewConfidenceWeight: number | null;
}

export interface RoutingHealthReport {
  ok: boolean;
  expectedRowCount: number;
  viewRowCount: number;
  /** Total row-level drift: rows missing from view + rows missing from
   *  truth tables + rows present in both but whose confidence_weight
   *  disagrees. */
  drift: number;
  /** Symmetric difference + value-mismatch samples, capped at
   *  `MAX_DRIFT_SAMPLES`. Empty when `ok = true`. */
  driftSamples: DriftSample[];
  recoveredByRefresh: boolean;
  checkedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
}

const MAX_DRIFT_SAMPLES = 25;

interface CheckOptions {
  /** When true, the check refreshes the view before scanning at all.
   *  The scheduled `routing_health_check` handler sets this so that
   *  `confidence_weight` UPDATEs (which the row-trigger does not see —
   *  triggers only fire on truth-table writes, and the scheduler also
   *  needs to absorb time-based staleness from concurrent UPDATEs)
   *  are picked up every cycle. Defaults to false so callers that
   *  just want to inspect current state get a true picture. */
  refreshFirst?: boolean;
  /** When true (default), if the initial scan finds drift we trigger a
   *  refresh and re-scan once to absorb transient staleness. The
   *  per-cycle scheduled handler sets this to false because it has
   *  already refreshed up front via `refreshFirst`. */
  autoRefreshOnDrift?: boolean;
}

export async function checkRoutingHealth(
  options: CheckOptions = {},
): Promise<RoutingHealthReport> {
  const refreshFirst = options.refreshFirst ?? false;
  const autoRefreshOnDrift = options.autoRefreshOnDrift ?? true;
  const checkedAt = new Date().toISOString();

  if (refreshFirst) {
    await refreshCategoryLeverMappings();
  }

  let scan = await scanForDrift();

  if (scan.driftCount > 0 && autoRefreshOnDrift) {
    await refreshCategoryLeverMappings();
    const after = await scanForDrift();
    if (after.driftCount === 0) {
      logger.warn(
        {
          driftBefore: scan.driftCount,
          expected: after.expectedCount,
          view: after.viewCount,
        },
        "Routing materialized view was stale — recovered by refresh",
      );
      return recordSuccess({
        ok: true,
        expectedRowCount: after.expectedCount,
        viewRowCount: after.viewCount,
        drift: 0,
        driftSamples: [],
        recoveredByRefresh: true,
        checkedAt,
      });
    }
    scan = after;
  }

  if (scan.driftCount === 0) {
    return recordSuccess({
      ok: true,
      expectedRowCount: scan.expectedCount,
      viewRowCount: scan.viewCount,
      drift: 0,
      driftSamples: [],
      recoveredByRefresh: false,
      checkedAt,
    });
  }

  const driftSamples = await collectDriftSamples(MAX_DRIFT_SAMPLES);
  const report = recordFailure({
    ok: false,
    expectedRowCount: scan.expectedCount,
    viewRowCount: scan.viewCount,
    drift: scan.driftCount,
    driftSamples,
    recoveredByRefresh: false,
    checkedAt,
  });
  logger.error(
    {
      expected: scan.expectedCount,
      view: scan.viewCount,
      drift: scan.driftCount,
      sampleCount: driftSamples.length,
      samples: driftSamples,
    },
    "Routing materialized view drift could not be recovered by refresh",
  );
  return report;
}

function recordSuccess(
  partial: Omit<
    RoutingHealthReport,
    "lastSuccessAt" | "lastFailureAt" | "consecutiveFailures"
  >,
): RoutingHealthReport {
  metadata.lastSuccessAt = partial.checkedAt;
  metadata.consecutiveFailures = 0;
  return { ...partial, ...metadata };
}

function recordFailure(
  partial: Omit<
    RoutingHealthReport,
    "lastSuccessAt" | "lastFailureAt" | "consecutiveFailures"
  >,
): RoutingHealthReport {
  metadata.lastFailureAt = partial.checkedAt;
  metadata.lastFailureReason = `drift=${partial.drift}, expected=${partial.expectedRowCount}, view=${partial.viewRowCount}`;
  metadata.consecutiveFailures += 1;
  return { ...partial, ...metadata };
}

interface ScanResult {
  expectedCount: number;
  viewCount: number;
  driftCount: number;
}

/**
 * Single-round-trip row-level scan. Computes:
 *   - count(*) of expected rows (truth-table join)
 *   - count(*) of materialized view rows
 *   - count of (expected_only ∪ view_only ∪ weight_mismatch)
 *
 * The FULL OUTER JOIN below is keyed on (category_code, lever_id, band)
 * so any of the three drift modes shows up as a non-matching pair.
 * `confidence_weight` is compared with `IS DISTINCT FROM` so NULL on
 * either side counts as a mismatch.
 */
async function scanForDrift(): Promise<ScanResult> {
  const { rows } = await pool.query<{
    expected_count: string;
    view_count: string;
    drift_count: string;
  }>(
    `WITH expected AS (
       SELECT cb.category_code,
              lb.lever_id,
              cb.band,
              cb.confidence_weight
         FROM category_bands cb
         JOIN lever_bands lb USING (band)
     ),
     joined AS (
       SELECT e.category_code  AS e_cat,
              e.lever_id       AS e_lever,
              e.band           AS e_band,
              e.confidence_weight AS e_w,
              v.category_code  AS v_cat,
              v.lever_id       AS v_lever,
              v.band           AS v_band,
              v.confidence_weight AS v_w
         FROM expected e
    FULL OUTER JOIN v_category_lever_mappings v
           ON e.category_code = v.category_code
          AND e.lever_id      = v.lever_id
          AND e.band          = v.band
     )
     SELECT (SELECT count(*)::text FROM expected) AS expected_count,
            (SELECT count(*)::text FROM v_category_lever_mappings) AS view_count,
            count(*) FILTER (
              WHERE e_cat IS NULL
                 OR v_cat IS NULL
                 OR e_w IS DISTINCT FROM v_w
            )::text AS drift_count
       FROM joined`,
  );
  const r = rows[0];
  return {
    expectedCount: Number(r?.expected_count ?? 0),
    viewCount: Number(r?.view_count ?? 0),
    driftCount: Number(r?.drift_count ?? 0),
  };
}

/**
 * Collect at most `limit` drift samples across the three drift sides.
 * Single round-trip via UNION ALL with per-side LIMIT.
 */
async function collectDriftSamples(limit: number): Promise<DriftSample[]> {
  const per = Math.max(1, Math.floor(limit / 3));
  const { rows } = await pool.query<{
    side: "expected_only" | "view_only" | "weight_mismatch";
    category_code: string;
    lever_id: string;
    band: string;
    expected_w: number | null;
    view_w: number | null;
  }>(
    `(
       SELECT 'expected_only'::text AS side,
              cb.category_code, lb.lever_id, cb.band,
              cb.confidence_weight::float8 AS expected_w,
              NULL::float8 AS view_w
         FROM category_bands cb
         JOIN lever_bands lb USING (band)
        WHERE NOT EXISTS (
                SELECT 1 FROM v_category_lever_mappings v
                 WHERE v.category_code = cb.category_code
                   AND v.lever_id = lb.lever_id
                   AND v.band = cb.band
              )
        LIMIT $1
     )
     UNION ALL
     (
       SELECT 'view_only'::text AS side,
              v.category_code, v.lever_id, v.band,
              NULL::float8 AS expected_w,
              v.confidence_weight::float8 AS view_w
         FROM v_category_lever_mappings v
        WHERE NOT EXISTS (
                SELECT 1
                  FROM category_bands cb
                  JOIN lever_bands lb USING (band)
                 WHERE cb.category_code = v.category_code
                   AND lb.lever_id = v.lever_id
                   AND cb.band = v.band
              )
        LIMIT $1
     )
     UNION ALL
     (
       SELECT 'weight_mismatch'::text AS side,
              cb.category_code, lb.lever_id, cb.band,
              cb.confidence_weight::float8 AS expected_w,
              v.confidence_weight::float8 AS view_w
         FROM category_bands cb
         JOIN lever_bands lb USING (band)
         JOIN v_category_lever_mappings v
           ON v.category_code = cb.category_code
          AND v.lever_id = lb.lever_id
          AND v.band = cb.band
        WHERE cb.confidence_weight IS DISTINCT FROM v.confidence_weight
        LIMIT $1
     )`,
    [per],
  );
  return rows.map((r) => ({
    side: r.side,
    categoryCode: r.category_code,
    leverId: r.lever_id,
    band: r.band,
    expectedConfidenceWeight: r.expected_w,
    viewConfidenceWeight: r.view_w,
  }));
}
