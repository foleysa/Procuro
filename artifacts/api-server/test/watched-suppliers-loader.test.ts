/**
 * Integration tests for the watched-suppliers shortlist loader.
 *
 * Pins the contract that:
 *   1. `ensureWatchedSuppliersSeeded` persists default rows for tenants
 *      that have never curated a watch list, sourced from suppliers
 *      flagged `is_strategic` or `is_preferred`.
 *   2. The seed is per-tenant: a tenant that already has any
 *      `watched_suppliers` row is left alone, while a sibling tenant
 *      with none still gets its default shortlist (no global
 *      "table empty" coupling).
 *   3. Re-running the seed is idempotent (no duplicates, no errors).
 *   4. `loadWatchedSupplierNames` returns the deduped union across
 *      tenants in the `{ name, countryCode }` shape collectors expect.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";

import {
  db,
  orgsTable,
  suppliersTable,
  watchedSuppliersTable,
  pool,
} from "@workspace/db";
import { eq, inArray, like } from "drizzle-orm";
import {
  ensureWatchedSuppliersSeeded,
  loadWatchedSupplierNames,
} from "../src/lib/intelligence/collectors/_watched-suppliers";

const RUN_ID = `task259-${Date.now()}-${process.pid}`;
const ORG_A = `org-${RUN_ID}-a`;
const ORG_B = `org-${RUN_ID}-b`;

const supplierIds: string[] = [];
const watchedIds: string[] = [];

before(async () => {
  await db.insert(orgsTable).values([
    { id: ORG_A, name: `Org A ${RUN_ID}`, slug: `${ORG_A}-slug` },
    { id: ORG_B, name: `Org B ${RUN_ID}`, slug: `${ORG_B}-slug` },
  ]);

  // ORG_A: one strategic, one preferred, one ordinary supplier.
  const sA1 = `sup-${RUN_ID}-a-strat`;
  const sA2 = `sup-${RUN_ID}-a-pref`;
  const sA3 = `sup-${RUN_ID}-a-ord`;
  // ORG_B: one strategic, one ordinary supplier.
  const sB1 = `sup-${RUN_ID}-b-strat`;
  const sB2 = `sup-${RUN_ID}-b-ord`;
  supplierIds.push(sA1, sA2, sA3, sB1, sB2);

  await db.insert(suppliersTable).values([
    {
      id: sA1, orgId: ORG_A, name: `${RUN_ID} Alpha Strategic`,
      normalizedName: `${RUN_ID} alpha strategic`, countryCode: "US",
      isStrategic: true, sourceExternalId: sA1,
    },
    {
      id: sA2, orgId: ORG_A, name: `${RUN_ID} Alpha Preferred`,
      normalizedName: `${RUN_ID} alpha preferred`, countryCode: "GB",
      isPreferred: true, sourceExternalId: sA2,
    },
    {
      id: sA3, orgId: ORG_A, name: `${RUN_ID} Alpha Ordinary`,
      normalizedName: `${RUN_ID} alpha ordinary`, countryCode: "US",
      sourceExternalId: sA3,
    },
    {
      id: sB1, orgId: ORG_B, name: `${RUN_ID} Bravo Strategic`,
      normalizedName: `${RUN_ID} bravo strategic`, countryCode: "DE",
      isStrategic: true, sourceExternalId: sB1,
    },
    {
      id: sB2, orgId: ORG_B, name: `${RUN_ID} Bravo Ordinary`,
      normalizedName: `${RUN_ID} bravo ordinary`,
      sourceExternalId: sB2,
    },
  ]);

  // ORG_B has explicitly curated a watch list (just the ordinary
  // supplier) — the seed must leave ORG_B alone, even though ORG_B's
  // strategic supplier is *not* in the curated list.
  const wB = `ws-${RUN_ID}-b`;
  watchedIds.push(wB);
  await db.insert(watchedSuppliersTable).values({
    id: wB,
    orgId: ORG_B,
    supplierUid: sB2,
    name: `${RUN_ID} Bravo Ordinary`,
    countryCode: null,
    createdBy: "test-fixture",
  });
});

after(async () => {
  await db
    .delete(watchedSuppliersTable)
    .where(inArray(watchedSuppliersTable.orgId, [ORG_A, ORG_B]));
  await db
    .delete(suppliersTable)
    .where(inArray(suppliersTable.id, supplierIds));
  await db.delete(orgsTable).where(inArray(orgsTable.id, [ORG_A, ORG_B]));
  await pool.end();
});

test("ensureWatchedSuppliersSeeded auto-creates per-tenant defaults", async () => {
  await ensureWatchedSuppliersSeeded();

  const aRows = await db
    .select()
    .from(watchedSuppliersTable)
    .where(eq(watchedSuppliersTable.orgId, ORG_A));
  const aNames = aRows.map((r) => r.name).sort();
  assert.deepEqual(
    aNames,
    [`${RUN_ID} Alpha Preferred`, `${RUN_ID} Alpha Strategic`],
    "tenant with no prior watched_suppliers gets seeded from is_strategic / is_preferred",
  );
  for (const r of aRows) {
    assert.equal(r.createdBy, "system_seed");
    assert.ok(r.supplierUid, "seed must link to the source supplier");
  }
});

test("seed is per-tenant and leaves curated tenants untouched", async () => {
  const bRows = await db
    .select()
    .from(watchedSuppliersTable)
    .where(eq(watchedSuppliersTable.orgId, ORG_B));
  assert.equal(
    bRows.length,
    1,
    "ORG_B already had a watched row, must not be re-seeded with strategics",
  );
  assert.equal(bRows[0]?.name, `${RUN_ID} Bravo Ordinary`);
});

test("ensureWatchedSuppliersSeeded is idempotent", async () => {
  const before = await db
    .select()
    .from(watchedSuppliersTable)
    .where(like(watchedSuppliersTable.name, `${RUN_ID}%`));
  await ensureWatchedSuppliersSeeded();
  await ensureWatchedSuppliersSeeded();
  const after = await db
    .select()
    .from(watchedSuppliersTable)
    .where(like(watchedSuppliersTable.name, `${RUN_ID}%`));
  assert.equal(after.length, before.length);
});

test("loadWatchedSupplierNames returns deduped union across tenants", async () => {
  const names = await loadWatchedSupplierNames({ limit: 500 });
  const ours = names.filter((n) => n.name.startsWith(RUN_ID));
  const got = ours.map((n) => n.name).sort();
  assert.deepEqual(got, [
    `${RUN_ID} Alpha Preferred`,
    `${RUN_ID} Alpha Strategic`,
    `${RUN_ID} Bravo Ordinary`,
  ]);
  const alphaStrat = ours.find((n) => n.name.endsWith("Alpha Strategic"));
  assert.equal(alphaStrat?.countryCode, "US");
});
