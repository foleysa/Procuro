/**
 * Integration test: ECB FX historical backfill is idempotent and skips
 * cleanly when the upstream archive hasn't moved.
 *
 * Four failure modes this guards against:
 *
 *   1. **Re-running the backfill double-inserts rows.** The historical
 *      archive has ~7,000 business days × ~18 (EUR-base + USD-derived)
 *      pairs ≈ 125k rows; without the natural-key dedupe the table
 *      doubles every backfill press. We stub the historical XML, run
 *      the backfill twice without bumping `Last-Modified`, and assert
 *      the second run touched zero rows.
 *
 *   2. **DB pre-check gets ignored / regresses.** A warm re-run while
 *      the upstream cannot possibly have published yet (i.e., we're
 *      still inside the same publication window) must short-circuit on
 *      a single indexed lookup against `market_signals` — without ever
 *      touching the network. We assert HEAD is NOT probed on the
 *      immediate re-run and that a `backfill_skipped_already_up_to_date`
 *      audit row is written.
 *
 *   3. **Last-Modified watermark gets ignored.** Once the publication
 *      window opens (per ECB's daily 16:00 CET schedule), the runtime
 *      must fall through to the HEAD probe. If HEAD's
 *      Last-Modified / ETag match the prior run's watermark, it must
 *      still short-circuit (no full GET) — that proves the HEAD path
 *      stays correct when the cheap pre-check can't help.
 *
 *   4. **Skip path masks a real ECB publication.** Correctness
 *      regression: once the publication window opens AND HEAD reports
 *      a NEW Last-Modified, the runtime must NOT short-circuit — it
 *      must fetch the full XML so a freshly published archive day is
 *      written. We bump the stub's HEAD headers and XML between runs
 *      to simulate this.
 *
 * Time control: `runEcbFxRatesBackfill` accepts an optional `nowMs`
 * for tests so we can deterministically straddle ECB's daily
 * publication window without faking the system clock.
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
 * paying for a 7,000-day fixture. Latest day is Friday 2025-01-03.
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

/**
 * Same fixture extended with one more business day (2025-01-06,
 * Monday). Used to simulate a "real" upstream publication landing
 * after the prior backfill.
 */
const HISTORICAL_XML_PLUS_ONE_DAY = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time="2025-01-06">
      <Cube currency="USD" rate="1.0510"/>
      <Cube currency="GBP" rate="0.8410"/>
      <Cube currency="JPY" rate="160.70"/>
    </Cube>
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
const HIST_LAST_MODIFIED_V2 = "Mon, 06 Jan 2025 16:00:00 GMT";
const HIST_ETAG_V2 = '"def456"';

/**
 * "Now" before the next ECB publication window opens. With latest
 * archive day = Fri 2025-01-03, the next publication can land at the
 * earliest on Mon 2025-01-06 13:30 UTC. Sat 2025-01-04 10:00 UTC is
 * comfortably inside the safe window — no possible new data upstream.
 */
const NOW_BEFORE_NEXT_PUBLICATION = Date.parse("2025-01-04T10:00:00Z");

/**
 * "Now" past the next ECB publication window. By Tue 2025-01-07
 * 10:00 UTC, ECB has had its publication slot for Mon 2025-01-06
 * already, so the runtime cannot prove there's nothing new — it must
 * defer to upstream HEAD.
 */
const NOW_AFTER_NEXT_PUBLICATION = Date.parse("2025-01-07T10:00:00Z");

