/**
 * One-shot backfill of `scope_sku` on legacy `bls-economic-index` rows.
 *
 * Why: the `bls-economic-index` collector originally emitted drafts with
 * `scope_sku = NULL`. The natural-key uniqueness index includes
 * `COALESCE(scope_sku, '')`, so two BLS series that resolve to the same
 * `(scope_*, observed_at)` would silently collide on insert (e.g. PPI
 * monthly M03 and ECI quarterly Q01 both ending 2025-03-31, or two PCU
 * series that fan out to the same canonical category).
 *
 * The collector now stamps `scope_sku = bls_series:<seriesId>` on every
 * draft (see `blsScopeSku` in `bls-economic-index.ts`). Without this
 * backfill, the first post-deploy collector run would insert a fresh
 * row for every legacy observation alongside the old NULL-sku row,
 * creating duplicate history.
 *
 * The backfill copies the upstream BLS `seriesId` out of the existing
 * `metadata` JSON onto `scope_sku` so legacy rows match the new natural
 * key. Idempotent: only touches rows where `scope_sku IS NULL` and the
 * collector is `bls-economic-index`.
 *
 * Run with: `pnpm --filter @workspace/scripts run backfill-bls-scope-sku`
 * Wired into `scripts/post-merge.sh` so it runs automatically after
 * every merge that ships schema or collector changes.
 */
import { pool } from "@workspace/db";

const BACKFILL_SQL = `
  UPDATE market_signals
  SET scope_sku = 'bls_series:' || (metadata->>'seriesId')
  WHERE collector_id = 'bls-economic-index'
    AND scope_sku IS NULL
    AND metadata ? 'seriesId'
    AND length(metadata->>'seriesId') > 0
`;

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query(BACKFILL_SQL);
    // eslint-disable-next-line no-console
    console.log(
      `[backfill-bls-scope-sku] backfilled scope_sku on ${result.rowCount ?? 0} legacy bls-economic-index rows`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[backfill-bls-scope-sku] failed:", err);
  process.exit(1);
});
