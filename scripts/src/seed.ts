/**
 * One-command database seed for tests and local dev.
 *
 * Run with: `pnpm --filter @workspace/scripts run seed`
 *
 * What this guarantees
 * --------------------
 * After `pnpm --filter @workspace/db run push` + this script, the database
 * holds at least one row in `orgs`. That is the minimum required by the
 * integration tests in `artifacts/api-server/test/` (each one calls
 * `pickOrgId()` which reads the first org).
 *
 * Idempotency
 * -----------
 * Every insert uses `ON CONFLICT DO NOTHING` against either the primary key
 * or a unique constraint, so running the script repeatedly is safe and
 * never duplicates rows. It also never wipes existing data — if a developer
 * already has richer data in their local database, this script tops it up
 * without destroying it.
 *
 * Optional demo blocks
 * --------------------
 * `seedFxExposureDemo()` adds two non-USD-billing suppliers and a tiny
 * `fx_rate` market-signal window so the `supplier_fx_exposure` lever fires
 * on a freshly-pushed DB without waiting for the ECB collector to run.
 */
import {
  db,
  pool,
  orgsTable,
  suppliersTable,
  invoicesTable,
  collectorsTable,
  marketSignalsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";

const SEED_ORG = {
  id: "org_seed_default",
  slug: "seed-default",
  name: "Seed Default Org",
} as const;

async function seedOrgs(): Promise<void> {
  // `id` is the primary key and `slug` is unique, so either constraint
  // would catch a re-run. `onConflictDoNothing` (no target) covers both.
  const inserted = await db
    .insert(orgsTable)
    .values({
      id: SEED_ORG.id,
      slug: SEED_ORG.slug,
      name: SEED_ORG.name,
    })
    .onConflictDoNothing()
    .returning({ id: orgsTable.id });

  if (inserted.length > 0) {
    console.log(`[seed] inserted org ${SEED_ORG.id} (${SEED_ORG.slug})`);
  } else {
    console.log(`[seed] org ${SEED_ORG.id} already present — no changes`);
  }
}

/**
 * Adds the minimum data needed to demo the `supplier_fx_exposure` lever
 * end-to-end without waiting on a live ECB collector run.
 *
 * Inserts:
 *   - two suppliers on `org_seed_default` billing in EUR and JPY
 *   - a synthetic `seed-fx-demo` collector
 *   - two `fx_rate` market-signal observations (start and end of the 30-day
 *     window) for `USD/EUR` and `USD/JPY`, with USD/EUR moving ~5% (above the
 *     3% threshold) and USD/JPY moving ~1% (below it)
 *
 * Idempotent: every row uses ON CONFLICT DO NOTHING against the natural key.
 */
async function seedFxExposureDemo(): Promise<void> {
  const orgId = SEED_ORG.id;
  const SOURCE = "seed-fx-demo";

  // 1. Suppliers — keyed by (org, source_system, source_external_id).
  await db
    .insert(suppliersTable)
    .values([
      {
        id: "sup_seed_fx_eur",
        orgId,
        name: "Berlin Components GmbH",
        normalizedName: "berlin components gmbh",
        countryCode: "DE",
        billingCurrency: "EUR",
        sourceSystem: SOURCE,
        sourceExternalId: "fx-demo-eur",
      },
      {
        id: "sup_seed_fx_jpy",
        orgId,
        name: "Osaka Precision KK",
        normalizedName: "osaka precision kk",
        countryCode: "JP",
        billingCurrency: "JPY",
        sourceSystem: SOURCE,
        sourceExternalId: "fx-demo-jpy",
      },
    ])
    .onConflictDoNothing();

  // 2. Invoices — give each non-USD supplier a known 12-month spend so the
  //    fx-exposure analyzer has a non-zero exposure to compute against.
  const recent = new Date();
  recent.setDate(recent.getDate() - 30);
  await db
    .insert(invoicesTable)
    .values([
      {
        id: "inv_seed_fx_eur",
        orgId,
        supplierId: "sup_seed_fx_eur",
        invoiceNumber: "SEED-FX-EUR-001",
        invoiceDate: recent,
        amountUsd: "250000.00",
        dedupKey: "seed-fx-eur-001",
        sourceSystem: SOURCE,
        sourceExternalId: "fx-demo-inv-eur",
      },
      {
        id: "inv_seed_fx_jpy",
        orgId,
        supplierId: "sup_seed_fx_jpy",
        invoiceNumber: "SEED-FX-JPY-001",
        invoiceDate: recent,
        amountUsd: "180000.00",
        dedupKey: "seed-fx-jpy-001",
        sourceSystem: SOURCE,
        sourceExternalId: "fx-demo-inv-jpy",
      },
    ])
    .onConflictDoNothing();

  // 3. Collector row to satisfy the FK on market_signals.collector_id.
  await db
    .insert(collectorsTable)
    .values({
      id: SOURCE,
      name: "FX Exposure Demo Seeder",
      description:
        "Synthetic collector used by scripts/src/seed.ts to plant fx_rate signals so the supplier_fx_exposure lever fires on a fresh DB.",
      posture: "public-api",
      status: "approved",
      owner: "seed-script",
      sourceUrl: "https://example.invalid/seed",
    })
    .onConflictDoNothing();

  // 4. fx_rate signals: two observations per pair to define a window.
  const now = new Date();
  const earlier = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
  await db
    .insert(marketSignalsTable)
    .values([
      // USD/EUR moved 0.92 → 0.966 (~5% appreciation of USD vs EUR).
      {
        id: "msig_seed_fx_usdeur_old",
        orgId: null,
        collectorId: SOURCE,
        signalType: "fx_rate",
        scopeMaterialCode: "USD/EUR",
        value: "0.920000",
        unit: "USD/EUR",
        currency: "EUR",
        observedAt: earlier,
        sourceUrl: "https://example.invalid/seed",
        posture: "public-api",
        confidence: "0.9500",
        metadata: { base: "USD", quote: "EUR", seeded: true },
      },
      {
        id: "msig_seed_fx_usdeur_new",
        orgId: null,
        collectorId: SOURCE,
        signalType: "fx_rate",
        scopeMaterialCode: "USD/EUR",
        value: "0.966000",
        unit: "USD/EUR",
        currency: "EUR",
        observedAt: now,
        sourceUrl: "https://example.invalid/seed",
        posture: "public-api",
        confidence: "0.9500",
        metadata: { base: "USD", quote: "EUR", seeded: true },
      },
      // USD/JPY moved 150 → 151.5 (~1% — below threshold, should NOT fire).
      {
        id: "msig_seed_fx_usdjpy_old",
        orgId: null,
        collectorId: SOURCE,
        signalType: "fx_rate",
        scopeMaterialCode: "USD/JPY",
        value: "150.000000",
        unit: "USD/JPY",
        currency: "JPY",
        observedAt: earlier,
        sourceUrl: "https://example.invalid/seed",
        posture: "public-api",
        confidence: "0.9500",
        metadata: { base: "USD", quote: "JPY", seeded: true },
      },
      {
        id: "msig_seed_fx_usdjpy_new",
        orgId: null,
        collectorId: SOURCE,
        signalType: "fx_rate",
        scopeMaterialCode: "USD/JPY",
        value: "151.500000",
        unit: "USD/JPY",
        currency: "JPY",
        observedAt: now,
        sourceUrl: "https://example.invalid/seed",
        posture: "public-api",
        confidence: "0.9500",
        metadata: { base: "USD", quote: "JPY", seeded: true },
      },
    ])
    .onConflictDoUpdate({
      target: marketSignalsTable.id,
      // Refresh observedAt on every seed run so the demo opportunity
      // never ages out of the analyzer's 30-day lookback window.
      set: {
        observedAt: sql`excluded.observed_at`,
        value: sql`excluded.value`,
      },
    });

  console.log(
    `[seed] supplier_fx_exposure demo data ensured on ${orgId} (collector=${SOURCE}, fx observedAt refreshed)`,
  );
}

async function main(): Promise<void> {
  console.log(`[seed] starting at ${new Date().toISOString()}`);
  await seedOrgs();
  await seedFxExposureDemo();
  console.log(`[seed] complete`);
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
