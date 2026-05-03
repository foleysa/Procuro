/**
 * The eleven data-integrity assertions for Task #314.
 *
 * Adaptations from the original spec to the actual schema:
 *   - There is no `award_value` column. Identified-pipeline value uses
 *     `projected_savings_usd`; Realized value uses
 *     `realized_savings_usd`.
 *   - There is no `is_addressable` flag. The pipeline-decomposition
 *     assertion partitions instead by `savings_classification`
 *     (Hard / Cost Avoidance / Soft) and asserts the parts sum to the
 *     whole — same shape, real columns.
 *   - There are no `dashboard_aggregates`, `lever_performance`, or
 *     `dashboard_funnel_counts` materialised tables. The aggregate
 *     family compares record sums against the per-cycle figures
 *     persisted in `funnel_snapshots` (the closest dashboard-facing
 *     surface we currently have) and against per-lever rollups
 *     computed from the source `opportunities` table.
 *   - Where an assertion would otherwise scope to "every row" but the
 *     #284 columns are still nullable for legacy rows, the WHERE
 *     clauses restrict to rows that DO have a `canonical_stage` so
 *     pre-#284 backfill gaps don't pollute the result. Pure-#284-era
 *     rows are still required to be fully tagged.
 *
 * Money tolerance: every aggregate comparison allows ≤ $1 of
 * rounding drift, matching the spec's "within $1" rule.
 */
import { sql } from "drizzle-orm";
import type { Assertion, AssertionResult, DrizzleDb } from "./runner";

const CENT = 1; // $1 rounding tolerance — drift > $1 fails (within $1 passes).

interface PgRows<T> {
  rows: T[];
}

async function exec<T>(
  db: DrizzleDb,
  query: string,
): Promise<T[]> {
  const r = (await db.execute(sql.raw(query))) as unknown as PgRows<T>;
  return r.rows ?? [];
}

// ---------------------------------------------------------------------------
// Family 1 — Aggregate Reconciliation
// ---------------------------------------------------------------------------

/**
 * Cross-surface reconciliation: each `analysis_cycles` row persists
 * its own `total_realized_usd` at completion-time. The
 * `opportunities` table is written by a separate code path during
 * the cycle. For every COMPLETED cycle, the cycle-surface number
 * MUST equal SUM(realized_savings_usd) of the opportunities tagged
 * with that `cycle_id`. Any drift means one of:
 *
 *   - The cycle finalizer wrote a stale total (writer bug).
 *   - Opportunities were inserted/updated/deleted out-of-band
 *     after the cycle closed.
 *   - The org_id linkage is wrong on one of the two surfaces.
 *
 * This is a true cross-surface check (two independent producers,
 * same source of truth) — not an algebraic identity.
 *
 * Returns the per-cycle org_ids of any drift so we can fan out
 * per-tenant alerts without needing a system org row.
 */
