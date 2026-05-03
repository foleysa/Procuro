/**
 * Integration tests for the US-supplier auto-seed used by the EPA ECHO
 * and DOL OSHA collectors.
 *
 * Pins the contract that:
 *   1. A fresh tenant (zero US suppliers) is seeded with the *full*
 *      `US_SUPPLIER_SEEDS` curated list — not just one row.
 *   2. The seed is per-tenant: a tenant that already has its
 *      `us_suppliers_seeded_at` stamp set is left alone.
 *   3. Re-running the seed is idempotent.
 *   4. Deleting every seeded supplier and re-running the loader does
 *      NOT reseed — the marker is durable, so admin curation sticks.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";

import { db, orgsTable, suppliersTable, pool } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  ensureUsSuppliersSeeded,
  loadWatchedUsSuppliers,
} from "../src/lib/intelligence/collectors/_us-suppliers";
import {
  US_SUPPLIER_SEEDS,
  US_SUPPLIER_SEED_SOURCE,
} from "../src/lib/intelligence/collectors/us-suppliers-seed";

const RUN_ID = `task261-${Date.now()}-${process.pid}`;
const ORG_FRESH = `org-${RUN_ID}-fresh`;
const ORG_PRUNE = `org-${RUN_ID}-prune`;

before(async () => {
  await db.insert(orgsTable).values([
    { id: ORG_FRESH, name: `Fresh ${RUN_ID}`, slug: `${ORG_FRESH}-slug` },
    { id: ORG_PRUNE, name: `Prune ${RUN_ID}`, slug: `${ORG_PRUNE}-slug` },
  ]);
});

after(async () => {
  await db
    .delete(suppliersTable)
    .where(inArray(suppliersTable.orgId, [ORG_FRESH, ORG_PRUNE]));
  await db
    .delete(orgsTable)
    .where(inArray(orgsTable.id, [ORG_FRESH, ORG_PRUNE]));
  await pool.end();
});

test("ensureUsSuppliersSeeded seeds the FULL curated list for a fresh tenant", async () => {
  await ensureUsSuppliersSeeded();

  const rows = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.orgId, ORG_FRESH));

  assert.equal(
    rows.length,
    US_SUPPLIER_SEEDS.length,
    `fresh tenant must receive every seed entry (${US_SUPPLIER_SEEDS.length}), got ${rows.length}`,
  );
  for (const r of rows) {
    assert.equal(r.countryCode, "US");
    assert.equal(r.sourceSystem, US_SUPPLIER_SEED_SOURCE);
    assert.ok(r.sourceExternalId?.startsWith("us_seed_"));
  }
  const names = new Set(rows.map((r) => r.name));
  for (const seed of US_SUPPLIER_SEEDS) {
    assert.ok(names.has(seed.name), `missing seed: ${seed.name}`);
  }

  const [orgRow] = await db
    .select()
    .from(orgsTable)
    .where(eq(orgsTable.id, ORG_FRESH));
  assert.ok(orgRow?.usSuppliersSeededAt, "seed marker must be stamped");
});

test("ensureUsSuppliersSeeded is idempotent on a second tick", async () => {
  const beforeRows = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.orgId, ORG_FRESH));
  await ensureUsSuppliersSeeded();
  await ensureUsSuppliersSeeded();
  const afterRows = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.orgId, ORG_FRESH));
  assert.equal(afterRows.length, beforeRows.length);
});

test("admin pruning is durable: deleting all seeded rows does NOT reseed", async () => {
  // Make sure ORG_PRUNE was seeded too on the earlier tick.
  const seeded = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.orgId, ORG_PRUNE));
  assert.equal(seeded.length, US_SUPPLIER_SEEDS.length);

  // Admin removes every US supplier on this tenant.
  await db
    .delete(suppliersTable)
    .where(eq(suppliersTable.orgId, ORG_PRUNE));

  // Loader runs again (this is what the collector does on every tick).
  await loadWatchedUsSuppliers(500);

  const after = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.orgId, ORG_PRUNE));
  assert.equal(
    after.length,
    0,
    "deleted seed must NOT come back — the marker pins the one-shot semantics",
  );
});

test("loadWatchedUsSuppliers surfaces the seeded names with a high enough cap", async () => {
  const names = await loadWatchedUsSuppliers(500);
  const got = new Set(names.map((n) => n.name));
  for (const seed of US_SUPPLIER_SEEDS) {
    assert.ok(got.has(seed.name), `loader missing seeded name: ${seed.name}`);
  }
});
