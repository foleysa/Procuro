/**
 * One-shot dedupe of `market_signals` rows.
 *
 * Why: before the natural-key uniqueness on `(collector_id, signal_type,
 * scope_*, observed_at)` was added, collectors that re-ran on the same
 * upstream observation inserted a fresh row each run. Those duplicates have
 * to be collapsed before `pnpm --filter @workspace/db run push` can build
 * the unique index, and they pollute analyzer inputs in any environment
 * that ran the buggy collectors.
 *
 * The script is **idempotent** — running it on a clean table is a no-op —
 * so it is safe to wire into setup flows and to re-run after every push.
 *
 * Run with: `pnpm --filter @workspace/scripts run dedupe-market-signals`
 */
import { pool } from "@workspace/db";

interface DedupeReport {
  collectorId: string;
  signalType: string;
  duplicateGroups: number;
  rowsDeleted: number;
}

/**
 * Keep the **oldest** row in each natural-key group (the first time the
 * platform observed that signal) and delete every later duplicate. Picking
 * "oldest" rather than "newest" is intentional: the natural key includes
 * `observed_at`, so by definition every row in the group reports the same
 * value for the same period — the original insert is the canonical one and
 * the rest are accidental re-runs.
 *
 * `COALESCE(scope_*, '')` mirrors the partitioning used by the
 * `market_signals_natural_key_uq` unique index, so any pre-existing row
 * pair where one side has `NULL` and the other side has `''` (which the
 * runtime now normalizes away, but historical rows from before this fix
 * may still have) collapses into the same group and gets deduped.
 */
const DEDUPE_SQL = `
  WITH ranked AS (
    SELECT id,
           collector_id,
           signal_type,
           ROW_NUMBER() OVER (
             PARTITION BY collector_id,
                          signal_type,
                          COALESCE(scope_category_code, ''),
                          COALESCE(scope_sku, ''),
                          COALESCE(scope_material_code, ''),
                          COALESCE(scope_supplier_name, ''),
                          COALESCE(scope_lane_key, ''),
                          observed_at
             ORDER BY fetched_at ASC, id ASC
           ) AS rn
    FROM market_signals
  ),
  deleted AS (
    DELETE FROM market_signals
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING collector_id, signal_type
  )
  SELECT collector_id, signal_type, COUNT(*) AS rows_deleted
  FROM deleted
  GROUP BY collector_id, signal_type
  ORDER BY collector_id, signal_type;
`;

const GROUP_COUNT_SQL = `
  SELECT collector_id, signal_type, COUNT(*) AS duplicate_groups
  FROM (
    SELECT collector_id, signal_type
    FROM market_signals
    GROUP BY collector_id,
             signal_type,
             COALESCE(scope_category_code, ''),
             COALESCE(scope_sku, ''),
             COALESCE(scope_material_code, ''),
             COALESCE(scope_supplier_name, ''),
             COALESCE(scope_lane_key, ''),
             observed_at
    HAVING COUNT(*) > 1
  ) g
  GROUP BY collector_id, signal_type
  ORDER BY collector_id, signal_type;
`;

async function dedupe(): Promise<DedupeReport[]> {
  const groupsRes = await pool.query<{
    collector_id: string;
    signal_type: string;
    duplicate_groups: string;
  }>(GROUP_COUNT_SQL);
  const groupsByKey = new Map<string, number>();
  for (const row of groupsRes.rows) {
    groupsByKey.set(
      `${row.collector_id}::${row.signal_type}`,
      Number(row.duplicate_groups),
    );
  }

  const deletedRes = await pool.query<{
    collector_id: string;
    signal_type: string;
    rows_deleted: string;
  }>(DEDUPE_SQL);

  return deletedRes.rows.map((r) => ({
    collectorId: r.collector_id,
    signalType: r.signal_type,
    duplicateGroups:
      groupsByKey.get(`${r.collector_id}::${r.signal_type}`) ?? 0,
    rowsDeleted: Number(r.rows_deleted),
  }));
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[dedupe-market-signals] starting at ${startedAt}`);
  const report = await dedupe();

  if (report.length === 0) {
    console.log(
      "[dedupe-market-signals] no duplicates found — table is already unique on the natural key.",
    );
    return;
  }

  let totalDeleted = 0;
  for (const r of report) {
    totalDeleted += r.rowsDeleted;
    console.log(
      `[dedupe-market-signals] ${r.collectorId} (${r.signalType}): ` +
        `collapsed ${r.duplicateGroups} duplicate group(s), deleted ${r.rowsDeleted} row(s)`,
    );
  }
  console.log(
    `[dedupe-market-signals] total rows deleted: ${totalDeleted}`,
  );
}

main()
  .catch((err) => {
    console.error("[dedupe-market-signals] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
