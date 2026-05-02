/**
 * Integration test: BLS economic index live `collect()` short-circuits
 * via ETag / Last-Modified when upstream confirms the chunk's response
 * hasn't moved.
 *
 * The mirror of `ecb-fx-rates-backfill-idempotent.test.ts` for the BLS
 * collector. Three failure modes this guards against:
 *
 *   1. **Re-running the cron parses the upstream JSON every time.**
 *      Without a cache watermark, every recurring run re-POSTs the
 *      same chunk body and re-parses ~50 series even when nothing
 *      moved upstream. The first re-run with identical upstream
 *      headers must come back as `304 Not Modified` — we assert no
 *      JSON body was parsed for the matching chunks (stub records
 *      whether `.json()` was called) and that the run still completes
 *      cleanly with zero new draft inserts.
 *
 *   2. **Watermark gets ignored / regresses.** A future refactor that
 *      stops sending `If-None-Match` would silently work — until the
 *      next BLS quota burn. We assert the second run sends the prior
 *      run's `ETag` value as `If-None-Match` and the prior run's
 *      `Last-Modified` as `If-Modified-Since`. The `cache_watermark`
 *      audit row written after run 1 must carry the headers we saw
 *      so the next run can replay them.
 *
 *   3. **Skip path masks a real BLS publication.** Correctness
 *      regression: when upstream bumps `ETag` AND returns a fresh
 *      payload, the run must NOT short-circuit — it must parse the
 *      new body and emit drafts. We bump the stub headers + payload
 *      between runs to simulate this.
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
  BLS_API_URL,
  BLS_ECONOMIC_INDEX_COLLECTOR_ID,
  BLS_SERIES,
  blsChunkCacheKey,
  blsEconomicIndexCollector,
  type BlsResponse,
  type BlsSeriesResult,
} from "../src/lib/intelligence/collectors/bls-economic-index";
import { CACHE_WATERMARK_EVENT } from "../src/lib/intelligence/collectors/cache-watermarks";

const ETAG_V1 = '"bls-v1"';
const LAST_MODIFIED_V1 = "Wed, 15 Jan 2025 12:00:00 GMT";
const ETAG_V2 = '"bls-v2"';
const LAST_MODIFIED_V2 = "Wed, 15 Feb 2025 12:00:00 GMT";

/**
 * Build a canned BLS response covering every series the collector
 * requests in a single chunk. We use uniform "100.0" filler values so
 * all that matters for the assertions is the chunked round-trip + the
 * cache-watermark short-circuit, not the parsed values.
 */
function buildCannedBlsResponse(
  seriesIdsForChunk: readonly string[],
): BlsResponse {
  const series: BlsSeriesResult[] = seriesIdsForChunk.map((id) => {
    const ref = BLS_SERIES.find((s) => s.seriesId === id);
    const period = ref?.periodicity === "quarterly" ? "Q01" : "M01";
    const periodName = period === "Q01" ? "1st Quarter" : "January";
    return {
      seriesID: id,
      data: [{ year: "2025", period, periodName, value: "100.0" }],
    };
  });
  return { status: "REQUEST_SUCCEEDED", Results: { series } };
}

interface CapturedBlsRequest {
  body: { seriesid: string[]; startyear: string; endyear: string };
  ifNoneMatch: string | null;
  ifModifiedSince: string | null;
}

