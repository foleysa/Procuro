/**
 * Tiny helper shared by collectors that poll *per supplier name*
 * (USAspending.gov, SAM.gov). The Foundation does not yet maintain a
 * cross-tenant `watched_suppliers` table the way it does for
 * `watched_issuers`, so we derive the poll list at run time as the
 * distinct (case-folded) supplier names across every tenant.
 *
 * Returned shape is `{ name, countryCode }` because the SAM.gov
 * collector also wants a country hint to disambiguate common names —
 * `countryCode` is the value most frequently seen for that name across
 * tenants (or null when no tenant has stamped a country).
 */

import { db, suppliersTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface WatchedSupplierName {
  name: string;
  countryCode: string | null;
}

export async function loadWatchedSupplierNames(opts: {
  /** Hard cap so a tenant with thousands of suppliers can't blow the rate budget. */
  limit?: number;
} = {}): Promise<WatchedSupplierName[]> {
  const limit = Math.max(1, opts.limit ?? 200);
  const rows = await db.execute<{ name: string; country_code: string | null }>(sql`
    SELECT name, MAX(country_code) AS country_code
      FROM ${suppliersTable}
     GROUP BY name
     ORDER BY name
     LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    name: r.name,
    countryCode: r.country_code,
  }));
}