test("runEcbFxRatesBackfill is idempotent and short-circuits via DB pre-check + HEAD watermark", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Stub global fetch for ECB historical archive only. Pass through
  // anything else (defensive — current code path makes no other calls).
  // The stub serves whichever fixture the test currently has selected
  // via `currentXml` / `currentLastModified` / `currentEtag`.
  const realFetch = globalThis.fetch;
  let getCount = 0;
  let headCount = 0;
  let currentXml = HISTORICAL_XML;
  let currentLastModified = HIST_LAST_MODIFIED;
  let currentEtag = HIST_ETAG;
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
        "Last-Modified": currentLastModified,
        ETag: currentEtag,
        "Content-Type": "application/xml",
      });
      if (method === "HEAD") {
        headCount += 1;
        return new Response(null, { status: 200, headers });
      }
      getCount += 1;
      return new Response(currentXml, { status: 200, headers });
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
  const r1 = await runEcbFxRatesBackfill({
    nowMs: NOW_BEFORE_NEXT_PUBLICATION,
  });
  assert.equal(r1.collectorId, ECB_FX_RATES_COLLECTOR_ID);
  assert.equal(r1.daysWritten, 3, "three day blocks in fixture");
  // 3 EUR-base pairs (USD/GBP/JPY) + 2 USD-derived pairs (GBP/JPY) = 5 / day.
  assert.equal(
    r1.signalsInserted,
    3 * 5,
    "first run inserts every day × pair row",
  );
  assert.equal(r1.signalsSkipped, 0);
  assert.notEqual(
    r1.alreadyUpToDate,
    true,
    "first run is not flagged as already up to date (it just wrote rows)",
  );
  assert.equal(getCount, 1, "first run fetched the full XML once");
  // First run has no prior watermark; HEAD must NOT be probed.
  assert.equal(headCount, 0, "first run skips HEAD because no watermark exists");

  // Sanity: rows landed.
  const insertedRows = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, ECB_FX_RATES_COLLECTOR_ID));
  assert.equal(insertedRows.length, 15);

  // 2) Second run inside the same publication window: DB pre-check
  //    must short-circuit on the prior `backfill_succeeded` audit row
  //    (which stamps the latest archived day) — without touching the
  //    network at all. This is the warm-restart path the task targets.
  const t0 = Date.now();
  const r2 = await runEcbFxRatesBackfill({
    nowMs: NOW_BEFORE_NEXT_PUBLICATION,
  });
  const r2Duration = Date.now() - t0;
  assert.equal(
    r2.signalsInserted,
    0,
    "second run inserts zero rows (short-circuit on DB pre-check)",
  );
  assert.equal(r2.daysWritten, 0);
  assert.equal(r2.signalsSkipped, 0);
  assert.equal(
    r2.alreadyUpToDate,
    true,
    "second run flags the result as already up to date",
  );
  assert.equal(
    headCount,
    0,
    "second run does NOT probe HEAD (DB pre-check skipped it)",
  );
  assert.equal(getCount, 1, "second run does NOT re-fetch the full XML");
  // Empirically the pre-check path is ~10ms; give it 4s of headroom
  // for slow CI but still much faster than re-running the full pipeline.
  assert.ok(
    r2Duration < 4000,
    `second run should be near-instant when short-circuited (took ${r2Duration}ms)`,
  );

  // Audit log should record the DB pre-check skip.
  const [precheckAudit] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, ECB_FX_RATES_COLLECTOR_ID),
        eq(collectorAuditLogTable.event, "backfill_skipped_already_up_to_date"),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  assert.ok(
    precheckAudit,
    "backfill_skipped_already_up_to_date audit row should exist",
  );
  const precheckMeta = precheckAudit!.metadata as Record<string, unknown>;
  assert.equal(precheckMeta["latestArchiveDate"], "2025-01-03");
  assert.equal(precheckMeta["archiveLastModified"], HIST_LAST_MODIFIED);
  assert.equal(precheckMeta["archiveEtag"], HIST_ETAG);
  // Sanity: stamped next-publication is the next ECB business-day window.
  assert.equal(
    precheckMeta["nextPublicationEarliestAt"],
    "2025-01-06T13:30:00.000Z",
  );

  // 3) Now we step past the next publication window. The DB pre-check
  //    can no longer prove "no new data," so it must fall through to
  //    the HEAD probe. HEAD's headers haven't moved, so the runtime
  //    short-circuits on watermark match instead of re-fetching the
  //    full XML.
  const r3 = await runEcbFxRatesBackfill({
    nowMs: NOW_AFTER_NEXT_PUBLICATION,
  });
  assert.equal(r3.signalsInserted, 0, "HEAD-path re-run inserts zero rows");
  assert.equal(r3.alreadyUpToDate, true, "HEAD-path skip is also flagged");
  assert.equal(
    headCount,
    1,
    "HEAD probe runs once when the publication window has opened",
  );
  assert.equal(getCount, 1, "HEAD-path re-run does NOT re-fetch the full XML");
  const [headAudit] = await db
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
  assert.ok(headAudit, "backfill_skipped_unchanged audit row should exist");
  const headMeta = headAudit!.metadata as Record<string, unknown>;
  assert.equal(headMeta["archiveLastModified"], HIST_LAST_MODIFIED);
  assert.equal(headMeta["archiveEtag"], HIST_ETAG);

  // 4) **Correctness regression**: a fresh ECB publication that lands
  //    after the prior backfill must NOT be masked by the skip path.
  //    We bump the stub's HEAD headers and add a new business day to
  //    the served archive — the runtime must see HEAD has moved, fall
  //    through to the full GET, and write the new day's rows.
  currentXml = HISTORICAL_XML_PLUS_ONE_DAY;
  currentLastModified = HIST_LAST_MODIFIED_V2;
  currentEtag = HIST_ETAG_V2;
  const r4 = await runEcbFxRatesBackfill({
    nowMs: NOW_AFTER_NEXT_PUBLICATION,
  });
  assert.notEqual(
    r4.alreadyUpToDate,
    true,
    "fresh upstream publication must NOT be reported as already up to date",
  );
  assert.equal(r4.daysWritten, 4, "served fixture now has four day blocks");
  assert.equal(
    r4.signalsInserted,
    5,
    "only the new day's 5 rows are inserted; the other 15 collide on natural key",
  );
  assert.equal(r4.signalsSkipped, 15);
  assert.equal(headCount, 2, "fourth run probes HEAD once more");
  assert.equal(getCount, 2, "fourth run re-fetches the full XML (HEAD changed)");

  // 5) `force: true` must override both short-circuits and still be
  //    idempotent against `market_signals` (every row collides; nothing
  //    new is written).
  const r5 = await runEcbFxRatesBackfill({ force: true });
  assert.equal(
    r5.signalsInserted,
    0,
    "forced re-run inserts zero rows because every draft collides on natural key",
  );
  assert.equal(r5.daysWritten, 4);
  assert.equal(
    r5.signalsSkipped,
    20,
    "forced re-run reports every row as a duplicate-skip",
  );
  assert.notEqual(
    r5.alreadyUpToDate,
    true,
    "forced re-run is not flagged as already up to date",
  );
  assert.equal(getCount, 3, "forced run re-fetches the full XML");
  assert.equal(
    headCount,
    2,
    "forced run skips the HEAD probe (force bypasses watermark)",
  );

  // Row count is stable (15 from run 1 + 5 from run 4; runs 2/3/5
  // wrote nothing).
  const finalRows = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, ECB_FX_RATES_COLLECTOR_ID));
  assert.equal(finalRows.length, 20, "row count stable across re-runs");
});
