/**
 * Integration test for collector-runtime de-duplication.
 *
 * Locks in the contract that re-running a collector against the same
 * upstream observations is a no-op against `market_signals`. The bug we're
 * preventing: every call to `runCollector` used to insert a fresh row per
 * draft, even when the (collector_id, signal_type, scope_*, observed_at)
 * tuple was already present, so the table grew with run count and
 * polluted analyzer inputs.
 *
 * The fix combines:
 *   - a unique index on the natural key (with COALESCE on nullable scope
 *     cols so NULL-vs-NULL collides), and
 *   - `ON CONFLICT DO NOTHING` in the runtime insert path.
 *
 * Prereqs (same as the other api-server integration tests):
 *   - `DATABASE_URL` is set and the schema has been pushed
 *     (`pnpm --filter @workspace/db run push`).
 *
 * The test registers a throw-away collector, drives `runCollector` twice
 * with the same drafts, then changes one observation and runs once more;
 * the assertions cover that:
 *   - the first run inserts every draft
 *   - the second run inserts zero rows (every draft collides on the
 *     natural key)
 *   - changing only `observed_at` for one draft inserts exactly one new
 *     row and leaves the other rows untouched
 *   - changing the value at an existing `observed_at` does NOT overwrite
 *     the original (DO NOTHING, not DO UPDATE)
 *   - the audit log records `inserted` and `duplicates` counts truthfully
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  marketSignalsTable,
  collectorAuditLogTable,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import {
  registerCollector,
  runCollector,
  upsertCollectorRegistration,
  approveCollector,
  disableCollector,
} from "../src/lib/intelligence/runtime";
import type {
  IntelligenceCollector,
  MarketSignalDraft,
} from "../src/lib/intelligence/collector";
import {
  defaultStableSignalKey,
  looseSignalDraftSchema,
} from "../src/lib/intelligence/contractHelpers";

const TEST_COLLECTOR_ID = `test-dedup-${Date.now()}-${process.pid}`;

function makeCollector(
  draftsRef: { current: MarketSignalDraft[] },
): IntelligenceCollector {
  return {
    id: TEST_COLLECTOR_ID,
    name: "Test Dedup Collector",
    description: "Throw-away collector for runtime dedup test.",
    posture: "public-api",
    sourceUrl: "https://example.test/dedup",
    defaultRateLimitRpm: 60,
    defaultScheduleCron: null,
    postureClass: "public_api",
    disclosureTier: "T1",
    jurisdiction: "US",
    retentionDays: 365,
    tenantOptInDefault: true,
    signalSchema: looseSignalDraftSchema,
    stableSignalKey(d) {
      return defaultStableSignalKey(TEST_COLLECTOR_ID, d);
    },
    async collect() {
      // Return a fresh copy each call so tests can mutate the next batch
      // without leaking through object identity.
      return draftsRef.current.map((d) => ({ ...d }));
    },
  };
}

async function deleteTestData(): Promise<void> {
  await db
    .delete(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, TEST_COLLECTOR_ID));
  await db
    .delete(collectorAuditLogTable)
    .where(eq(collectorAuditLogTable.collectorId, TEST_COLLECTOR_ID));
}

async function countRows(): Promise<number> {
  const rows = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, TEST_COLLECTOR_ID));
  return rows.length;
}

async function latestSucceededAudit(): Promise<{
  inserted: number;
  duplicates: number;
  drafts: number;
} | null> {
  const [row] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, TEST_COLLECTOR_ID),
        eq(collectorAuditLogTable.event, "fetch_succeeded"),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  if (!row) return null;
  const md = row.metadata as Record<string, unknown>;
  return {
    inserted: Number(md["inserted"] ?? -1),
    duplicates: Number(md["duplicates"] ?? -1),
    drafts: Number(md["drafts"] ?? -1),
  };
}

test("runCollector de-duplicates repeat observations via the natural-key unique index", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Two distinct fixed observation timestamps, so the test does not depend
  // on wall-clock and re-runs are reproducible.
  const observedAtA = new Date("2026-01-15T00:00:00Z");
  const observedAtB = new Date("2026-01-16T00:00:00Z");

  const draftsRef: { current: MarketSignalDraft[] } = {
    current: [
      {
        signalType: "commodity_index",
        scopeMaterialCode: "TEST_MAT_A",
        value: 100.5,
        unit: "USD/tonne",
        currency: "USD",
        observedAt: observedAtA,
        sourceUrl: "https://example.test/A",
        confidence: 0.8,
        metadata: { run: "first" },
      },
      {
        signalType: "commodity_index",
        scopeMaterialCode: "TEST_MAT_B",
        value: 200.25,
        unit: "USD/tonne",
        currency: "USD",
        observedAt: observedAtA,
        sourceUrl: "https://example.test/B",
        confidence: 0.8,
        metadata: { run: "first" },
      },
    ],
  };

  registerCollector(makeCollector(draftsRef));

  await upsertCollectorRegistration({
    id: TEST_COLLECTOR_ID,
    name: "Test Dedup Collector",
    description: "Throw-away collector for runtime dedup test.",
    posture: "public-api",
    owner: "tests",
    sourceUrl: "https://example.test/dedup",
    rateLimitRpm: 60,
    scheduleCron: null,
    notes: null,
    actor: "tests",
  });
  await approveCollector(TEST_COLLECTOR_ID, "tests");

  t.after(async () => {
    try {
      await deleteTestData();
      // Mark the row as rejected so it doesn't show up as an approved
      // collector in operator UI even if cleanup of the registry row
      // somehow fails. CollectorsTable rows themselves are kept for
      // simplicity (FK from audit log + signals would block delete, and
      // we already wiped both).
      await disableCollector(TEST_COLLECTOR_ID, "tests", "rejected");
    } catch (err) {
      console.error("[cleanup] dedup test cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteTestData();

  // 1) First run: both drafts are new — both rows inserted.
  const r1 = await runCollector(TEST_COLLECTOR_ID);
  assert.equal(r1.signalsCollected, 2, "first run inserts both drafts");
  assert.equal(await countRows(), 2);
  const audit1 = await latestSucceededAudit();
  assert.deepEqual(audit1, { inserted: 2, duplicates: 0, drafts: 2 });

  // 2) Second run: identical drafts — zero new rows, two duplicates skipped.
  const r2 = await runCollector(TEST_COLLECTOR_ID);
  assert.equal(r2.signalsCollected, 0, "second run inserts no new rows");
  assert.equal(await countRows(), 2, "row count is stable across re-runs");
  const audit2 = await latestSucceededAudit();
  assert.deepEqual(audit2, { inserted: 0, duplicates: 2, drafts: 2 });

  // 3) Move one draft to a new observed_at and tweak the other's value
  //    (same observed_at) — only the time-shifted row should be inserted;
  //    the value change at an existing key must be a no-op (DO NOTHING).
  draftsRef.current = [
    {
      ...draftsRef.current[0]!,
      observedAt: observedAtB,
      metadata: { run: "third" },
    },
    {
      ...draftsRef.current[1]!,
      value: 999.99,
      metadata: { run: "third-attempt-overwrite" },
    },
  ];
  const r3 = await runCollector(TEST_COLLECTOR_ID);
  assert.equal(
    r3.signalsCollected,
    1,
    "third run inserts only the time-shifted row",
  );
  assert.equal(await countRows(), 3);
  const audit3 = await latestSucceededAudit();
  assert.deepEqual(audit3, { inserted: 1, duplicates: 1, drafts: 2 });

  // Confirm the value at the original (collector, type, MAT_B, observedAtA)
  // key was NOT overwritten — DO NOTHING means original wins.
  const [matBOriginal] = await db
    .select()
    .from(marketSignalsTable)
    .where(
      and(
        eq(marketSignalsTable.collectorId, TEST_COLLECTOR_ID),
        eq(marketSignalsTable.scopeMaterialCode, "TEST_MAT_B"),
        eq(marketSignalsTable.observedAt, observedAtA),
      ),
    );
  assert.ok(matBOriginal, "original MAT_B row still present");
  assert.equal(
    Number(matBOriginal!.value),
    200.25,
    "original value preserved on conflict",
  );

  // 4) Blank-string scope normalization. The natural-key index uses
  //    COALESCE(scope_*, '') so NULL and '' would otherwise collide and
  //    silently merge unrelated rows. The runtime trims blanks to NULL,
  //    so a draft that emits "" must dedupe against a draft that emits
  //    null at the same observed_at.
  draftsRef.current = [
    {
      signalType: "commodity_index",
      scopeMaterialCode: undefined,
      value: 1,
      unit: "USD",
      currency: "USD",
      observedAt: new Date("2026-02-01T00:00:00Z"),
      sourceUrl: "https://example.test/blank",
      confidence: 0.5,
      metadata: { round: 1, sent: "null" },
    },
  ];
  const r4 = await runCollector(TEST_COLLECTOR_ID);
  assert.equal(r4.signalsCollected, 1, "fresh unscoped row inserted");
  draftsRef.current = [
    {
      signalType: "commodity_index",
      scopeMaterialCode: "   ", // blank/whitespace must normalize to null
      value: 1,
      unit: "USD",
      currency: "USD",
      observedAt: new Date("2026-02-01T00:00:00Z"),
      sourceUrl: "https://example.test/blank",
      confidence: 0.5,
      metadata: { round: 2, sent: "blank-string" },
    },
  ];
  const r5 = await runCollector(TEST_COLLECTOR_ID);
  assert.equal(
    r5.signalsCollected,
    0,
    "blank-string scope must dedupe against the null-scope row",
  );
});
