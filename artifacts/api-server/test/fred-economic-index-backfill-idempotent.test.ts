/**
 * Integration test: FRED economic index historical backfill is idempotent.
 *
 * The pure-function tests in `fred-economic-index-backfill.test.ts` lock
 * in that the live and backfill paths build identically-keyed drafts —
 * but the actual "second run inserts zero rows" guarantee is enforced by
 * the runtime's `insertSignalsIdempotent` against the real
 * `market_signals` natural-key unique index. This test pins that contract
 * end-to-end so a future change to the dedupe key (or to the
 * material/category scope-column routing) cannot silently double-write
 * history every time an admin clicks the "Backfill" button.
 *
 * Strategy:
 *   1. Stub `globalThis.fetch` so the FRED API returns a small, fixed
 *      observation set for one **material-scoped** series (`WPU101` →
 *      `IRON_STEEL`) and one **category-scoped** series
 *      (`PCU484121484121` → `FREIGHT_TRUCKING_TL`). Every other series
 *      in `FRED_SERIES` returns an empty observations array — enough to
 *      keep the run from tripping the "all series failed" guard but with
 *      zero contribution to the signal set, so our assertions are exact.
 *   2. Register + approve the FRED collector, wipe any existing
 *      `market_signals` / `collector_audit_log` rows for it.
 *   3. Run `runFredEconomicIndexBackfill()` twice in sequence.
 *   4. Assert: first run inserts every (series × observation) row;
 *      second run inserts 0 and reports every row as a duplicate-skip;
 *      the row count and the actual material/category scope distribution
 *      are stable across both runs.
 *
 * Prereqs: `DATABASE_URL` set, schema pushed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  db,
  pool,
  marketSignalsTable,
  collectorAuditLogTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  approveCollector,
  registerCollector,
  runFredEconomicIndexBackfill,
  upsertCollectorRegistration,
} from "../src/lib/intelligence/runtime";
import {
  FRED_ECONOMIC_INDEX_COLLECTOR_ID,
  FRED_SERIES,
  fredEconomicIndexCollector,
} from "../src/lib/intelligence/collectors/fred-economic-index";

/**
 * Fixed observation fixtures keyed by FRED series id. Two days each, on
 * matching dates so a hypothetical bug that lost the scope-column
 * routing (e.g. wrote both into `scopeMaterialCode`) would collide and
 * be visibly wrong in the row count, not silently fall through.
 */
const FIXED_OBSERVATIONS: Record<string, Array<{ date: string; value: string }>> = {
  // Material-scoped series → routes to scopeMaterialCode = IRON_STEEL.
  WPU101: [
    { date: "2024-01-15", value: "287.5" },
    { date: "2024-02-15", value: "289.0" },
  ],
  // Category-scoped series → routes to scopeCategoryCode = FREIGHT_TRUCKING_TL.
  PCU484121484121: [
    { date: "2024-01-15", value: "188.2" },
    { date: "2024-02-15", value: "189.5" },
  ],
};

/** Total rows the first run is expected to insert. */
const EXPECTED_ROWS = Object.values(FIXED_OBSERVATIONS).reduce(
  (n, obs) => n + obs.length,
  0,
);

/** Observation dates across the fixture (for the daysWritten assertion). */
const EXPECTED_DAYS = new Set(
  Object.values(FIXED_OBSERVATIONS).flat().map((o) => o.date),
).size;

