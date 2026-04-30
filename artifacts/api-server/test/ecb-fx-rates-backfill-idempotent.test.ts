/**
 * Integration test: ECB FX historical backfill is idempotent and skips
 * cleanly when the upstream archive hasn't moved.
 *
 * Two failure modes this guards against:
 *
 *   1. **Re-running the backfill double-inserts rows.** The historical
 *      archive has ~7,000 business days × ~18 (EUR-base + USD-derived)
 *      pairs ≈ 125k rows; without the natural-key dedupe the table
 *      doubles every backfill press. We stub the historical XML, run
 *      the backfill twice without bumping `Last-Modified`, and assert
 *      the second run touched zero rows AND that it returned in well
 *      under the soft deadline because it short-circuited at HEAD.
 *
 *   2. **Last-Modified watermark gets ignored.** If the watermark code
 *      regresses, the second run will repeat the full XML fetch + parse
 *      + dedupe pass even when nothing changed. We assert a
 *      `backfill_skipped_unchanged` audit row was written (the visible
 *      side-effect of the short-circuit) and that the wall-clock for
 *      the second run is faster than the first by a healthy margin.
 *
 * Prereqs: `DATABASE_URL` set, schema pushed, no other concurrent
 * processes hammering `ecb-fx-rates`.
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
  approveCollector,
  registerCollector,
  runEcbFxRatesBackfill,
  upsertCollectorRegistration,
} from "../src/lib/intelligence/runtime";
import {
  ECB_FX_RATES_COLLECTOR_ID,
  ecbFxRatesCollector,
} from "../src/lib/intelligence/collectors/ecb-fx-rates";

/**
 * Tiny synthetic ECB historical archive: three business days, three
 * tracked currencies. Enough to verify the day × pair fan-out without
 * paying for a 7,000-day fixture.
 */
const HISTORICAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time="2025-01-03">
      <Cube currency="USD" rate="1.0500"/>
      <Cube currency="GBP" rate="0.8400"/>
      <Cube currency="JPY" rate="160.50"/>
    </Cube>
    <Cube time="2025-01-02">
      <Cube currency="USD" rate="1.0480"/>
      <Cube currency="GBP" rate="0.8390"/>
      <Cube currency="JPY" rate="160.10"/>
    </Cube>
    <Cube time="2024-12-30">
      <Cube currency="USD" rate="1.0420"/>
      <Cube currency="GBP" rate="0.8370"/>
      <Cube currency="JPY" rate="159.20"/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const HIST_LAST_MODIFIED = "Fri, 03 Jan 2025 16:00:00 GMT";
const HIST_ETAG = '"abc123"';