test("blsEconomicIndexCollector.collect short-circuits on 304 and re-fetches when ETag bumps", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  // Force the authenticated tier so the unauthenticated no-key audit
  // warning doesn't pollute the audit-log assertions (and so the chunk
  // size matches what we precompute via blsChunkCacheKey).
  const prevApiKey = process.env["BLS_API_KEY"];
  process.env["BLS_API_KEY"] = prevApiKey ?? "test-key";

  // Stub state: per-call tracking of headers + JSON parse calls.
  const realFetch = globalThis.fetch;
  let captured: CapturedBlsRequest[] = [];
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
    if (url !== BLS_API_URL) return realFetch(input, init);
    const headers = new Headers(init?.headers ?? {});
    const ifNoneMatch = headers.get("If-None-Match");
    const ifModifiedSince = headers.get("If-Modified-Since");
    const bodyText =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    const parsed = JSON.parse(bodyText) as CapturedBlsRequest["body"];
    captured.push({ body: parsed, ifNoneMatch, ifModifiedSince });
    // 304 Not Modified when the request's If-None-Match matches the
    // current upstream ETag. Empty body — collector must not parse it.
    if (ifNoneMatch && ifNoneMatch === currentEtag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: currentEtag, "Last-Modified": currentLastModified },
      });
    }
    const json = buildCannedBlsResponse(parsed.seriesid);
    const payload = JSON.stringify(json);
    // Wrap the body in a stream so we can detect any subsequent .json()
    // / .text() call on a fresh Response — the collector must NOT call
    // either on a 304 path (which is what bodyParseCount catches).
    const res = new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: currentEtag,
        "Last-Modified": currentLastModified,
      },
    });
    // Track when the collector actually parses the body. Override
    // `.json()` via defineProperty because `Response.json` is a
    // read-only accessor on the prototype and direct assignment fails
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

  registerCollector(blsEconomicIndexCollector);
  await upsertCollectorRegistration({
    id: BLS_ECONOMIC_INDEX_COLLECTOR_ID,
    name: blsEconomicIndexCollector.name,
    description: blsEconomicIndexCollector.description,
    posture: blsEconomicIndexCollector.posture,
    owner: "tests",
    sourceUrl: blsEconomicIndexCollector.sourceUrl,
    rateLimitRpm: blsEconomicIndexCollector.defaultRateLimitRpm ?? null,
    scheduleCron: blsEconomicIndexCollector.defaultScheduleCron,
    notes: null,
    actor: "tests",
  });
  await approveCollector(BLS_ECONOMIC_INDEX_COLLECTOR_ID, "tests");

  async function deleteTestData(): Promise<void> {
    await db
      .delete(marketSignalsTable)
      .where(eq(marketSignalsTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID));
    await db
      .delete(collectorAuditLogTable)
      .where(
        eq(collectorAuditLogTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID),
      );
  }

  t.after(async () => {
    globalThis.fetch = realFetch;
    if (prevApiKey === undefined) delete process.env["BLS_API_KEY"];
    else process.env["BLS_API_KEY"] = prevApiKey;
    try {
      await deleteTestData();
    } catch (err) {
      console.error("[cleanup] BLS cache test cleanup failed:", err);
    }
    // NOTE: pool.end() is intentionally NOT called here. The
    // `pool` export is shared across tests in this file; ending it
    // mid-file kills the pool before the gating-guardrail test below
    // can issue its own queries. The final test in this file is
    // responsible for closing the pool.
  });

  await deleteTestData();

  // ---- 1) First run: no watermark → full fetch + parse for every chunk.
  await runCollector(BLS_ECONOMIC_INDEX_COLLECTOR_ID);
  const run1Posts = captured.length;
  assert.ok(run1Posts > 0, "run 1 should issue at least one BLS POST");
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
    run1Posts,
    "run 1 parses every chunk's JSON body",
  );

  // Snapshot the row count after run 1 so we can pin the exact
  // "run 2 inserted zero new rows" invariant below.
  const rowsAfterRun1 = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID));
  const rowCountAfterRun1 = rowsAfterRun1.length;

  // The cache_watermark audit row must record one entry per chunk we
  // POSTed, each carrying the upstream ETag + Last-Modified.
  const [watermarkRow1] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID),
        eq(collectorAuditLogTable.event, CACHE_WATERMARK_EVENT),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  assert.ok(watermarkRow1, "run 1 must write a cache_watermark audit row");
  const wmMeta1 = watermarkRow1!.metadata as Record<string, unknown>;
  const entries1 = wmMeta1["entries"] as Record<
    string,
    { etag: string; lastModified: string }
  >;
  assert.equal(
    Object.keys(entries1).length,
    run1Posts,
    "watermark map must record one entry per chunk POSTed",
  );
  // Verify the cache key shape: blsChunkCacheKey reproduces the key
  // for each chunk's seriesIds.
  const expectedYear = new Date().getUTCFullYear();
  for (const req of captured) {
    const expectedKey = blsChunkCacheKey(
      req.body.seriesid,
      Number(req.body.startyear),
      Number(req.body.endyear),
      "authenticated",
    );
    assert.equal(Number(req.body.endyear), expectedYear);
    const entry = entries1[expectedKey];
    assert.ok(
      entry,
      `watermark map must contain entry for chunk key ${expectedKey}`,
    );
    assert.equal(entry.etag, ETAG_V1);
    assert.equal(entry.lastModified, LAST_MODIFIED_V1);
  }

  // ---- 2) Second run with unchanged upstream: 304 for every chunk.
  captured = [];
  bodyParseCount = 0;
  await runCollector(BLS_ECONOMIC_INDEX_COLLECTOR_ID);
  assert.equal(
    captured.length,
    run1Posts,
    "run 2 still issues a POST per chunk so upstream can decide 200 vs 304",
  );
  for (const req of captured) {
    assert.equal(
      req.ifNoneMatch,
      ETAG_V1,
      "run 2 must send prior run's ETag as If-None-Match",
    );
    assert.equal(
      req.ifModifiedSince,
      LAST_MODIFIED_V1,
      "run 2 must send prior run's Last-Modified as If-Modified-Since",
    );
  }
  assert.equal(
    bodyParseCount,
    0,
    "run 2: every chunk returned 304 → JSON body must NEVER be parsed",
  );
  // Run 2 short-circuited every chunk; market_signals row count must
  // be byte-identical to run 1's snapshot. This is the headline
  // invariant for the cache-watermark short-circuit — a regression
  // that quietly inserts duplicates / no-op MERGE traffic on every
  // re-run would show up here even if `bodyParseCount` somehow stayed
  // at zero.
  const rowsAfterRun2 = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID));
  assert.equal(
    rowsAfterRun2.length,
    rowCountAfterRun1,
    "run 2 must NOT insert any new market_signals rows beyond what run 1 wrote",
  );
  const rowCountAfter2 = rowsAfterRun2.length;

  // ---- 3) Bump upstream → 200 with fresh payload. Run must parse the
  // new body, emit drafts, and write a fresh cache_watermark row with
  // the new ETag/Last-Modified.
  captured = [];
  bodyParseCount = 0;
  currentEtag = ETAG_V2;
  currentLastModified = LAST_MODIFIED_V2;
  await runCollector(BLS_ECONOMIC_INDEX_COLLECTOR_ID);
  assert.equal(
    captured.length,
    run1Posts,
    "run 3 still issues a POST per chunk",
  );
  for (const req of captured) {
    // Conditional headers still sent (still based on prior watermark)
    // but upstream now serves 200 because its ETag bumped.
    assert.equal(req.ifNoneMatch, ETAG_V1);
    assert.equal(req.ifModifiedSince, LAST_MODIFIED_V1);
  }
  assert.equal(
    bodyParseCount,
    run1Posts,
    "run 3: every chunk returned 200 → JSON body parsed once per chunk",
  );

  // The newest cache_watermark row records the bumped headers — proving
  // the watermark map advances when upstream actually changes.
  const [watermarkRow3] = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID),
        eq(collectorAuditLogTable.event, CACHE_WATERMARK_EVENT),
      ),
    )
    .orderBy(desc(collectorAuditLogTable.createdAt))
    .limit(1);
  assert.ok(watermarkRow3, "run 3 must write a fresh cache_watermark row");
  const entries3 = (watermarkRow3!.metadata as Record<string, unknown>)[
    "entries"
  ] as Record<string, { etag: string; lastModified: string }>;
  for (const req of captured) {
    const key = blsChunkCacheKey(
      req.body.seriesid,
      Number(req.body.startyear),
      Number(req.body.endyear),
      "authenticated",
    );
    assert.equal(entries3[key]!.etag, ETAG_V2);
    assert.equal(entries3[key]!.lastModified, LAST_MODIFIED_V2);
  }

  // Row count after run 3 is stable (filler payload uses the same
  // (year, period, value) so the natural-key dedupe collides), but the
  // headline assertion is that run 3 actually fetched and parsed.
  const rowsAfter3 = await db
    .select({ id: marketSignalsTable.id })
    .from(marketSignalsTable)
    .where(eq(marketSignalsTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID));
  assert.equal(
    rowsAfter3.length,
    rowCountAfter2,
    "run 3 inserts no new rows because the canned payload is identical",
  );
});