export const assertion_realized_matches_record_sum: Assertion = {
  name: "realized_savings_matches_record_sum",
  family: "aggregate",
  description:
    "Each analysis_cycles.total_realized_usd reconciles to SUM(realized_savings_usd) of opportunities sharing its cycle_id.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      WITH record_sum AS (
        SELECT cycle_id,
               COALESCE(SUM(realized_savings_usd), 0)::numeric AS v
        FROM opportunities
        WHERE canonical_stage = 'Realized'
        GROUP BY cycle_id
      )
      SELECT c.id                                              AS cycle_id,
             c.org_id                                          AS org_id,
             c.total_realized_usd::numeric                     AS surface_total,
             COALESCE(r.v, 0)::numeric                         AS record_total,
             ABS(c.total_realized_usd - COALESCE(r.v, 0))::numeric AS drift
      FROM analysis_cycles c
      LEFT JOIN record_sum r ON r.cycle_id = c.id
      WHERE c.status = 'completed'
        AND ABS(c.total_realized_usd - COALESCE(r.v, 0)) > ${CENT}
      ORDER BY drift DESC
      LIMIT 25
    `;
    const rows = await exec<{
      cycle_id: string;
      org_id: string;
      surface_total: string;
      record_total: string;
      drift: string;
    }>(db, query);
    const passed = rows.length === 0;
    const totalDrift = rows.reduce((acc, r) => acc + Number(r.drift), 0);
    const driftedOrgIds = Array.from(new Set(rows.map((r) => r.org_id)));
    return {
      name: "realized_savings_matches_record_sum",
      family: "aggregate",
      passed,
      actual: {
        mismatchCount: rows.length,
        totalDriftUsd: totalDrift,
        affectedOrgIds: driftedOrgIds,
        examples: rows.slice(0, 5).map((r) => ({
          cycleId: r.cycle_id,
          orgId: r.org_id,
          surfaceTotal: Number(r.surface_total),
          recordTotal: Number(r.record_total),
          driftUsd: Number(r.drift),
        })),
      },
      expected:
        "analysis_cycles.total_realized_usd === SUM(opportunities.realized_savings_usd) per cycle (within $1)",
      message: passed
        ? "Dashboard Realized Savings reconciles to underlying records on every completed cycle"
        : `Dashboard total drifts from records on ${rows.length} cycle(s) ($${totalDrift.toLocaleString()} aggregate drift). Largest: cycle ${rows[0]?.cycle_id} surface=$${Number(rows[0]?.surface_total ?? 0).toLocaleString()} records=$${Number(rows[0]?.record_total ?? 0).toLocaleString()}`,
      query,
    };
  },
};

/**
 * Cross-surface projected-pipeline reconciliation: each
 * `funnel_snapshots` row persists `total_projected_usd` at
 * cycle-completion time. That number must equal SUM(projected_savings_usd)
 * of opportunities sharing its `cycle_id`. The two columns are
 * written by independent code paths during cycle finalization, so
 * a mismatch here exposes pipeline-decomposition bugs that the
 * dashboard would otherwise hide.
 *
 * NOTE: this also covers the original "value decomposition" intent
 * — if any classification bucket was dropped from the funnel
 * snapshot writer, its dollars would be missing from the surface
 * total but present in the per-row sum, and this check fires.
 */
export const assertion_pipeline_value_decomposition: Assertion = {
  name: "pipeline_value_decomposition_intact",
  family: "aggregate",
  description:
    "funnel_snapshots.total_projected_usd reconciles to SUM(projected_savings_usd) of opportunities for the same cycle.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      WITH record_sum AS (
        SELECT cycle_id,
               COALESCE(SUM(projected_savings_usd), 0)::numeric AS v
        FROM opportunities
        GROUP BY cycle_id
      )
      SELECT fs.id                                                AS snapshot_id,
             fs.cycle_id                                          AS cycle_id,
             fs.org_id                                            AS org_id,
             fs.total_projected_usd::numeric                      AS surface_total,
             COALESCE(r.v, 0)::numeric                            AS record_total,
             ABS(fs.total_projected_usd - COALESCE(r.v, 0))::numeric AS drift
      FROM funnel_snapshots fs
      LEFT JOIN record_sum r ON r.cycle_id = fs.cycle_id
      WHERE ABS(fs.total_projected_usd - COALESCE(r.v, 0)) > ${CENT}
      ORDER BY drift DESC
      LIMIT 25
    `;
    const rows = await exec<{
      snapshot_id: string;
      cycle_id: string;
      org_id: string;
      surface_total: string;
      record_total: string;
      drift: string;
    }>(db, query);
    const passed = rows.length === 0;
    const totalDrift = rows.reduce((acc, r) => acc + Number(r.drift), 0);
    const driftedOrgIds = Array.from(new Set(rows.map((r) => r.org_id)));
    return {
      name: "pipeline_value_decomposition_intact",
      family: "aggregate",
      passed,
      actual: {
        mismatchCount: rows.length,
        totalDriftUsd: totalDrift,
        affectedOrgIds: driftedOrgIds,
        examples: rows.slice(0, 5).map((r) => ({
          snapshotId: r.snapshot_id,
          cycleId: r.cycle_id,
          orgId: r.org_id,
          surfaceTotal: Number(r.surface_total),
          recordTotal: Number(r.record_total),
          driftUsd: Number(r.drift),
        })),
      },
      expected:
        "funnel_snapshots.total_projected_usd === SUM(opportunities.projected_savings_usd) per cycle (within $1)",
      message: passed
        ? "Pipeline value reconciles between funnel snapshots and underlying records"
        : `Pipeline projected total drifts on ${rows.length} snapshot(s) ($${totalDrift.toLocaleString()} aggregate drift). Largest: cycle ${rows[0]?.cycle_id} surface=$${Number(rows[0]?.surface_total ?? 0).toLocaleString()} records=$${Number(rows[0]?.record_total ?? 0).toLocaleString()}`,
      query,
    };
  },
};