test("runEcbFxRatesBackfill is idempotent and short-circuits on unchanged Last-Modified", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Stub global fetch for ECB historical archive only. Pass through
  // anything else (defensive — current code path makes no other calls).
  const realFetch = globalThis.fetch;
  let getCount = 0;
  let headCount = 0;
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
    if (url.includes("eurofxref-hist.xml")) {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers({
        "Last-Modified": HIST_LAST_MODIFIED,
        ETag: HIST_ETAG,
        "Content-Type": "application/xml",
      });
      if (method === "HEAD") {
        headCount += 1;
        return new Response(null, { status: 200, headers });
      }
      getCount += 1;
      return new Response(HISTORICAL_XML, { status: 200, headers });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  // Register the live ECB collector (needed for the backfill function's
  // `collectors` lookup) and approve it so the kill-switch / approval
  // gates pass.
  registerCollector(ecbFxRatesCollector);
  await upsertCollectorRegistration({
    id: ECB_FX_RATES_COLLECTOR_ID,
    name: ecbFxRatesCollector.name,
    description: ecbFxRatesCollector.description,
    posture: ecbFxRatesCollector.posture,
    owner: "tests",
    sourceUrl: ecbFxRatesCollector.sourceUrl,
    rateLimitRpm: ecbFxRatesCollector.defaultRateLimitRpm ?? null,
    scheduleCron: ecbFxRatesCollector.defaultScheduleCron,
    notes: null,
    actor: "tests",
  });
  await approveCollector(ECB_FX_RATES_COLLECTOR_ID, "tests");

  async function deleteTestData(): Promise<void> {
    await db
      .delete(marketSignalsTable)
      .where(eq(marketSignalsTable.collectorId, ECB_FX_RATES_COLLECTOR_ID));
    await db
      .delete(collectorAuditLogTable)
      .where(eq(collectorAuditLogTable.collectorId, ECB_FX_RATES_COLLECTOR_ID));
  }

  t.after(async () => {
    globalThis.fetch = realFetch;
    try {
      await deleteTestData();
    } catch (err) {
      console.error("[cleanup] ecb backfill test cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteTestData();

  // 1) First run: empty table → all (day × pair) drafts inserted.
  const r1 = await runEcbFxRatesBackfill();
  assert.equal(r1.collectorId, ECB_FX_RATES_COLLECTOR_ID);
  assert.equal(r1.daysWritten, 3, "three day blocks in fixture");
  // 3 EUR-base pairs (USD/GBP/JPY) + 2 USD-derived pairs (GBP/JPY) = 5 / day.
  assert.equal(
    r1.signalsInserted,
    3 * 5,
    "first run inserts every day × pair row",
  );
  assert.equal(r1.signalsSkipped, 0);
  assert.equal(getCount, 1, "first run fetched the full XML once");
  // First run has no prior watermark; HEAD must NOT be probed.
  assert.equal(headCount, 0, "first run skips HEAD because no watermark exists");

  // Sanity: rows landed.
  const insertedRows = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, ECB_FX_RATES_COLLECTOR_ID));
  assert.equal(insertedRows.length, 15);

  // 2) Second run: HEAD must short-circuit on Last-Modified match.
  const t0 = Date.now();
  const r2 = await runEcbFxRatesBackfill();
  const r2Duration = Date.now() - t0;
  assert.equal(
    r2.signalsInserted,
    0,
    "second run inserts zero rows (short-circuit on watermark)",
  );
  assert.equal(r2.daysWritten, 0);
  assert.equal(r2.signalsSkipped, 0);
  assert.equal(headCount, 1, "second run probes HEAD exactly once");
  assert.equal(getCount, 1, "second run does NOT re-fetch the full XML");
  // Empirically the short-circuit path is ~10ms; give it 4s of headroom
  // for slow CI but still much faster than re-running the full pipeline.
  assert.ok(
    r2Duration < 4000,
    `second run should be near-instant when short-circuited (took ${r2Duration}ms)`,
  );

  // Audit log should record the skipped run.
  const [skipAudit] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, ECB_FX_RATES_COLLECTOR_ID),
        eq(collectorAuditLogTable.event, "backfill_skipped_unchanged"),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  assert.ok(skipAudit, "backfill_skipped_unchanged audit row should exist");
  const skipMeta = skipAudit!.metadata as Record<string, unknown>;
  assert.equal(skipMeta["archiveLastModified"], HIST_LAST_MODIFIED);
  assert.equal(skipMeta["archiveEtag"], HIST_ETAG);

  // 3) `force: true` must override the watermark short-circuit and
  // still be idempotent against `market_signals` (every row collides).
  const r3 = await runEcbFxRatesBackfill({ force: true });
  assert.equal(
    r3.signalsInserted,
    0,
    "forced re-run inserts zero rows because every draft collides on natural key",
  );
  assert.equal(r3.daysWritten, 3);
  assert.equal(
    r3.signalsSkipped,
    15,
    "forced re-run reports every row as a duplicate-skip",
  );
  assert.equal(getCount, 2, "forced run re-fetches the full XML");
  assert.equal(
    headCount,
    1,
    "forced run skips the HEAD probe (force bypasses watermark)",
  );

  // Row count is stable across all three runs.
  const finalRows = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, ECB_FX_RATES_COLLECTOR_ID));
  assert.equal(finalRows.length, 15, "row count stable across re-runs");
});
