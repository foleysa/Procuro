/**
 * One-shot backfill: fix the 5 reconciliation failures exposed by the
 * data-integrity check suite (Task #327).
 *
 * Root causes
 * -----------
 * 1. 51 Realized + Hard records still had `classification_needs_review = true`.
 *    Once a record is Realized its classification has been accepted — the
 *    review flag must be cleared.
 *
 * 2. 52 Realized records had `baseline_value IS NULL` with
 *    `baseline_method = 'Internal Estimate'`. For Internal Estimate the
 *    projected value IS the baseline; the writer omitted populating
 *    `baseline_value` when it should have copied `projected_savings_usd`.
 *    Scoped strictly to `baseline_method = 'Internal Estimate'`.
 *
 * 3. Canonical-staged rows had `savings_classification IS NULL`.
 *    Investigation (Task #327) confirmed that 100% of classified records
 *    across all canonical stages are 'Hard'. The fix is scoped to the two
 *    stage/type combinations observed in the data:
 *      - Awarded / Negotiated   → 'Hard'
 *      - Closed-No Action / Identified → 'Hard'
 *    Any unexpected combination is reported as an error, not silently
 *    assigned, to prevent misclassification of Soft or Cost Avoidance rows.
 *
 * 4. pipeline_value_decomposition_intact was already passing at
 *    investigation time (0 drifting funnel_snapshots). No data fix needed —
 *    this script verifies it as part of the post-fix check.
 *
 * Idempotency
 * -----------
 * Every UPDATE uses a WHERE predicate that matches only unfixed rows.
 * Re-running is a no-op once the data is correct (0 rows affected).
 *
 * Usage
 * -----
 *   pnpm --filter @workspace/scripts run backfill-reconciliation-fixes
 *   pnpm --filter @workspace/scripts run backfill-reconciliation-fixes -- --dry-run
 */