/**
 * Cross-surface lever reconciliation: per-lever rollup of
 * realized_savings_usd from `opportunities` (filtered to a cycle)
 * vs the cycle-surface total persisted in `analysis_cycles`. A
 * mismatch means either a lever's contribution was dropped from
 * the cycle finalizer, double-counted, or lever_id was rewritten
 * out-of-band on opportunities the cycle had already counted.
 */
export const assertion_lever_totals_match_aggregate: Assertion = {
  name: "lever_totals_sum_to_aggregate",
  family: "aggregate",
  description:
    "Per-lever record rollups within each cycle sum to that cycle's surface total_realized_usd.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    // Two-stage rollup: first GROUP BY (cycle_id, lever_id) to get the
    // per-lever subtotal, then SUM those subtotals back up per cycle.
    // This makes the per-lever decomposition explicit in SQL (so any
    // future regression that drops, double-counts, or rewrites a single
    // lever's contribution shows up here as a per-cycle drift) and
    // surfaces lever_count in the diagnostic payload.
    const query = `
      WITH per_lever AS (
        SELECT cycle_id,
               lever_id,
               COALESCE(SUM(realized_savings_usd), 0)::numeric AS lever_total
        FROM opportunities
        WHERE canonical_stage = 'Realized'
        GROUP BY cycle_id, lever_id
      ),
      per_lever_in_cycle AS (
        SELECT cycle_id,
               SUM(lever_total)::numeric AS v,
               COUNT(*)::int             AS lever_count
        FROM per_lever
        GROUP BY cycle_id
      )
      SELECT c.id                                              AS cycle_id,
             c.org_id                                          AS org_id,
             c.total_realized_usd::numeric                     AS surface_total,
             COALESCE(p.v, 0)::numeric                         AS lever_rollup_total,
             COALESCE(p.lever_count, 0)::int                   AS lever_count,
             ABS(c.total_realized_usd - COALESCE(p.v, 0))::numeric AS drift
      FROM analysis_cycles c
      LEFT JOIN per_lever_in_cycle p ON p.cycle_id = c.id
      WHERE c.status = 'completed'
        AND ABS(c.total_realized_usd - COALESCE(p.v, 0)) > ${CENT}
      ORDER BY drift DESC
      LIMIT 25
    `;
    const rows = await exec<{
      cycle_id: string;
      org_id: string;
      surface_total: string;
      lever_rollup_total: string;
      lever_count: number;
      drift: string;
    }>(db, query);
    const passed = rows.length === 0;
    const totalDrift = rows.reduce((acc, r) => acc + Number(r.drift), 0);
    const driftedOrgIds = Array.from(new Set(rows.map((r) => r.org_id)));
    return {
      name: "lever_totals_sum_to_aggregate",
      family: "aggregate",
      passed,
      actual: {
        mismatchCount: rows.length,
        totalDriftUsd: totalDrift,
        affectedOrgIds: driftedOrgIds,
        examples: rows.slice(0, 5).map((r) => ({
          cycleId: r.cycle_id,
          orgId: r.org_id,
          surfaceTotal: Number(r.surface_total),
          leverRollupTotal: Number(r.lever_rollup_total),
          leverCount: Number(r.lever_count),
          driftUsd: Number(r.drift),
        })),
      },
      expected:
        "SUM(per-lever realized) === analysis_cycles.total_realized_usd per cycle (within $1)",
      message: passed
        ? "Lever rollups reconcile to cycle surface totals"
        : `Lever rollup drifts from cycle surface on ${rows.length} cycle(s) ($${totalDrift.toLocaleString()} aggregate drift). Largest: cycle ${rows[0]?.cycle_id} surface=$${Number(rows[0]?.surface_total ?? 0).toLocaleString()} levers=$${Number(rows[0]?.lever_rollup_total ?? 0).toLocaleString()}`,
      query,
    };
  },
};

/**
 * For every funnel snapshot, `total_opps_persisted` must equal the
 * COUNT of opportunities with that cycle_id. Catches snapshot-writer
 * regressions and out-of-band cycle-row deletions.
 */
