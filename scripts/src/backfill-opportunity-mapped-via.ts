/**
 * Backfill `opportunities.mapped_via` for rows persisted before task #213
 * stamped routing provenance at insert time.
 *
 * Why
 * ---
 * Task #213 added `opportunities.mapped_via` and the cycle path
 * (`lib/ooda/cycle.ts`) stamps it via `determineOpportunityMappedVia`
 * for every newly persisted row. Anything created BEFORE that landed
 * still has `mapped_via IS NULL`, which:
 *   - inflates the "null" bucket on /admin/funnel → "Mapping data
 *     health" (currently ~4,569 rows for the seed tenant) and masks
 *     the real `unmapped_default` percentage operators are trying to
 *     act on
 *   - prevents calibration from retroactively excluding historical
 *     `unmapped_default` rows from per-lever scoring
 *
 * What this writes
 * ----------------
 * For every opportunity with `mapped_via IS NULL`:
 *   - Looks up its `categoryId → categories.code` (the canonical code)
 *   - If the canonical code is in `category_bands` (i.e. `category_bands`
 *     would route it under the synonym registry today) → `synonym_global`
 *   - Otherwise (no category, missing canonical code, or unrouted code)
 *     → `unmapped_default`
 *
 * This mirrors the going-forward decision in
 * `determineOpportunityMappedVia(canonicalCode)` from
 * `lib/intelligence/routing/index.ts`. Tenant-scoped synonym hits
 * (`synonym_tenant_scoped`) are NOT inferable after the fact — the
 * cycle path itself only emits `synonym_global` / `unmapped_default`
 * because it operates on the resolved category row, not the original
 * tenant string. So this backfill matches that reduced provenance set
 * exactly.
 *
 * Idempotency
 * -----------
 * Every UPDATE is gated on `mapped_via IS NULL`, so re-running this
 * script is safe — already-stamped rows (whether from this backfill or
 * from going-forward inserts) are not touched.
 *
 * Usage
 * -----
 *   pnpm --filter @workspace/scripts run backfill-opportunity-mapped-via
 *   pnpm --filter @workspace/scripts run backfill-opportunity-mapped-via -- --orgId org_seed_default
 *   pnpm --filter @workspace/scripts run backfill-opportunity-mapped-via -- --dry-run
 */
import {
  db,
  pool,
  opportunitiesTable,
  orgsTable,
} from "@workspace/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

interface CliArgs {
  orgId: string | null;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { orgId: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--orgId") out.orgId = argv[++i] ?? null;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: backfill-opportunity-mapped-via [--orgId <id>] [--dry-run]\n" +
          "  --orgId <id>   Backfill only this tenant. Default: all tenants.\n" +
          "  --dry-run      Print what would be updated without writing.\n",
      );
      process.exit(0);
    }
  }
  return out;
}

interface OrgCounts {
  nullBefore: number;
  routed: number;
  unmapped: number;
}

async function countNull(orgId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        isNull(opportunitiesTable.mappedVia),
      ),
    );
  return Number(row?.c ?? 0);
}

/**
 * Backfill one tenant. Two UPDATEs, both gated on `mapped_via IS NULL`
 * for idempotency:
 *
 *   1. Mark rows whose canonical category code is present in
 *      `category_bands` as `synonym_global` — this is exactly what
 *      `determineOpportunityMappedVia` returns for a routed code.
 *   2. Mark every remaining NULL row as `unmapped_default`.
 *
 * Done in this order so the second UPDATE only touches rows the first
 * one didn't claim, and the result is independent of execution order.
 */
async function backfillOrg(
  orgId: string,
  args: CliArgs,
): Promise<OrgCounts> {
  const nullBefore = await countNull(orgId);
  if (nullBefore === 0) {
    return { nullBefore: 0, routed: 0, unmapped: 0 };
  }

  if (args.dryRun) {
    // Compute the projected split without writing. Mirrors the
    // CASE/EXISTS shape used by the live UPDATEs below.
    const { rows } = await pool.query<{
      routed: string;
      unmapped: string;
    }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE c.code IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM category_bands cb
                WHERE cb.category_code = c.code
             )
         )::text AS routed,
         COUNT(*) FILTER (
           WHERE c.code IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM category_bands cb
                 WHERE cb.category_code = c.code
              )
         )::text AS unmapped
       FROM opportunities o
       LEFT JOIN categories c ON c.id = o.category_id
       WHERE o.org_id = $1
         AND o.mapped_via IS NULL`,
      [orgId],
    );
    return {
      nullBefore,
      routed: Number(rows[0]?.routed ?? 0),
      unmapped: Number(rows[0]?.unmapped ?? 0),
    };
  }

  // 1. Routed → synonym_global. Join through `categories` so we can
  //    test the canonical code against `category_bands`. Uses the same
  //    "code is in category_bands" predicate as
  //    `isCanonicalCodeRouted()` in the routing module.
  const routedRes = await db.execute<{ id: string }>(sql`
    UPDATE opportunities o
       SET mapped_via = 'synonym_global'
      FROM categories c
     WHERE o.category_id = c.id
       AND o.org_id = ${orgId}
       AND o.mapped_via IS NULL
       AND EXISTS (
         SELECT 1 FROM category_bands cb
          WHERE cb.category_code = c.code
       )
    RETURNING o.id
  `);
  const routed = routedRes.rowCount ?? routedRes.rows.length;

  // 2. Everything still NULL → unmapped_default. Covers rows with no
  //    category, with a category that has no canonical code present in
  //    `category_bands`, or with a category row that's been deleted.
  const unmappedRes = await db.execute<{ id: string }>(sql`
    UPDATE opportunities
       SET mapped_via = 'unmapped_default'
     WHERE org_id = ${orgId}
       AND mapped_via IS NULL
    RETURNING id
  `);
  const unmapped = unmappedRes.rowCount ?? unmappedRes.rows.length;

  return { nullBefore, routed, unmapped };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let orgIds: string[];
  if (args.orgId) {
    orgIds = [args.orgId];
  } else {
    const rows = await db
      .select({ id: orgsTable.id })
      .from(orgsTable)
      .orderBy(asc(orgsTable.id));
    orgIds = rows.map((r) => r.id);
  }

  if (orgIds.length === 0) {
    console.log("[backfill-mapped-via] no tenants to process.");
    return;
  }

  console.log(
    `[backfill-mapped-via] ${args.dryRun ? "(dry-run) " : ""}processing ` +
      `${orgIds.length} tenant(s)…`,
  );

  let totalNull = 0;
  let totalRouted = 0;
  let totalUnmapped = 0;
  for (const orgId of orgIds) {
    const c = await backfillOrg(orgId, args);
    totalNull += c.nullBefore;
    totalRouted += c.routed;
    totalUnmapped += c.unmapped;
    console.log(
      `[backfill-mapped-via] org=${orgId} ` +
        `null_before=${c.nullBefore} ` +
        `→ synonym_global=${c.routed} ` +
        `unmapped_default=${c.unmapped}`,
    );
  }

  console.log(
    `[backfill-mapped-via] DONE total ` +
      `null_before=${totalNull} ` +
      `synonym_global=${totalRouted} ` +
      `unmapped_default=${totalUnmapped}`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-mapped-via] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
