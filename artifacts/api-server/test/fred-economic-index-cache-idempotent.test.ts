/**
 * Integration test: FRED economic index live `collect()` short-circuits
 * via ETag / Last-Modified when upstream confirms the per-series
 * observation set hasn't moved.
 *
 * Mirrors `bls-economic-index-cache-idempotent.test.ts` for the FRED
 * collector. Three failure modes this guards against:
 *
 *   1. **Re-running the cron parses the upstream JSON every time.**
 *      Without a per-series cache watermark, every recurring run
 *      re-GETs and re-parses every series even when nothing moved.
 *      We assert the second run's per-series HTTP responses come back
 *      as `304 Not Modified` and the JSON body is never parsed.
 *
 *   2. **Watermark gets ignored / regresses.** A future refactor that
 *      stops sending `If-None-Match` would silently work — until the
 *      next FRED quota burn. We assert the second run sends the
 *      prior run's `ETag` value as `If-None-Match` per series, and
 *      that the `cache_watermark` audit row carries the headers.
 *
 *   3. **Skip path masks a real FRED publication.** When a series'
 *      `ETag` bumps and upstream serves a fresh observation, the run
 *      must NOT short-circuit — it must parse the new body and emit
 *      a draft. We bump the stub headers + payload between runs to
 *      simulate this.
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
import { and, desc, eq } from "drizzle-orm";
import {
  approveCollector,
  registerCollector,
  runCollector,
  upsertCollectorRegistration,
} from "../src/lib/intelligence/runtime";
import {
  FRED_ECONOMIC_INDEX_COLLECTOR_ID,
  FRED_SERIES,
  fredEconomicIndexCollector,
} from "../src/lib/intelligence/collectors/fred-economic-index";
import { CACHE_WATERMARK_EVENT } from "../src/lib/intelligence/collectors/cache-watermarks";

const ETAG_V1 = '"fred-v1"';
const LAST_MODIFIED_V1 = "Wed, 15 Jan 2025 12:00:00 GMT";
const ETAG_V2 = '"fred-v2"';
const LAST_MODIFIED_V2 = "Wed, 15 Feb 2025 12:00:00 GMT";

/**
 * Series we'll have upstream serve a real observation for. Picked one
 * material-scoped (WPU101 → IRON_STEEL) and one category-scoped
 * (PCU484121484121 → FREIGHT_TRUCKING_TL) so the row counts stay
 * predictable. Every other registered series returns 200 with an empty
 * observations array, so no draft is emitted for them but the cache
 * headers are still captured.
 */
const FIXED_OBSERVATIONS: Record<
  string,
  Array<{ date: string; value: string }>
> = {
  WPU101: [{ date: "2024-01-15", value: "287.5" }],
  PCU484121484121: [{ date: "2024-01-15", value: "188.2" }],
};

interface CapturedFredRequest {
  seriesId: string;
  ifNoneMatch: string | null;
  ifModifiedSince: string | null;
}

