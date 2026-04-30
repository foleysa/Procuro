/**
 * Integration test for `POST /api/ingest/csv-stream` with a large CSV.
 *
 * What this verifies
 * ------------------
 * 1. Generates a >10 MB suppliers CSV directly to disk (never buffered as a
 *    single string in JS).
 * 2. Boots the real Express app in-process and binds to an ephemeral port,
 *    then POSTs the file as `multipart/form-data` so the server hits the
 *    same code path the browser/cURL clients use.
 * 3. Confirms the streaming endpoint reports `rowsParsed === rowsInserted`
 *    and that count matches the number of rows in the generated file.
 * 4. Confirms the rows actually landed in the real Postgres database (i.e.
 *    DATABASE_URL — no mocks) by counting `suppliers` filtered to a unique
 *    `source_external_id` prefix that this test owns.
 * 5. Cleans up the inserted rows afterward.
 *
 * Memory expectation
 * ------------------
 * `streamCsvEntity` is required to keep working memory bounded — there
 * must be no full-file buffer on the server.
 *
 * What this test asserts (deterministic, hard-fails on regression):
 *
 *   - After the upload completes and a forced V8 GC runs, the *retained*
 *     `heapUsed` delta must stay below `MAX_RETAINED_HEAP_DELTA_BYTES`
 *     (5 MB). The streaming path measured today retains ~0.1 MB; a
 *     regression that holds the file (or its parsed rows) past the
 *     response would push retained heap to >= the file size (10 MB+)
 *     and trip this check immediately. `heapUsed` (not RSS) is used
 *     deliberately: V8 returns RSS pages to the OS lazily, so RSS
 *     overstates true memory usage on shared runners. `--expose-gc`
 *     (enabled via the `test` npm script's `NODE_OPTIONS`) makes the
 *     retained-heap reading deterministic.
 *
 * What this test only logs (intentionally not asserted):
 *
 *   - Peak `heapUsed` and RSS during the upload. Per-batch query
 *     construction in drizzle/pg-pool routinely allocates ~70 MB of
 *     transient strings for a 10 MB upload, which dwarfs any 10 MB
 *     full-file buffer. Asserting on peak with a 10 MB file would either
 *     be too tight (flaky) or too loose (would not catch a 10 MB buffer
 *     regression hidden in 70 MB of noise). Peak is logged for human
 *     inspection so reviewers can spot pathological growth, but it is
 *     not part of the pass/fail decision.
 *
 * Prereqs
 * -------
 * - `DATABASE_URL` is set and the schema has been pushed (see `lib/db`).
 * - At least one row exists in `orgs` (the test will use the first one).
 * - This test does NOT require the `pnpm dev` server to be running; it
 *   boots a fresh in-process instance of the same Express app.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Opt into the dev-only `x-org-id` header path before importing the app
// (the auth middleware reads NODE_ENV at module import time). The same gate
// is what `pnpm dev` uses, so this exercises the same code path the running
// server does, just bound to an ephemeral port for the test.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable, suppliersTable, pool } from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import app from "../src/app";

const TEST_RUN_ID = `csvstreamtest-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;
const TARGET_BYTES = 10 * 1024 * 1024; // 10 MB minimum
const HEADER = "externalId,name,countryCode,paymentTermsDays,isStrategic,isPreferred\n";
const COUNTRY_POOL = ["US", "DE", "FR", "JP", "BR", "IN", "GB", "CA"];

/**
 * Retained-heap ceiling enforced by this test (see file header). 5 MB is
 * far below the file size (10 MB+) so any regression that retains the
 * uploaded file or its parsed rows past the response is caught
 * immediately, but well above the ~0.1 MB observed today so normal
 * background allocations do not flake the test.
 */
const MAX_RETAINED_HEAP_DELTA_BYTES = 5 * 1024 * 1024;

/** Generate the CSV file row-by-row to disk; never buffer the whole thing. */
function writeLargeCsvSync(filePath: string, minBytes: number): number {
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, HEADER);
    let bytes = HEADER.length;
    let rows = 0;
    // Pre-build a pad string so each row crosses a useful byte width without
    // making the CSV unrealistic-looking.
    const pad = "x".repeat(64);
    while (bytes < minBytes) {
      const ext = `${EXTERNAL_ID_PREFIX}${rows}`;
      const name = `Bulk Test Supplier ${rows} ${pad}`;
      const country = COUNTRY_POOL[rows % COUNTRY_POOL.length];
      const terms = String(15 + (rows % 60));
      const strategic = rows % 7 === 0 ? "true" : "false";
      const preferred = rows % 11 === 0 ? "true" : "false";
      const line = `${ext},"${name}",${country},${terms},${strategic},${preferred}\n`;
      fs.writeSync(fd, line);
      bytes += line.length;
      rows++;
    }
    return rows;
  } finally {
    fs.closeSync(fd);
  }
}