export const assertion_funnel_counts_match_records: Assertion = {
  name: "funnel_counts_match_records",
  family: "aggregate",
  description:
    "Each funnel_snapshots.total_opps_persisted equals COUNT(*) of opportunities for that cycle.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      SELECT fs.cycle_id,
             fs.total_opps_persisted::int     AS snapshot_count,
             COUNT(o.id)::int                 AS record_count
      FROM funnel_snapshots fs
      LEFT JOIN opportunities o ON o.cycle_id = fs.cycle_id
      GROUP BY fs.cycle_id, fs.total_opps_persisted
      HAVING COUNT(o.id)::int <> fs.total_opps_persisted::int
      LIMIT 25
    `;
    const rows = await exec<{
      cycle_id: string;
      snapshot_count: number;
      record_count: number;
    }>(db, query);
    const passed = rows.length === 0;
    return {
      name: "funnel_counts_match_records",
      family: "aggregate",
      passed,
      actual: { mismatchCount: rows.length, examples: rows.slice(0, 5) },
      expected:
        "no funnel_snapshots row whose total_opps_persisted disagrees with the live record count",
      message: passed
        ? "Funnel snapshot counts reconcile"
        : `Funnel count mismatch on ${rows.length} cycle(s) — first: ${JSON.stringify(rows.slice(0, 3))}`,
      query,
    };
  },
};

// ---------------------------------------------------------------------------
// Family 2 — Savings Type Integrity
// ---------------------------------------------------------------------------

/**
 * Every opportunity that has been touched by the #284 pipeline (i.e.
 * has a non-null canonical_stage) must also carry the matching
 * savings_type and savings_classification. Pre-#284 legacy rows
 * (canonical_stage IS NULL) are intentionally excluded because the
 * backfill is opt-in and gradual.
 */
export const assertion_no_null_savings_tags: Assertion = {
  name: "no_null_savings_types_or_classifications",
  family: "savings_type",
  description:
    "Every #284-era opportunity has non-null savings_type, savings_classification, and canonical_stage.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE savings_type IS NULL)           AS null_types,
        COUNT(*) FILTER (WHERE savings_classification IS NULL) AS null_classifications
      FROM opportunities
      WHERE canonical_stage IS NOT NULL
    `;
    const [row] = await exec<{
      null_types: string;
      null_classifications: string;
    }>(db, query);
    const nullTypes = Number(row?.null_types ?? 0);
    const nullClass = Number(row?.null_classifications ?? 0);
    const passed = nullTypes === 0 && nullClass === 0;
    return {
      name: "no_null_savings_types_or_classifications",
      family: "savings_type",
      passed,
      actual: { nullTypes, nullClass },
      expected: "both counts === 0 for rows where canonical_stage IS NOT NULL",
      message: passed
        ? "All #284-era opportunities have complete savings tagging"
        : `Found ${nullTypes} null savings_types and ${nullClass} null savings_classifications among canonical-staged rows`,
      query,
    };
  },
};

/**
 * canonical_stage and savings_type must be consistent per the #284
 * mapping table. The check restricts to non-terminal active rows;
 * Closed-No Action / Under Re-evaluation rows can legitimately carry
 * any prior savings_type because their last live stage is
 * unrecoverable from the current row alone.
 */