if (!process.env.DATABASE_URL) {
  console.error("[backfill-reconciliation-fixes] No DATABASE_URL set");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");

const KNOWN_NULL_CLASSIFICATION_STAGES: [string, string][] = [
  ["Awarded", "Negotiated"],
  ["Closed-No Action", "Identified"],
];

async function main(): Promise<void> {
  const { db, pool } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");

  try {
    const unknownRows = await db.execute(sql.raw(`
      SELECT canonical_stage, savings_type, COUNT(*)::int AS cnt
      FROM opportunities
      WHERE canonical_stage IS NOT NULL
        AND savings_classification IS NULL
        AND NOT (
          (canonical_stage = 'Awarded' AND savings_type = 'Negotiated') OR
          (canonical_stage = 'Closed-No Action' AND savings_type = 'Identified')
        )
      GROUP BY canonical_stage, savings_type
    `)) as unknown as { rows: { canonical_stage: string; savings_type: string; cnt: number }[] };

    if (unknownRows.rows.length > 0) {
      console.error(
        "[backfill-reconciliation-fixes] ABORT: Found null-classification rows " +
        "with unexpected stage/type combinations that cannot be safely auto-classified:\n" +
        JSON.stringify(unknownRows.rows, null, 2) +
        "\nThese require manual review before classification can be assigned."
      );
      process.exitCode = 1;
      return;
    }

    const nullTypeCheck = await db.execute(sql.raw(`
      SELECT COUNT(*)::int AS cnt
      FROM opportunities
      WHERE canonical_stage IS NOT NULL AND savings_type IS NULL
    `)) as unknown as { rows: { cnt: number }[] };
    const nullTypeCount = Number(nullTypeCheck.rows[0].cnt);

    if (nullTypeCount > 0) {
      console.error(
        `[backfill-reconciliation-fixes] ABORT: Found ${nullTypeCount} canonical-staged ` +
        `rows with NULL savings_type. These require manual triage.`
      );
      process.exitCode = 1;
      return;
    }

    if (dryRun) {
      console.log("[dry-run] Showing row counts that WOULD be affected:\n");

      const counts = await db.execute(sql.raw(`
        SELECT
          (SELECT COUNT(*) FROM opportunities
           WHERE canonical_stage = 'Realized'
             AND savings_classification = 'Hard'
             AND classification_needs_review = true
          ) AS fix1_review_flag,

          (SELECT COUNT(*) FROM opportunities
           WHERE savings_type = 'Realized'
             AND baseline_value IS NULL
             AND baseline_method = 'Internal Estimate'
          ) AS fix2_missing_baseline,

          (SELECT COUNT(*) FROM opportunities
           WHERE canonical_stage IS NOT NULL
             AND savings_classification IS NULL
             AND (
               (canonical_stage = 'Awarded' AND savings_type = 'Negotiated') OR
               (canonical_stage = 'Closed-No Action' AND savings_type = 'Identified')
             )
          ) AS fix3_null_classification
      `)) as unknown as { rows: Record<string, string>[] };

      const row = counts.rows[0];
      console.log(`  Fix 1 (clear review flag on Realized Hard):              ${row.fix1_review_flag} rows`);
      console.log(`  Fix 2 (set baseline_value for Internal Estimate):        ${row.fix2_missing_baseline} rows`);
      console.log(`  Fix 3 (set classification for Awarded/Closed-No Action): ${row.fix3_null_classification} rows`);

      const decomp = await db.execute(sql.raw(`
        WITH record_sum AS (
          SELECT cycle_id, COALESCE(SUM(projected_savings_usd), 0)::numeric AS v
          FROM opportunities GROUP BY cycle_id
        )
        SELECT COUNT(*) AS drift_count
        FROM funnel_snapshots fs
        LEFT JOIN record_sum r ON r.cycle_id = fs.cycle_id
        WHERE ABS(fs.total_projected_usd - COALESCE(r.v, 0)) > 1
      `)) as unknown as { rows: { drift_count: string }[] };
      console.log(`  Pipeline decomposition drifting snapshots:               ${decomp.rows[0].drift_count}`);

      console.log("\nRe-run without --dry-run to apply.");
      return;
    }

    console.log("[backfill-reconciliation-fixes] Applying fixes...\n");

    const fix1 = await db.execute(sql.raw(`
      UPDATE opportunities
      SET classification_needs_review = false
      WHERE canonical_stage = 'Realized'
        AND savings_classification = 'Hard'
        AND classification_needs_review = true
    `));
    const fix1Count = (fix1 as unknown as { rowCount: number }).rowCount ?? 0;
    console.log(`  Fix 1: cleared classification_needs_review on ${fix1Count} Realized Hard record(s)`);

    const fix2 = await db.execute(sql.raw(`
      UPDATE opportunities
      SET baseline_value = projected_savings_usd
      WHERE savings_type = 'Realized'
        AND baseline_value IS NULL
        AND baseline_method = 'Internal Estimate'
    `));
    const fix2Count = (fix2 as unknown as { rowCount: number }).rowCount ?? 0;
    console.log(`  Fix 2: set baseline_value on ${fix2Count} Internal Estimate Realized record(s) missing baseline`);

    const fix3 = await db.execute(sql.raw(`
      UPDATE opportunities
      SET savings_classification = 'Hard'
      WHERE canonical_stage IS NOT NULL
        AND savings_classification IS NULL
        AND (
          (canonical_stage = 'Awarded' AND savings_type = 'Negotiated') OR
          (canonical_stage = 'Closed-No Action' AND savings_type = 'Identified')
        )
    `));
    const fix3Count = (fix3 as unknown as { rowCount: number }).rowCount ?? 0;
    console.log(`  Fix 3: set savings_classification on ${fix3Count} Awarded/Closed-No Action record(s)`);

    const decomp = await db.execute(sql.raw(`
      WITH record_sum AS (
        SELECT cycle_id, COALESCE(SUM(projected_savings_usd), 0)::numeric AS v
        FROM opportunities GROUP BY cycle_id
      )
      SELECT COUNT(*) AS drift_count
      FROM funnel_snapshots fs
      LEFT JOIN record_sum r ON r.cycle_id = fs.cycle_id
      WHERE ABS(fs.total_projected_usd - COALESCE(r.v, 0)) > 1
    `)) as unknown as { rows: { drift_count: string }[] };
    const driftCount = Number(decomp.rows[0].drift_count);
    console.log(`  Verify: pipeline_value_decomposition drifting snapshots = ${driftCount}`);

    if (driftCount > 0) {
      console.warn(
        `\n  WARNING: ${driftCount} funnel_snapshots have projected-value drift.` +
        `\n  Run 'pnpm --filter @workspace/scripts run backfill-funnel-snapshots' to recompute.`
      );
    }

    console.log(`\nDone. Total rows touched: ${fix1Count + fix2Count + fix3Count}`);
    console.log("Run 'pnpm --filter @workspace/scripts run data-integrity' to verify all assertions pass.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[backfill-reconciliation-fixes] fatal:", err);
  process.exit(1);
});
