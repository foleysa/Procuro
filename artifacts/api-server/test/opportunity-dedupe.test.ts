/**
 * Integration test for the opportunities dedupe constraint (task #219).
 *
 * The partial unique index `opps_signal_key_uq` on
 * `(org_id, lever_id, signal_key) WHERE status IN
 * ('proposed','approved','executing') AND signal_key IS NOT NULL`
 * is what stops the pending-approvals queue from growing forever.
 * The cycle Act step issues `INSERT ... ON CONFLICT (...) DO UPDATE`
 * against it so re-runs of the same cycle either INSERT a brand-new
 * row OR refresh the existing one in place — never duplicate.
 *
 * The invariants pinned here:
 *
 *   - First insert of a (org, lever, signalKey) tuple succeeds and
 *     reports `inserted=true` via the `(xmax = 0)` idiom.
 *   - Second insert with the same tuple while the row is still in
 *     a covered status (`proposed`/`approved`/`executing`) does NOT
 *     create a new row — the existing row's content fields are
 *     refreshed and `inserted=false`. `id`, `created_at`, `status`,
 *     and `cycle_id` are preserved; `title`/`rationale`/`projected_*`/
 *     `inputs`/`last_seen_at` are updated.
 *   - Once the original row is moved out of the covered status set
 *     (e.g. to `expired` or `rejected`), the next insert with the
 *     same tuple succeeds as a brand-new row — the index no longer
 *     matches the old row, so the constraint releases.
 *   - Rows with `signal_key IS NULL` (legacy/pre-#219) never collide
 *     with each other because the index also excludes NULL keys.
 *
 * Prereqs: `DATABASE_URL` is set and the schema has been pushed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  orgsTable,
  opportunitiesTable,
  analysisCyclesTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

const RUN_TAG = `opp-dedupe-test-${Date.now()}-${process.pid}`;
const ORG_ID = `${RUN_TAG}-org`;
const CYCLE_ID = `${RUN_TAG}-cycle`;
const LEVER_ID = "supplier_consolidation" as const;
const SIGNAL_KEY = `${RUN_TAG}-sig`;

interface UpsertRow extends Record<string, unknown> {
  id: string;
  status: string;
  title: string;
  cycle_id: string;
  created_at: Date;
  last_seen_at: Date | null;
  inserted: boolean;
}

async function upsert(opts: {
  rowId: string;
  signalKey: string | null;
  title: string;
  lastSeenAt: Date;
  rawProjected: string;
  projected: string;
}): Promise<UpsertRow> {
  const res = await db.execute<UpsertRow>(sql`
    INSERT INTO opportunities (
      id, org_id, cycle_id, lever_id, tier, title, rationale,
      recommended_action, raw_projected_savings_usd,
      projected_savings_usd, confidence, inputs, signal_key, last_seen_at
    ) VALUES (
      ${opts.rowId}, ${ORG_ID}, ${CYCLE_ID}, ${LEVER_ID}, 1,
      ${opts.title}, 'r', 'a',
      ${opts.rawProjected}, ${opts.projected}, '0.5',
      '{}'::jsonb, ${opts.signalKey}, ${opts.lastSeenAt}
    )
    ON CONFLICT (org_id, lever_id, signal_key)
      WHERE status IN ('proposed', 'approved', 'executing')
        AND signal_key IS NOT NULL
    DO UPDATE SET
      title = EXCLUDED.title,
      rationale = EXCLUDED.rationale,
      recommended_action = EXCLUDED.recommended_action,
      raw_projected_savings_usd = EXCLUDED.raw_projected_savings_usd,
      projected_savings_usd = EXCLUDED.projected_savings_usd,
      confidence = EXCLUDED.confidence,
      inputs = EXCLUDED.inputs,
      last_seen_at = EXCLUDED.last_seen_at
    RETURNING id, status, title, cycle_id, created_at,
      last_seen_at, (xmax = 0) AS inserted
  `);
  const row = res.rows[0];
  if (!row) throw new Error("upsert returned no row");
  // Raw SQL via `db.execute` returns timestamps as the underlying
  // node-postgres value (Date or ISO string depending on driver
  // version); normalise to Date for stable assertions.
  return {
    ...row,
    created_at:
      row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    last_seen_at:
      row.last_seen_at == null
        ? null
        : row.last_seen_at instanceof Date
          ? row.last_seen_at
          : new Date(row.last_seen_at),
  };
}

async function cleanup(): Promise<void> {
  await db
    .delete(opportunitiesTable)
    .where(eq(opportunitiesTable.orgId, ORG_ID));
  await db
    .delete(analysisCyclesTable)
    .where(eq(analysisCyclesTable.orgId, ORG_ID));
  await db.delete(orgsTable).where(eq(orgsTable.id, ORG_ID));
}

async function seed(): Promise<void> {
  await db
    .insert(orgsTable)
    .values({ id: ORG_ID, name: ORG_ID, slug: ORG_ID })
    .onConflictDoNothing();
  await db
    .insert(analysisCyclesTable)
    .values({
      id: CYCLE_ID,
      orgId: ORG_ID,
      generation: 1,
      triggeredBy: "test",
      startedAt: new Date(),
    })
    .onConflictDoNothing();
}

test("INSERT ... ON CONFLICT inserts on first call and refreshes on second", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  await cleanup();
  await seed();
  t.after(async () => {
    try {
      await cleanup();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  const t0 = new Date(Date.now() - 5_000);
  const first = await upsert({
    rowId: `${RUN_TAG}-row-1`,
    signalKey: SIGNAL_KEY,
    title: "first title",
    lastSeenAt: t0,
    rawProjected: "100.00",
    projected: "100.00",
  });
  assert.equal(first.inserted, true, "first call inserts");
  assert.equal(first.status, "proposed");
  assert.equal(first.title, "first title");

  const t1 = new Date();
  const second = await upsert({
    rowId: `${RUN_TAG}-row-2`, // different proposed id
    signalKey: SIGNAL_KEY,
    title: "second title",
    lastSeenAt: t1,
    rawProjected: "250.00",
    projected: "250.00",
  });
  assert.equal(second.inserted, false, "second call refreshes the existing row");
  assert.equal(second.id, first.id, "id is preserved across refresh");
  assert.equal(second.title, "second title", "title is refreshed");
  assert.equal(
    second.created_at.getTime(),
    first.created_at.getTime(),
    "created_at is NOT touched on refresh",
  );
  assert.equal(second.cycle_id, CYCLE_ID, "cycle_id is preserved");
  assert.equal(second.status, "proposed", "status is preserved on refresh");
  assert.ok(
    second.last_seen_at !== null && second.last_seen_at.getTime() > t0.getTime(),
    "last_seen_at advances on refresh",
  );

  // Only one row exists for this signal — the table has not grown.
  const rows = await db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.orgId, ORG_ID));
  assert.equal(rows.length, 1, "exactly one opportunity row for this signal");
});

test("dedupe still applies for approved/executing status, releases for expired/rejected", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  await cleanup();
  await seed();
  t.after(async () => {
    try {
      await cleanup();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  // Insert one and flip it to `approved`.
  const original = await upsert({
    rowId: `${RUN_TAG}-row-1`,
    signalKey: SIGNAL_KEY,
    title: "original",
    lastSeenAt: new Date(),
    rawProjected: "100.00",
    projected: "100.00",
  });
  assert.equal(original.inserted, true);

  await db
    .update(opportunitiesTable)
    .set({ status: "approved" })
    .where(eq(opportunitiesTable.id, original.id));

  const refreshApproved = await upsert({
    rowId: `${RUN_TAG}-row-2`,
    signalKey: SIGNAL_KEY,
    title: "approved-refresh",
    lastSeenAt: new Date(),
    rawProjected: "150.00",
    projected: "150.00",
  });
  assert.equal(
    refreshApproved.inserted,
    false,
    "approved row still occupies the index slot, so re-insert refreshes it",
  );
  assert.equal(refreshApproved.id, original.id);
  assert.equal(
    refreshApproved.status,
    "approved",
    "refresh does not touch status — approved stays approved",
  );

  // Now expire the row. The partial index no longer matches, so a
  // brand-new insert with the same signal MUST succeed as a new row.
  await db
    .update(opportunitiesTable)
    .set({ status: "expired" })
    .where(eq(opportunitiesTable.id, original.id));

  const reborn = await upsert({
    rowId: `${RUN_TAG}-row-3`,
    signalKey: SIGNAL_KEY,
    title: "reborn after expiry",
    lastSeenAt: new Date(),
    rawProjected: "300.00",
    projected: "300.00",
  });
  assert.equal(
    reborn.inserted,
    true,
    "after the prior row expires, dedupe releases and a new row is inserted",
  );
  assert.notEqual(reborn.id, original.id, "reborn row gets a fresh id");

  // We should now see two rows for the same signal: one expired, one proposed.
  const rows = await db
    .select({
      id: opportunitiesTable.id,
      status: opportunitiesTable.status,
    })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.orgId, ORG_ID));
  assert.equal(rows.length, 2);
  const statuses = rows.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["expired", "proposed"]);
});

test("rows with signal_key IS NULL never collide (legacy escape hatch)", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  await cleanup();
  await seed();
  t.after(async () => {
    try {
      await cleanup();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  // Two NULL-signal_key rows for the same org+lever — both must be
  // accepted as inserts. This is the contract that lets pre-#219
  // historical rows co-exist after the migration.
  const a = await upsert({
    rowId: `${RUN_TAG}-row-1`,
    signalKey: null,
    title: "legacy A",
    lastSeenAt: new Date(),
    rawProjected: "10.00",
    projected: "10.00",
  });
  const b = await upsert({
    rowId: `${RUN_TAG}-row-2`,
    signalKey: null,
    title: "legacy B",
    lastSeenAt: new Date(),
    rawProjected: "20.00",
    projected: "20.00",
  });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, true);
  assert.notEqual(a.id, b.id);

  const rows = await db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(
      inArray(opportunitiesTable.id, [
        `${RUN_TAG}-row-1`,
        `${RUN_TAG}-row-2`,
      ]),
    );
  assert.equal(rows.length, 2);
});

test("composeSignalKey: refresh-stability and no-collision contract (#219 review)", async () => {
  // The dedupe key must satisfy BOTH:
  //   (a) Refresh-stability: the same underlying signal re-evaluated
  //       on the next cycle (with shifted projection / rationale /
  //       volatile aggregates inside `inputs`) MUST produce the SAME
  //       key so the upsert refreshes the row in place.
  //   (b) No false collision: two distinct signals from the same
  //       lever (e.g. different SKUs in `sku_price_benchmark`) MUST
  //       produce DIFFERENT keys so they don't collapse onto one row.
  //
  // The earlier code-review-rejected version of this code hashed
  // title + full inputs payload, which violated (a): every cycle the
  // metric fields shifted and the row was re-inserted instead of
  // refreshed. The fix restricts the key to STABLE identity fields
  // only, sourced from each lever's `cohortKey()` plus the structural
  // (supplierId, categoryId).
  const { composeSignalKey } = await import("../src/lib/levers/types.js");
  const { skuPriceBenchmarkLever } = await import(
    "../src/lib/levers/tier1.js"
  );

  // (a) Refresh-stability: same SKU, different metrics + title.
  const draftCycle1 = {
    leverId: "sku_price_benchmark" as const,
    title: "Standardize SKU-A to lowest verified price",
    rationale: "r1",
    recommendedAction: "a",
    rawProjectedSavingsUsd: 1000,
    inputs: {
      sku: "SKU-A",
      minPriceUsd: 5,
      avgPriceUsd: 8,
      maxPriceUsd: 12,
      totalQty: 1000,
      totalSpendUsd: 8000,
      poCount: 10,
    },
  };
  // Cycle 2: same SKU, but the PO data shifted — different volume,
  // different prices, different title text, different rationale.
  const draftCycle2 = {
    leverId: "sku_price_benchmark" as const,
    title: "Standardize SKU-A to lowest verified price (refreshed)",
    rationale: "r2 — different rationale text after data refresh",
    recommendedAction: "a",
    rawProjectedSavingsUsd: 2500,
    inputs: {
      sku: "SKU-A",
      minPriceUsd: 4,
      avgPriceUsd: 9,
      maxPriceUsd: 14,
      totalQty: 1500,
      totalSpendUsd: 13500,
      poCount: 18,
    },
  };
  const keyC1 = composeSignalKey(skuPriceBenchmarkLever, draftCycle1);
  const keyC2 = composeSignalKey(skuPriceBenchmarkLever, draftCycle2);
  assert.equal(
    keyC1,
    keyC2,
    "same SKU across cycles MUST produce the SAME signal key even when title/rationale/inputs metrics drift (refresh-stability)",
  );
  assert.ok(
    keyC1 !== null,
    "lever with cohortKey() returning a non-empty value MUST produce a non-null signal key",
  );

  // (b) No false collision: two distinct SKUs.
  const draftSkuB = {
    ...draftCycle1,
    inputs: { ...draftCycle1.inputs, sku: "SKU-B" },
  };
  const keyB = composeSignalKey(skuPriceBenchmarkLever, draftSkuB);
  assert.notEqual(
    keyC1,
    keyB,
    "two distinct SKUs in the same lever MUST get distinct signal keys (no false collapse)",
  );

  // Null-fallback contract: a draft with no stable identity (no
  // supplier, no category, lever doesn't override cohortKey or
  // returns "") MUST produce a null key — the row will write
  // signal_key IS NULL and won't dedupe (legacy escape hatch).
  const noopLever = {
    leverId: "sku_price_benchmark" as const,
    tier: 1 as const,
    label: "noop",
    description: "noop",
    analyze: async () => [],
  };
  const orphanDraft = {
    leverId: "sku_price_benchmark" as const,
    title: "no-id draft",
    rationale: "r",
    recommendedAction: "a",
    rawProjectedSavingsUsd: 1,
    inputs: {},
  };
  assert.equal(
    composeSignalKey(noopLever, orphanDraft),
    null,
    "a draft with no stable identity MUST produce a null signal key (legacy escape hatch)",
  );
});

test("cycle Act: refresh on subsequent run with mutated content updates the same row (#219 review)", async (t) => {
  // End-to-end pin of the cycle-level refresh-on-mutation contract:
  // simulate two cycles for the same draft identity (same SKU) with
  // shifted metric inputs and rationale text. The cycle Act step
  // MUST upsert into the SAME opportunity row both times — `id`,
  // `created_at`, `cycle_id` (set on the original insert) preserved;
  // narrative + metric columns + `last_seen_at` refreshed.
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  await cleanup();
  await seed();
  t.after(async () => {
    try {
      await cleanup();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("cleanup failed", err);
    }
  });

  const { composeSignalKey } = await import("../src/lib/levers/types.js");
  const { skuPriceBenchmarkLever } = await import(
    "../src/lib/levers/tier1.js"
  );

  // Build the same per-cycle drafts with shifted metric fields, then
  // hand the EXACT same upsert helper used by `runAnalysisCycle`.
  const draftA1 = {
    leverId: "sku_price_benchmark" as const,
    title: "SKU-XYZ initial",
    rationale: "rationale v1",
    recommendedAction: "act",
    rawProjectedSavingsUsd: 1000,
    inputs: { sku: "SKU-XYZ", avg: 8, total: 5000 },
  };
  const draftA2 = {
    leverId: "sku_price_benchmark" as const,
    title: "SKU-XYZ refreshed (data shifted)",
    rationale: "rationale v2 — totally different text",
    recommendedAction: "act revised",
    rawProjectedSavingsUsd: 2500,
    inputs: { sku: "SKU-XYZ", avg: 11, total: 9000 },
  };

  const sigKey = composeSignalKey(skuPriceBenchmarkLever, draftA1);
  const sigKey2 = composeSignalKey(skuPriceBenchmarkLever, draftA2);
  assert.ok(sigKey, "cycle 1 draft must produce a non-null signal key");
  assert.equal(
    sigKey,
    sigKey2,
    "cycle 2 draft for the same SKU MUST produce the same signal key",
  );

  const insertedRow = await upsert({
    rowId: `${RUN_TAG}-cycle1-id`,
    signalKey: sigKey,
    title: draftA1.title,
    lastSeenAt: new Date(Date.now() - 5_000),
    rawProjected: draftA1.rawProjectedSavingsUsd.toFixed(2),
    projected: draftA1.rawProjectedSavingsUsd.toFixed(2),
  });
  assert.equal(insertedRow.inserted, true, "first cycle inserts");

  const refreshedRow = await upsert({
    rowId: `${RUN_TAG}-cycle2-id-IGNORED`, // would-be new id; must NOT be used
    signalKey: sigKey2,
    title: draftA2.title,
    lastSeenAt: new Date(),
    rawProjected: draftA2.rawProjectedSavingsUsd.toFixed(2),
    projected: draftA2.rawProjectedSavingsUsd.toFixed(2),
  });
  assert.equal(
    refreshedRow.inserted,
    false,
    "second cycle MUST refresh the existing row (NOT insert a new one) even though title and projection mutated",
  );
  assert.equal(
    refreshedRow.id,
    insertedRow.id,
    "id is preserved across the refresh",
  );
  assert.equal(
    refreshedRow.title,
    draftA2.title,
    "title is updated to the cycle-2 value on refresh",
  );

  // Exactly one opportunity row exists for this signal across both
  // cycles — the queue did NOT grow.
  const rows = await db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.orgId, ORG_ID));
  assert.equal(
    rows.length,
    1,
    "exactly one row must exist for this signal across two cycles (queue does NOT grow)",
  );
});

test.after(async () => {
  await pool.end();
});