test("runFredEconomicIndexBackfill is idempotent across re-runs for material- and category-scoped series", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Ensure a key is set so `fetchFredBackfillDrafts` doesn't bail before
  // hitting our stubbed fetch. The value is irrelevant — the stub never
  // calls the real API.
  const prevApiKey = process.env["FRED_API_KEY"];
  process.env["FRED_API_KEY"] = prevApiKey ?? "test-key";

  // Stub global fetch to intercept FRED observations endpoints. Pass
  // through anything else (defensive — current backfill path makes no
  // other network calls).
  const realFetch = globalThis.fetch;
  let fredCallCount = 0;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.includes("api.stlouisfed.org/fred/series/observations")) {
      fredCallCount += 1;
      const u = new URL(url);
      const seriesId = u.searchParams.get("series_id") ?? "";
      const observations = FIXED_OBSERVATIONS[seriesId] ?? [];
      return new Response(JSON.stringify({ observations }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  // Register + approve the FRED collector so the backfill's kill-switch
  // and approval gates pass.
  registerCollector(fredEconomicIndexCollector);
  await upsertCollectorRegistration({
    id: FRED_ECONOMIC_INDEX_COLLECTOR_ID,
    name: fredEconomicIndexCollector.name,
    description: fredEconomicIndexCollector.description,
    posture: fredEconomicIndexCollector.posture,
    owner: "tests",
    sourceUrl: fredEconomicIndexCollector.sourceUrl,
    rateLimitRpm: fredEconomicIndexCollector.defaultRateLimitRpm ?? null,
    scheduleCron: fredEconomicIndexCollector.defaultScheduleCron,
    notes: null,
    actor: "tests",
  });
  await approveCollector(FRED_ECONOMIC_INDEX_COLLECTOR_ID, "tests");

  async function deleteTestData(): Promise<void> {
    await db
      .delete(marketSignalsTable)
      .where(
        eq(marketSignalsTable.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID),
      );
    await db
      .delete(collectorAuditLogTable)
      .where(
        eq(
          collectorAuditLogTable.collectorId,
          FRED_ECONOMIC_INDEX_COLLECTOR_ID,
        ),
      );
  }

  t.after(async () => {
    globalThis.fetch = realFetch;
    if (prevApiKey === undefined) delete process.env["FRED_API_KEY"];
    else process.env["FRED_API_KEY"] = prevApiKey;
    try {
      await deleteTestData();
    } catch (err) {
      console.error("[cleanup] FRED backfill test cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteTestData();

  // ---- 1) First run: empty table → every (series × observation) lands.
  const r1 = await runFredEconomicIndexBackfill();
  assert.equal(r1.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID);
  assert.equal(
    r1.signalsInserted,
    EXPECTED_ROWS,
    "first run inserts one row per (series × observation)",
  );
  assert.equal(r1.signalsSkipped, 0, "first run skips nothing");
  assert.equal(r1.daysWritten, EXPECTED_DAYS);
  assert.equal(
    fredCallCount,
    FRED_SERIES.length,
    "first run hits the FRED API once per registered series",
  );

  // Sanity: rows landed AND the scope-column routing is what we expect.
  const rowsAfterFirst = await db
    .select({
      signalType: marketSignalsTable.signalType,
      scopeMaterialCode: marketSignalsTable.scopeMaterialCode,
      scopeCategoryCode: marketSignalsTable.scopeCategoryCode,
    })
    .from(marketSignalsTable)
    .where(
      eq(marketSignalsTable.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID),
    );
  assert.equal(rowsAfterFirst.length, EXPECTED_ROWS);
  const materialRows = rowsAfterFirst.filter(
    (r) => r.scopeMaterialCode === "IRON_STEEL",
  );
  const categoryRows = rowsAfterFirst.filter(
    (r) => r.scopeCategoryCode === "FREIGHT_TRUCKING_TL",
  );
  assert.equal(
    materialRows.length,
    FIXED_OBSERVATIONS["WPU101"]!.length,
    "material-scoped FRED series lands in scope_material_code",
  );
  assert.equal(
    categoryRows.length,
    FIXED_OBSERVATIONS["PCU484121484121"]!.length,
    "category-scoped FRED series lands in scope_category_code",
  );
  // No row should have BOTH scope columns set — that would mean the
  // router accidentally cross-wrote and the dedupe key would later
  // collide spuriously across kinds.
  for (const r of rowsAfterFirst) {
    assert.ok(
      !(r.scopeMaterialCode && r.scopeCategoryCode),
      "no row has both scope_material_code and scope_category_code set",
    );
    assert.equal(r.signalType, "economic_index");
  }

  // ---- 2) Second run with no upstream changes: zero inserts, every
  // draft skipped on the natural-key unique index.
  const r2 = await runFredEconomicIndexBackfill();
  assert.equal(
    r2.signalsInserted,
    0,
    "second run inserts zero rows (every draft collides on natural key)",
  );
  assert.equal(
    r2.signalsSkipped,
    EXPECTED_ROWS,
    "second run reports every existing row as a duplicate-skip",
  );
  assert.equal(r2.daysWritten, EXPECTED_DAYS);

  // Row count must be stable — this is the headline contract.
  const rowsAfterSecond = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(
      eq(marketSignalsTable.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID),
    );
  assert.equal(
    rowsAfterSecond.length,
    EXPECTED_ROWS,
    "row count is unchanged after a second backfill run",
  );

  // ---- 3) Audit trail: both runs recorded as `backfill_succeeded`,
  // and the second one carries `inserted: 0` / `skipped: EXPECTED_ROWS`.
  const successAudits = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(
          collectorAuditLogTable.collectorId,
          FRED_ECONOMIC_INDEX_COLLECTOR_ID,
        ),
        eq(collectorAuditLogTable.event, "backfill_succeeded"),
      ),
    );
  assert.equal(
    successAudits.length,
    2,
    "exactly two backfill_succeeded audit rows after two runs",
  );
  const insertedCounts = successAudits
    .map((r) => (r.metadata as Record<string, unknown>)["inserted"])
    .sort();
  const skippedCounts = successAudits
    .map((r) => (r.metadata as Record<string, unknown>)["skipped"])
    .sort();
  assert.deepEqual(
    insertedCounts,
    [0, EXPECTED_ROWS],
    "audit metadata records inserted=EXPECTED_ROWS for run 1, 0 for run 2",
  );
  assert.deepEqual(
    skippedCounts,
    [0, EXPECTED_ROWS],
    "audit metadata records skipped=0 for run 1, EXPECTED_ROWS for run 2",
  );
});
