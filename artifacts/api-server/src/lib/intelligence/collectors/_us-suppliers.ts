/**
 * Cross-tenant US-supplier loader for the supplier-risk collectors
 * (`epa-echo`, `osha-inspections`).
 *
 * Both EPA ECHO and DOL OSHA only meaningfully cover US-regulated
 * facilities, so a US-only supplier list is the correct watch surface.
 * Two tenants tracking the same supplier name only cost us one upstream
 * pull — we dedupe on the normalised name and let the alerts fan-out
 * route the resulting MarketSignal back to every tenant by name match.
 *
 * Kept separate from each collector module so the same loader can be
 * unit-tested once and reused.
 */

import { db, suppliersTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";

/** Country codes we consider "US" for supplier-risk targeting. */
const US_COUNTRY_CODES = ["US", "USA"] as const;

export interface WatchedUsSupplier {
  /** Display name (first occurrence wins). */
  name: string;
  /** Normalised name (lowercase, single-spaced) — the dedupe key. */
  normalizedName: string;
}

/**
 * Return distinct US suppliers across every tenant, capped at `cap`.
 * The cap keeps a single scheduled tick bounded — backfill routes can
 * lift it.
 */
export async function loadWatchedUsSuppliers(
  cap: number = 50,
): Promise<WatchedUsSupplier[]> {
  const rows = await db
    .select({
      name: suppliersTable.name,
      normalizedName: suppliersTable.normalizedName,
    })
    .from(suppliersTable)
    .where(inArray(suppliersTable.countryCode, [...US_COUNTRY_CODES]))
    .orderBy(sql`${suppliersTable.normalizedName} asc`);
  const seen = new Set<string>();
  const out: WatchedUsSupplier[] = [];
  for (const r of rows) {
    if (!r.normalizedName || seen.has(r.normalizedName)) continue;
    seen.add(r.normalizedName);
    out.push({ name: r.name, normalizedName: r.normalizedName });
    if (out.length >= cap) break;
  }
  return out;
}