/**
 * Guardrail: prove the cache-watermark write is gated on the runtime's
 * successful insert. If a future refactor moved the
 * `writeCacheWatermarks(...)` call back inside `collect()` itself, a
 * downstream insert failure would leave the next run with an advanced
 * watermark — silently 304-skipping data we never persisted.
 *
 * We exercise the gating directly (without `runCollector`) by:
 *   1. Calling `collector.collect()` so it queues a pending commit.
 *   2. Taking the pending commit but NOT invoking it — exactly what the
 *      runtime does when `insertSignalsWithDedupe` throws between
 *      collect() returning and the post-insert step.
 *   3. Asserting NO `cache_watermark` audit row is written.
 *   4. Calling `collect()` a second time and asserting the body IS
 *      re-parsed — the prior run's watermark must not have advanced.
 */
test("blsEconomicIndexCollector gates watermark commit on runtime insert success", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const prevApiKey = process.env["BLS_API_KEY"];
  process.env["BLS_API_KEY"] = prevApiKey ?? "test-key";

  const realFetch = globalThis.fetch;
  let bodyParseCount = 0;
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
    if (url !== BLS_API_URL) return realFetch(input, init);
    const bodyText =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    const parsed = JSON.parse(bodyText) as { seriesid: string[] };
    const json = buildCannedBlsResponse(parsed.seriesid);
    const res = new Response(JSON.stringify(json), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: '"bls-failure-mode-v1"',
        "Last-Modified": "Wed, 15 Jan 2025 12:00:00 GMT",
      },
    });
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

  // We don't go through the runtime here, but the collector's
  // `onMissing` warnings still write to `collector_audit_log`. Make sure
  // the registration row exists so the FK doesn't blow up.
  registerCollector(blsEconomicIndexCollector);
  await upsertCollectorRegistration({
    id: BLS_ECONOMIC_INDEX_COLLECTOR_ID,
    name: blsEconomicIndexCollector.name,
    description: blsEconomicIndexCollector.description,
    posture: blsEconomicIndexCollector.posture,
    owner: "tests",
    sourceUrl: blsEconomicIndexCollector.sourceUrl,
    rateLimitRpm: blsEconomicIndexCollector.defaultRateLimitRpm ?? null,
    scheduleCron: blsEconomicIndexCollector.defaultScheduleCron,
    notes: null,
    actor: "tests",
  });

  async function deleteTestData(): Promise<void> {
    await db
      .delete(marketSignalsTable)
      .where(eq(marketSignalsTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID));
    await db
      .delete(collectorAuditLogTable)
      .where(
        eq(collectorAuditLogTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID),
      );
  }

  t.after(async () => {
    globalThis.fetch = realFetch;
    if (prevApiKey === undefined) delete process.env["BLS_API_KEY"];
    else process.env["BLS_API_KEY"] = prevApiKey;
    // Drain any leftover queued commit so it can't leak into a
    // subsequent test in the same node process.
    blsEconomicIndexCollector.takePendingPostInsertCommit?.();
    try {
      await deleteTestData();
    } catch (err) {
      console.error("[cleanup] BLS gating test cleanup failed:", err);
    }
    await pool.end().catch(() => {});
  });

  await deleteTestData();
  // Drain any pre-existing queued commit (e.g. from another test that
  // ran in this process) so we observe a clean baseline.
  blsEconomicIndexCollector.takePendingPostInsertCommit?.();

  // ---- 1) collect() once and capture the pending commit WITHOUT
  // invoking it. This simulates the runtime aborting between
  // collect() returning and the post-insert commit step.
  bodyParseCount = 0;
  const draftsA = await blsEconomicIndexCollector.collect({ since: null });
  assert.ok(draftsA.length > 0, "collect() should produce at least one draft");
  const parseCountA = bodyParseCount;
  assert.ok(parseCountA > 0, "collect() should parse at least one chunk body");

  const pendingCommit = blsEconomicIndexCollector.takePendingPostInsertCommit?.();
  assert.ok(
    pendingCommit,
    "collect() must queue a post-insert commit for the runtime to invoke",
  );
  // Intentionally do NOT call `pendingCommit()`.

  // No `cache_watermark` audit row may exist — the watermark is queued
  // in memory only; persistence is the runtime's job, gated on insert
  // success.
  const watermarkRowsA = await db
    .select()
    .from(collectorAuditLogTable)
    .where(
      and(
        eq(collectorAuditLogTable.collectorId, BLS_ECONOMIC_INDEX_COLLECTOR_ID),
        eq(collectorAuditLogTable.event, CACHE_WATERMARK_EVENT),
      ),
    );
  assert.equal(
    watermarkRowsA.length,
    0,
    "no cache_watermark row may be written when the post-insert commit is never invoked",
  );

  // ---- 2) collect() a second time. Because the prior run never
  // committed its watermark, the collector must NOT short-circuit on
  // 304 — it must re-issue a full fetch and re-parse the body. A
  // regression that wrote the watermark from inside collect() itself
  // would 304-skip here, silently masking durable data loss.
  bodyParseCount = 0;
  const draftsB = await blsEconomicIndexCollector.collect({ since: null });
  assert.ok(draftsB.length > 0, "second collect() should still produce drafts");
  assert.equal(
    bodyParseCount,
    parseCountA,
    "second collect() must re-parse every chunk body — the prior run never committed its watermark",
  );

  // Drain the second run's queued commit so it doesn't bleed into
  // other tests sharing this process.
  blsEconomicIndexCollector.takePendingPostInsertCommit?.();
});