test("fredEconomicIndexCollector.collect short-circuits on 304 and re-fetches when ETag bumps", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const prevApiKey = process.env["FRED_API_KEY"];
  process.env["FRED_API_KEY"] = prevApiKey ?? "test-key";

  const realFetch = globalThis.fetch;
  let captured: CapturedFredRequest[] = [];
  let bodyParseCount = 0;
  let currentEtag = ETAG_V1;
  let currentLastModified = LAST_MODIFIED_V1;
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
    if (!url.includes("api.stlouisfed.org/fred/series/observations")) {
      return realFetch(input, init);
    }
    const u = new URL(url);
    const seriesId = u.searchParams.get("series_id") ?? "";
    const headers = new Headers(init?.headers ?? {});
    const ifNoneMatch = headers.get("If-None-Match");
    const ifModifiedSince = headers.get("If-Modified-Since");
    captured.push({ seriesId, ifNoneMatch, ifModifiedSince });
    if (ifNoneMatch && ifNoneMatch === currentEtag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: currentEtag, "Last-Modified": currentLastModified },
      });
    }
    const observations = FIXED_OBSERVATIONS[seriesId] ?? [];
    const res = new Response(JSON.stringify({ observations }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: currentEtag,
        "Last-Modified": currentLastModified,
      },
    });
    // Override `.json()` via defineProperty because `Response.json` is
    // a read-only accessor on the prototype and direct assignment fails
    // under strict TypeScript.
    const realJson = res.json.bind(res);
    Object.defineProperty(res, "json", {
      configurable: true,
      writable: true,
      value: async () => {
        bodyParseCount += 1;
        return realJson();
      },
    });
    return res;
  }) as typeof fetch;

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
        eq(collectorAuditLogTable.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID),
      );
  }

  t.after(async () => {
    globalThis.fetch = realFetch;
    if (prevApiKey === undefined) delete process.env["FRED_API_KEY"];
    else process.env["FRED_API_KEY"] = prevApiKey;
    try {
      await deleteTestData();
    } catch (err) {
      console.error("[cleanup] FRED cache test cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteTestData();

  // ---- 1) First run: no watermark → every series fetched + parsed.
  await runCollector(FRED_ECONOMIC_INDEX_COLLECTOR_ID);
  const run1Calls = captured.length;
  assert.equal(
    run1Calls,
    FRED_SERIES.length,
    "run 1 should fetch every registered series exactly once",
  );
  for (const req of captured) {
    assert.equal(
      req.ifNoneMatch,
      null,
      "run 1 has no prior watermark; If-None-Match must be unset",
    );
    assert.equal(
      req.ifModifiedSince,
      null,
      "run 1 has no prior watermark; If-Modified-Since must be unset",
    );
  }
  assert.equal(
    bodyParseCount,
    run1Calls,
    "run 1 parses every per-series JSON body",
  );

  const [watermarkRow1] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID),
        eq(collectorAuditLogTable.event, CACHE_WATERMARK_EVENT),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  assert.ok(watermarkRow1, "run 1 must write a cache_watermark audit row");
  const entries1 = (watermarkRow1!.metadata as Record<string, unknown>)[
    "entries"
  ] as Record<string, { etag: string; lastModified: string }>;
  // Every distinct series id we POSTed must have an entry in the
  // watermark map keyed by the series id.
  const requestedSeriesIds = new Set(captured.map((c) => c.seriesId));
  for (const seriesId of requestedSeriesIds) {
    const entry = entries1[seriesId];
    assert.ok(
      entry,
      `watermark map must contain entry for series ${seriesId}`,
    );
    assert.equal(entry.etag, ETAG_V1);
    assert.equal(entry.lastModified, LAST_MODIFIED_V1);
  }

  // ---- 2) Second run: every series returns 304 with prior ETag.
  captured = [];
  bodyParseCount = 0;
  await runCollector(FRED_ECONOMIC_INDEX_COLLECTOR_ID);
  assert.equal(
    captured.length,
    FRED_SERIES.length,
    "run 2 still issues a GET per series so upstream can decide 200 vs 304",
  );
  for (const req of captured) {
    assert.equal(
      req.ifNoneMatch,
      ETAG_V1,
      `run 2 must send prior ETag as If-None-Match for ${req.seriesId}`,
    );
    assert.equal(
      req.ifModifiedSince,
      LAST_MODIFIED_V1,
      `run 2 must send prior Last-Modified as If-Modified-Since for ${req.seriesId}`,
    );
  }
  assert.equal(
    bodyParseCount,
    0,
    "run 2: every series returned 304 → JSON body must NEVER be parsed",
  );

  // Row count is stable across the 304 re-run (no new draft inserts).
  const rowsAfter2 = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(
      eq(marketSignalsTable.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID),
    );
  const expectedRowsAfter1 = Object.values(FIXED_OBSERVATIONS).reduce(
    (n, obs) => n + obs.length,
    0,
  );
  assert.equal(
    rowsAfter2.length,
    expectedRowsAfter1,
    "row count is unchanged after a 304 re-run",
  );

  // ---- 3) Bump upstream → 200 with fresh payload. Run must parse the
  // new body and write a fresh cache_watermark row.
  captured = [];
  bodyParseCount = 0;
  currentEtag = ETAG_V2;
  currentLastModified = LAST_MODIFIED_V2;
  await runCollector(FRED_ECONOMIC_INDEX_COLLECTOR_ID);
  assert.equal(
    captured.length,
    FRED_SERIES.length,
    "run 3 still issues a GET per series",
  );
  for (const req of captured) {
    assert.equal(req.ifNoneMatch, ETAG_V1);
    assert.equal(req.ifModifiedSince, LAST_MODIFIED_V1);
  }
  assert.equal(
    bodyParseCount,
    FRED_SERIES.length,
    "run 3: every series returned 200 → JSON body parsed once per series",
  );

  const [watermarkRow3] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID),
        eq(collectorAuditLogTable.event, CACHE_WATERMARK_EVENT),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  assert.ok(watermarkRow3, "run 3 must write a fresh cache_watermark row");
  const entries3 = (watermarkRow3!.metadata as Record<string, unknown>)[
    "entries"
  ] as Record<string, { etag: string; lastModified: string }>;
  for (const seriesId of requestedSeriesIds) {
    assert.equal(
      entries3[seriesId]!.etag,
      ETAG_V2,
      `run 3 must advance watermark ETag for ${seriesId}`,
    );
    assert.equal(entries3[seriesId]!.lastModified, LAST_MODIFIED_V2);
  }

  // Row count is stable (the canned observation date+value matches the
  // first run, so the natural-key dedupe collides on the MERGE) — but
  // the headline assertion is that run 3 actually fetched and parsed.
  const rowsAfter3 = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(
      eq(marketSignalsTable.collectorId, FRED_ECONOMIC_INDEX_COLLECTOR_ID),
    );
  assert.equal(rowsAfter3.length, expectedRowsAfter1);
});