/** Boot the express app on an ephemeral port; returns base URL + close fn. */
async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind server");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/** Pick the first org id; the streaming endpoint requires a valid tenant. */
async function pickOrgId(): Promise<string> {
  const [row] = await db.select({ id: orgsTable.id }).from(orgsTable).limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database (pnpm --filter @workspace/scripts run seed) before running this test.",
    );
  }
  return row.id;
}

async function deleteTestRows(): Promise<number> {
  const deleted = await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, "csv"),
        like(suppliersTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    )
    .returning({ id: suppliersTable.id });
  return deleted.length;
}

/** Force a full V8 GC if `--expose-gc` is enabled; required for the
 *  retained-heap assertion below to be deterministic. */
function forceGc(): void {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc !== "function") {
    throw new Error(
      "global.gc() is unavailable. Run via `pnpm --filter @workspace/api-server test` " +
        "(the npm script enables --expose-gc) or pass --expose-gc to node directly.",
    );
  }
  // Two passes: first pass collects most cycles, second sweeps any
  // finalizers exposed by the first pass.
  gc();
  gc();
}

test("streaming CSV ingest of a >10 MB file lands every row in Postgres", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `csv-stream-large-${process.pid}-${Date.now()}.csv`,
  );

  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  t.after(async () => {
    try {
      const removed = await deleteTestRows();
      // Best-effort log; do not fail the test on cleanup count.
      console.log(`[cleanup] deleted ${removed} test supplier rows`);
    } catch (err) {
      console.error("[cleanup] failed to delete test rows:", err);
    }
    if (server) await server.close();
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
    // Drain pg pool so node:test exits cleanly.
    await pool.end().catch(() => {});
  });

  // 1. Generate the file.
  const expectedRows = writeLargeCsvSync(tmpFile, TARGET_BYTES);
  const stat = fs.statSync(tmpFile);
  assert.ok(
    stat.size >= TARGET_BYTES,
    `Generated CSV should be >= ${TARGET_BYTES} bytes, got ${stat.size}`,
  );
  console.log(
    `[setup] generated CSV: ${(stat.size / 1024 / 1024).toFixed(2)} MB, ${expectedRows} rows`,
  );

  // 2. Boot the app and pick an org.
  server = await startServer();
  const orgId = await pickOrgId();

  // Ensure prior runs from this exact test file are cleaned (paranoia for the
  // unique-id check below; the prefix is timestamped so this is normally a
  // no-op).
  await deleteTestRows();

  // 3. Establish a clean memory baseline immediately before the upload.
  forceGc();
  const heapBaseline = process.memoryUsage().heapUsed;
  const rssBaseline = process.memoryUsage().rss;

  // Sample peak `heapUsed` during the upload. A 50 ms cadence catches even
  // brief allocation spikes for a request that takes seconds to complete.
  let peakHeap = heapBaseline;
  const sampler = setInterval(() => {
    const current = process.memoryUsage().heapUsed;
    if (current > peakHeap) peakHeap = current;
  }, 50);
  // Don't keep the event loop alive on the sampler alone.
  sampler.unref();

  // 4. Upload as multipart/form-data, streaming the file from disk.
  const fileBlob = await openAsBlob(tmpFile, "text/csv");
  const form = new FormData();
  form.append("file", fileBlob, "suppliers.csv");

  const url = `${server.baseUrl}/api/ingest/csv-stream?entity=suppliers`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "x-org-id": orgId },
      body: form,
    });
  } finally {
    clearInterval(sampler);
  }

  // Read the response once. We deliberately read the body before asserting
  // status so we have the error text available in either branch (calling
  // res.text() and res.json() would consume the body twice).
  const rawBody = await res.text();

  // Capture retained heap once the request has fully resolved and a forced
  // GC has run. This is what the server is *holding onto* after the upload.
  forceGc();
  const heapAfter = process.memoryUsage().heapUsed;
  const rssAfter = process.memoryUsage().rss;

  const peakDelta = peakHeap - heapBaseline;
  const retainedDelta = heapAfter - heapBaseline;
  const rssDelta = rssAfter - rssBaseline;
  console.log(
    `[memory] heap baseline=${(heapBaseline / 1024 / 1024).toFixed(1)} MB ` +
      `peak=${(peakHeap / 1024 / 1024).toFixed(1)} MB ` +
      `after-gc=${(heapAfter / 1024 / 1024).toFixed(1)} MB ` +
      `peakΔ=${(peakDelta / 1024 / 1024).toFixed(1)} MB ` +
      `retainedΔ=${(retainedDelta / 1024 / 1024).toFixed(1)} MB ` +
      `(file size=${(stat.size / 1024 / 1024).toFixed(1)} MB; ` +
      `rssΔ=${(rssDelta / 1024 / 1024).toFixed(1)} MB for context)`,
  );

  assert.equal(res.status, 200, `unexpected status ${res.status}: ${rawBody}`);

  // The route streams NDJSON: one JSON object per line. The body is a mix of
  // `{ type: "progress", ... }` events emitted while the upload is in flight,
  // optionally a terminal `{ type: "error", ... }` event, and (on success) a
  // final `{ type: "result", entity, rowsParsed, rowsInserted, durationMs }`.
  // Split on newlines, parse each non-empty line, and pick the final result.
  type ProgressEvent = { type: "progress"; rowsParsed: number; rowsInserted: number };
  type ResultEvent = {
    type: "result";
    entity: string;
    rowsParsed: number;
    rowsInserted: number;
    durationMs: number;
  };
  type ErrorEvent = { type: "error"; error: string };
  type StreamEvent = ProgressEvent | ResultEvent | ErrorEvent;

  const events: StreamEvent[] = rawBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, idx) => {
      try {
        return JSON.parse(line) as StreamEvent;
      } catch (err) {
        throw new Error(
          `Failed to parse NDJSON line #${idx + 1}: ${(err as Error).message}\n` +
            `Line content: ${line}`,
        );
      }
    });

  const errorEvent = events.find((e): e is ErrorEvent => e.type === "error");
  assert.ok(
    !errorEvent,
    `streaming endpoint emitted error event: ${errorEvent?.error ?? ""}`,
  );

  // The route's contract is that `result` is the *terminal* event of a
  // successful stream. Assert exactly that — using `findLast` (and then
  // verifying it is the last parsed event) catches both "no result emitted"
  // regressions and "extra events after result" regressions.
  const resultEvent = events.findLast(
    (e): e is ResultEvent => e.type === "result",
  );
  assert.ok(
    resultEvent,
    `streaming endpoint did not emit a 'result' event. ` +
      `Got ${events.length} events: ${events.map((e) => e.type).join(", ")}`,
  );
  assert.equal(
    events[events.length - 1]?.type,
    "result",
    `'result' event must be the terminal NDJSON line; got trailing event ` +
      `'${events[events.length - 1]?.type}' instead.`,
  );
  const body = resultEvent;

  // 5. Server-reported counts match the file.
  assert.equal(body.entity, "suppliers");
  assert.equal(
    body.rowsParsed,
    expectedRows,
    `parser saw ${body.rowsParsed} rows, expected ${expectedRows}`,
  );
  assert.equal(
    body.rowsInserted,
    expectedRows,
    `db reported ${body.rowsInserted} inserted rows, expected ${expectedRows}`,
  );

  // 6. Real DB shows the same count (filtered to this test run only).
  // Allow a brief moment for any pending pool writes (defensive — the insert
  // above is awaited and committed already, but settling reduces flake on
  // shared CI runners).
  await sleep(50);
  const dbRows = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, "csv"),
        like(suppliersTable.sourceExternalId, `${EXTERNAL_ID_PREFIX}%`),
      ),
    );
  assert.equal(
    dbRows.length,
    expectedRows,
    `DB row count mismatch: got ${dbRows.length}, expected ${expectedRows}`,
  );

  // 7. Memory regression guard (see file header for full rationale).
  //    After a forced GC, retained `heapUsed` must stay well under the file
  //    size. A regression that holds the file or its parsed rows past the
  //    response would push retained heap to >= the file size and trip this
  //    ceiling. Peak heap (above) is logged but not asserted because per-
  //    batch query construction in drizzle/pg dominates the signal.
  assert.ok(
    retainedDelta <= MAX_RETAINED_HEAP_DELTA_BYTES,
    `V8 heap grew by ${retainedDelta} bytes after the request completed and ` +
      `GC ran (ceiling ${MAX_RETAINED_HEAP_DELTA_BYTES}). The server appears ` +
      `to be retaining file-sized data after the response.`,
  );
});

// Node 20+ ships `openAsBlob` on `node:fs`. Wrap it so the test reads the
// file lazily via an underlying file descriptor instead of buffering its
// entire contents into memory before the upload starts.
async function openAsBlob(filePath: string, type: string): Promise<Blob> {
  const fsmod = await import("node:fs");
  const fn = (fsmod as unknown as {
    openAsBlob?: (p: string, opts?: { type?: string }) => Promise<Blob>;
  }).openAsBlob;
  if (typeof fn !== "function") {
    throw new Error(
      "node:fs.openAsBlob is not available; node >= 20 is required.",
    );
  }
  return fn(filePath, { type });
}