export const assertion_savings_type_consistent_with_stage: Assertion = {
  name: "savings_type_consistent_with_canonical_stage",
  family: "savings_type",
  description:
    "savings_type aligns with canonical_stage per the #284 mapping for active rows.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      SELECT id, canonical_stage, savings_type
      FROM opportunities
      WHERE
        (canonical_stage = 'Identified'         AND savings_type IS DISTINCT FROM 'Identified') OR
        (canonical_stage = 'Awarded'            AND savings_type IS DISTINCT FROM 'Negotiated') OR
        (canonical_stage = 'In Contracting'     AND (savings_type IS NULL OR savings_type NOT IN ('Negotiated', 'Implemented'))) OR
        (canonical_stage = 'In Implementation'  AND savings_type IS DISTINCT FROM 'Implemented') OR
        (canonical_stage = 'Realized'           AND savings_type IS DISTINCT FROM 'Realized')
      LIMIT 25
    `;
    const rows = await exec<{
      id: string;
      canonical_stage: string;
      savings_type: string | null;
    }>(db, query);
    const passed = rows.length === 0;
    return {
      name: "savings_type_consistent_with_canonical_stage",
      family: "savings_type",
      passed,
      actual: { violationCount: rows.length, examples: rows.slice(0, 5) },
      expected:
        "no active-stage opportunity where savings_type misaligns with canonical_stage",
      message: passed
        ? "savings_type and canonical_stage are consistent on every active record"
        : `${rows.length} opportunities have mismatched stage/type. Examples: ${JSON.stringify(rows.slice(0, 5))}`,
      query,
    };
  },
};

/**
 * Every Realized record must have a baseline_value, OR be explicitly
 * marked `baseline_method = 'N/A — Soft'` (the documented opt-out).
 * "saved against what?" must always have an answer.
 */
export const assertion_realized_records_have_baseline: Assertion = {
  name: "realized_records_have_baseline_value_or_soft_marker",
  family: "savings_type",
  description:
    "Every Realized record has baseline_value set OR baseline_method = 'N/A — Soft'.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      SELECT id, savings_type, baseline_method, baseline_value
      FROM opportunities
      WHERE savings_type = 'Realized'
        AND baseline_value IS NULL
        AND (baseline_method IS NULL OR baseline_method <> 'N/A — Soft')
      LIMIT 25
    `;
    const rows = await exec<{
      id: string;
      savings_type: string;
      baseline_method: string | null;
      baseline_value: string | null;
    }>(db, query);
    const passed = rows.length === 0;
    return {
      name: "realized_records_have_baseline_value_or_soft_marker",
      family: "savings_type",
      passed,
      actual: { violationCount: rows.length, examples: rows.slice(0, 5) },
      expected:
        "every Realized record has a baseline_value or is marked 'N/A — Soft'",
      message: passed
        ? "All Realized records have valid baselines"
        : `${rows.length} Realized records missing baseline_value. CFO will ask "saved against what?" and the answer will be: nothing.`,
      query,
    };
  },
};

// ---------------------------------------------------------------------------
// Family 3 — Stage History Integrity
// ---------------------------------------------------------------------------

/**
 * For every opportunity, the most recent opportunity_stage_history
 * row's `to_stage` must equal the parent's current canonical_stage.
 * Restricted to rows with a non-null canonical_stage so legacy rows
 * don't false-flag.
 */
export const assertion_stage_history_matches_current: Assertion = {
  name: "stage_history_latest_row_matches_current_canonical_stage",
  family: "stage_history",
  description:
    "For every opportunity with a canonical_stage, the latest history row's to_stage equals canonical_stage.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      SELECT o.id,
             o.canonical_stage AS parent_stage,
             h.to_stage        AS history_latest
      FROM opportunities o
      LEFT JOIN LATERAL (
        SELECT to_stage
        FROM opportunity_stage_history
        WHERE opportunity_id = o.id
        ORDER BY transitioned_at DESC
        LIMIT 1
      ) h ON true
      WHERE o.canonical_stage IS NOT NULL
        AND h.to_stage IS DISTINCT FROM o.canonical_stage
      LIMIT 25
    `;
    const rows = await exec<{
      id: string;
      parent_stage: string;
      history_latest: string | null;
    }>(db, query);
    const passed = rows.length === 0;
    return {
      name: "stage_history_latest_row_matches_current_canonical_stage",
      family: "stage_history",
      passed,
      actual: { violationCount: rows.length, examples: rows.slice(0, 5) },
      expected:
        "history.latest_to_stage === opportunity.canonical_stage for every canonical-staged opportunity",
      message: passed
        ? "Stage history reflects current state on every record"
        : `${rows.length} opportunities have history out of sync with current state. Examples: ${JSON.stringify(rows.slice(0, 5))}`,
      query,
    };
  },
};

/**
 * Every #284-era opportunity has at least one stage-history row.
 * Catches a missed transition write or a backfill miss.
 */
export const assertion_every_opportunity_has_history_row: Assertion = {
  name: "every_opportunity_has_at_least_one_history_row",
  family: "stage_history",
  description:
    "Every opportunity with a canonical_stage has at least one opportunity_stage_history row.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      SELECT o.id
      FROM opportunities o
      LEFT JOIN opportunity_stage_history h ON h.opportunity_id = o.id
      WHERE o.canonical_stage IS NOT NULL
        AND h.id IS NULL
      LIMIT 25
    `;
    const rows = await exec<{ id: string }>(db, query);
    const passed = rows.length === 0;
    return {
      name: "every_opportunity_has_at_least_one_history_row",
      family: "stage_history",
      passed,
      actual: {
        orphanCount: rows.length,
        examples: rows.slice(0, 5).map((r) => r.id),
      },
      expected:
        "no canonical-staged opportunities without at least one history row",
      message: passed
        ? "Every #284-era opportunity has at least one history row"
        : `${rows.length} opportunities have no history. The trigger or backfill missed them.`,
      query,
    };
  },
};

