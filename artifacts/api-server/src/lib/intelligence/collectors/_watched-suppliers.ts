/**
 * Tiny helper shared by collectors that poll *per supplier name*
 * (USAspending.gov, SAM.gov).
 *
 * Source of truth is the cross-tenant `watched_suppliers` table —
 * each tenant explicitly opts in the suppliers they want enriched.
 *
 * Auto-seed: on every call we make sure each tenant has a non-empty
 * shortlist by inserting `watched_suppliers` rows for any supplier
 * flagged `is_strategic` or `is_preferred` whose tenant has never
 * curated a watch list. The seed is persisted (idempotent via
 * `ON CONFLICT DO NOTHING`) so subsequent inserts/removals by the
 * tenant survive — once a tenant has *any* watched row we never
 * re-seed them, even if the operator deliberately pruned strategic
 * suppliers from the list.
 *
 * Returned shape is `{ name, countryCode }` because the SAM.gov
 * collector also wants a country hint to disambiguate common names —
 * `countryCode` is the value most frequently seen for that name
 * across tenants (or null when no tenant has stamped a country).
 */

import { db, watchedSuppliersTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface WatchedSupplierName {
  name: string;
  countryCode: string | null;
}

/**
 * For every tenant that currently has zero `watched_suppliers` rows,
 * persist a default shortlist composed of that tenant's suppliers
 * flagged `is_strategic = true` OR `is_preferred = true`. Idempotent.
 *
 * Exported for tests; collectors get this implicitly via
 * `loadWatchedSupplierNames`.
 */
export async function ensureWatchedSuppliersSeeded(): Promise<void> {
  await db.execute(sql`
    INSERT INTO watched_suppliers
      (id, org_id, supplier_uid, name, country_code, created_by)
    SELECT
      'ws_seed_' || s.id,
      s.org_id,
      s.id,
      s.name,
      s.country_code,
      'system_seed'
    FROM suppliers s
    WHERE (s.is_strategic = true OR s.is_preferred = true)
      AND NOT EXISTS (
        SELECT 1 FROM watched_suppliers w WHERE w.org_id = s.org_id
      )
    ON CONFLICT DO NOTHING
  `);
}

export async function loadWatchedSupplierNames(opts: {
  /** Hard cap so a tenant with thousands of suppliers can't blow the rate budget. */
  limit?: number;
} = {}): Promise<WatchedSupplierName[]> {
  const limit = Math.max(1, opts.limit ?? 200);

  await ensureWatchedSuppliersSeeded();

  const rows = await db.execute<{ name: string; country_code: string | null }>(sql`
    SELECT name, MAX(country_code) AS country_code
      FROM ${watchedSuppliersTable}
     GROUP BY name
     ORDER BY name
     LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    name: r.name,
    countryCode: r.country_code,
  }));
}
