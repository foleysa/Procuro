/**
 * One-shot backfill: set savings_classification on every opportunity row
 * that has a canonical_stage but is missing savings_classification (Task #334).
 *
 * Root cause
 * ----------
 * The #284 backfill script only touched rows where canonical_stage IS NULL,
 * so rows that acquired a canonical_stage through other paths (or were
 * partially backfilled) could end up with a non-null canonical_stage but
 * a NULL savings_classification. Investigation confirmed 100% of classified
 * peer rows are 'Hard', so the safe conservative default is 'Hard' with
 * classification_needs_review = true so Finance must still sign off.
 *
 * Idempotency
 * -----------
 * The UPDATE only matches rows where savings_classification IS NULL AND
 * canonical_stage IS NOT NULL. Re-running is a no-op once all rows are fixed.
 *
 * Usage
 * -----
 *   pnpm --filter @workspace/scripts run backfill-savings-classification
 *   pnpm --filter @workspace/scripts run backfill-savings-classification -- --dry-run
 */

export {};

if (!process.env.DATABASE_URL) {
  console.error("[backfill-savings-classification] No DATABASE_URL set");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const { db, pool } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");

  try {
    const before = await db.execute(sql.raw(`
      SELECT
        canonical_stage,
        savings_type,
        COUNT(*)::int AS cnt
      FROM opportunities
      WHERE canonical_stage IS NOT NULL
        AND savings_classification IS NULL
      GROUP BY canonical_stage, savings_type
      ORDER BY canonical_stage, savings_type
    `)) as unknown as { rows: { canonical_stage: string; savings_type: string | null; cnt: number }[] };

    const totalNull = before.rows.reduce((sum, r) => sum + Number(r.cnt), 0);

    if (totalNull === 0) {
      console.log("[backfill-savings-classification] No rows with NULL savings_classification found. Nothing to do.");
      return;
    }

    console.log(`[backfill-savings-classification] Found ${totalNull} row(s) with NULL savings_classification:\n`);
    for (const r of before.rows) {
      console.log(`  canonical_stage=${r.canonical_stage}  savings_type=${r.savings_type ?? "NULL"}  count=${r.cnt}`);
    }

    if (dryRun) {
      console.log("\n[dry-run] Re-run without --dry-run to apply fixes.");
      return;
    }

    console.log("\n[backfill-savings-classification] Applying fix...\n");

    const result = await db.execute(sql.raw(`
      UPDATE opportunities
      SET savings_classification = 'Hard',
          classification_needs_review = true
      WHERE canonical_stage IS NOT NULL
        AND savings_classification IS NULL
    `));
    const rowCount = (result as unknown as { rowCount: number }).rowCount ?? 0;
    console.log(`  Set savings_classification='Hard' and classification_needs_review=true on ${rowCount} row(s)`);

    const verify = await db.execute(sql.raw(`
      SELECT COUNT(*)::int AS remaining
      FROM opportunities
      WHERE canonical_stage IS NOT NULL
        AND savings_classification IS NULL
    `)) as unknown as { rows: { remaining: number }[] };
    const remaining = Number(verify.rows[0].remaining);

    if (remaining > 0) {
      console.error(`\n  ERROR: ${remaining} row(s) still have NULL savings_classification after fix.`);
      process.exitCode = 1;
    } else {
      console.log(`\n  Verified: 0 rows with NULL savings_classification in the active pipeline.`);
    }

    console.log("\nDone. Run 'pnpm --filter @workspace/scripts run data-integrity' to verify all assertions pass.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[backfill-savings-classification] fatal:", err);
  process.exit(1);
});