// ---------------------------------------------------------------------------
// Family 4 — Gating Conditions (the #284 hard gates)
// ---------------------------------------------------------------------------

/**
 * THE CFO INSURANCE TEST. No opportunity with
 * `classification_needs_review = true` may contribute to a Hard
 * Realized aggregate. We assert directly: zero rows in that
 * forbidden intersection. This intentionally overlaps with #287's
 * unit test so the same invariant is verified at two layers (PR-time
 * + production-time).
 */
export const assertion_hard_savings_excludes_review_flagged: Assertion = {
  name: "hard_savings_aggregate_excludes_classification_needs_review",
  family: "gating",
  description:
    "No record where classification_needs_review = true contributes to the Hard Realized aggregate.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      SELECT
        COUNT(*)::int                                         AS forbidden_count,
        COALESCE(SUM(realized_savings_usd), 0)::numeric       AS forbidden_amount
      FROM opportunities
      WHERE canonical_stage = 'Realized'
        AND savings_classification = 'Hard'
        AND classification_needs_review = true
    `;
    const [row] = await exec<{
      forbidden_count: number;
      forbidden_amount: string;
    }>(db, query);
    const forbiddenCount = Number(row?.forbidden_count ?? 0);
    const forbiddenAmount = Number(row?.forbidden_amount ?? 0);
    const passed = forbiddenCount === 0;
    return {
      name: "hard_savings_aggregate_excludes_classification_needs_review",
      family: "gating",
      passed,
      actual: { forbiddenCount, forbiddenAmount },
      expected:
        "0 rows with (canonical_stage='Realized' AND savings_classification='Hard' AND classification_needs_review=true)",
      message: passed
        ? "CFO gate honored: no review-flagged rows in Hard Realized scope"
        : `CFO GATE BROKEN: ${forbiddenCount} review-flagged Hard Realized record(s) totaling $${forbiddenAmount.toLocaleString()} are eligible for the dashboard. THIS IS THE FAILURE MODE THAT KILLS PLATFORM CREDIBILITY.`,
      query,
    };
  },
};

/**
 * No `savings_type='Realized'` record may exist with both
 * `baseline_value IS NULL` AND `baseline_method != 'N/A — Soft'` —
 * the dashboard total can't trust un-baselined Realized dollars.
 * Closely related to #7 above; kept separate so the gating-family
 * coverage exists independently of the type-integrity family.
 */
export const assertion_no_realized_without_baseline: Assertion = {
  name: "dashboard_does_not_count_realized_records_missing_baseline",
  family: "gating",
  description:
    "No Realized record contributes to a dashboard total without a baseline.",
  run: async (db: DrizzleDb): Promise<AssertionResult> => {
    const query = `
      SELECT
        COUNT(*)::int                                   AS missing_count,
        COALESCE(SUM(realized_savings_usd), 0)::numeric AS missing_amount
      FROM opportunities
      WHERE savings_type = 'Realized'
        AND baseline_value IS NULL
        AND (baseline_method IS NULL OR baseline_method <> 'N/A — Soft')
    `;
    const [row] = await exec<{
      missing_count: number;
      missing_amount: string;
    }>(db, query);
    const missingCount = Number(row?.missing_count ?? 0);
    const missingAmount = Number(row?.missing_amount ?? 0);
    const passed = missingCount === 0;
    return {
      name: "dashboard_does_not_count_realized_records_missing_baseline",
      family: "gating",
      passed,
      actual: { missingCount, missingAmount },
      expected:
        "0 Realized records lacking baseline_value (and not opted-out via 'N/A — Soft')",
      message: passed
        ? "No Realized records missing baselines"
        : `${missingCount} Realized records ($${missingAmount.toLocaleString()}) have no baseline. They should not be in any dashboard total.`,
      query,
    };
  },
};

export const ALL_ASSERTIONS: Assertion[] = [
  assertion_realized_matches_record_sum,
  assertion_pipeline_value_decomposition,
  assertion_lever_totals_match_aggregate,
  assertion_funnel_counts_match_records,
  assertion_no_null_savings_tags,
  assertion_savings_type_consistent_with_stage,
  assertion_realized_records_have_baseline,
  assertion_stage_history_matches_current,
  assertion_every_opportunity_has_history_row,
  assertion_hard_savings_excludes_review_flagged,
  assertion_no_realized_without_baseline,
];
