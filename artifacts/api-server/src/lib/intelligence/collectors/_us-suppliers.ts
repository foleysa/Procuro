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
 * Auto-seed: the first time the loader runs for a tenant we insert
 * the curated `US_SUPPLIER_SEEDS` list and stamp
 * `orgs.us_suppliers_seeded_at`. Subsequent runs short-circuit on
 * that stamp, so an admin who deletes every seeded row stays at zero
 * US suppliers — the seed is genuinely one-shot per tenant and is
 * not coupled to the live row count.
 *
 * Kept separate from each collector module so the same loader can be
 * unit-tested once and reused.
 */

import { db, suppliersTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import {
  US_SUPPLIER_SEEDS,
  US_SUPPLIER_SEED_SOURCE,
  normalizeUsSupplierName,
} from "./us-suppliers-seed";

/** Country codes we consider "US" for supplier-risk targeting. */
const US_COUNTRY_CODES = ["US", "USA"] as const;

export interface WatchedUsSupplier {
  /** Display name (first occurrence wins). */
  name: string;
  /** Normalised name (lowercase, single-spaced) — the dedupe key. */
  normalizedName: string;
}

/**
 * For every tenant that currently has zero US suppliers, persist the
 * curated `US_SUPPLIER_SEEDS` list so the EPA / OSHA collectors have
 * something to poll on day one. Idempotent.
 *
 * Implementation note: we snapshot the set of unseeded tenants in a
 * CTE (gated on `us_suppliers_seeded_at IS NULL`), cross-join it with
 * a VALUES list of the full seed set, and stamp the marker in the
 * same transaction. The unique index on
 * `(org_id, source_system, source_external_id)` guards against
 * duplicates if a partial prior run inserted some rows but failed to
 * stamp.
 *
 * Exported for tests; collectors get this implicitly via
 * `loadWatchedUsSuppliers`.
 */
export async function ensureUsSuppliersSeeded(): Promise<void> {
  if (US_SUPPLIER_SEEDS.length === 0) return;
  const seedRows = sql.join(
    US_SUPPLIER_SEEDS.map(
      (s) =>
        sql`(${s.externalId}, ${s.name}, ${normalizeUsSupplierName(s.name)})`,
    ),
    sql`, `,
  );
  await db.transaction(async (tx) => {
    // Eligible == "never seeded AND has no US suppliers". The marker
    // alone would re-stamp legacy tenants who already curated their
    // own list before the marker existed; the row-existence check
    // protects against injecting starter rows into a tenant that has
    // any prior US supplier (CSV ingest, ERP sync, manual admin add).
    const eligible = await tx.execute<{ id: string }>(sql`
      SELECT o.id
        FROM orgs o
       WHERE o.us_suppliers_seeded_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM suppliers s
            WHERE s.org_id = o.id
              AND s.country_code IN ('US', 'USA')
         )
    `);
    const orgIds = eligible.rows.map((r) => r.id);
    if (orgIds.length === 0) return;
    const orgIdList = sql.join(
      orgIds.map((id) => sql`${id}`),
      sql`, `,
    );
    await tx.execute(sql`
      WITH seed_rows (external_id, name, normalized_name) AS (
        VALUES ${seedRows}
      ),
      eligible_orgs (id) AS (
        VALUES (${sql.join(
          orgIds.map((id) => sql`${id}`),
          sql`), (`,
        )})
      )
      INSERT INTO suppliers
        (id, org_id, name, normalized_name, country_code,
         source_system, source_external_id)
      SELECT
        'sup_us_seed_' || o.id || '_' || sr.external_id,
        o.id,
        sr.name,
        sr.normalized_name,
        'US',
        ${US_SUPPLIER_SEED_SOURCE},
        'us_seed_' || sr.external_id
      FROM eligible_orgs o
      CROSS JOIN seed_rows sr
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE orgs
         SET us_suppliers_seeded_at = NOW()
       WHERE id IN (${orgIdList})
    `);
  });
}

/**
 * Return distinct US suppliers across every tenant, capped at `cap`.
 * The cap keeps a single scheduled tick bounded — backfill routes can
 * lift it.
 */
export async function loadWatchedUsSuppliers(
  cap: number = 50,
): Promise<WatchedUsSupplier[]> {
  await ensureUsSuppliersSeeded();
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
