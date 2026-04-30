/**
 * Integration test for `POST /api/ingest/csv-stream` that pins the streaming
 * *progress reporting* contract.
 *
 * Why this exists
 * ---------------
 * `csv-stream-large.test.ts` parses the NDJSON response correctly and asserts
 * the terminal `{ type: "result" }` event, but it does NOT require any
 * `{ type: "progress" }` events to have been emitted. A regression that
 * silently stops emitting progress — e.g. `PROGRESS_EMIT_INTERVAL_MS` raised
 * to a huge value, the `lastEmit` gate inverted, the response body buffered
 * until the request ends, or `onProgress` accidentally dropped from the
 * route — would leave the UI's progress bar dark for the entire upload but
 * not fail any test, because the final `result` event would still arrive.
 *
 * What this verifies
 * ------------------
 * 1. POSTs a moderately large CSV (large enough that processing comfortably
 *    exceeds `PROGRESS_EMIT_INTERVAL_MS`, so the throttled emitter has time
 *    to fire on even fast machines).
 * 2. Reads the NDJSON response *incrementally* off `res.body` and timestamps
 *    each line as it arrives — necessary so a regression that buffers the
 *    entire body until the request ends is actually visible to the test.
 * 3. Asserts at least one `{ type: "progress" }` event arrives *before* the
 *    terminal `{ type: "result" }` event.
 * 4. Asserts the first progress event arrives meaningfully earlier on the
 *    wire than the result event (proves live streaming, not "all written
 *    correctly but flushed at the very end").
 * 5. Asserts each progress event carries non-decreasing `rowsParsed` /
 *    `rowsInserted` totals (cheap sanity check — a regression that emits
 *    stale or zero counts is caught here too).
 * 6. Cleans up the inserted rows afterward.
 *
 * Sized deliberately smaller than the 10 MB memory-regression test to keep
 * this test fast; it only needs enough rows to cross several `BATCH_SIZE`
 * (1000-row) flush boundaries and exceed the 250 ms throttle window.
 *
 * Prereqs
 * -------
 * - `DATABASE_URL` is set and the schema has been pushed (see `lib/db`).
 * - At least one row exists in `orgs` (the test will use the first one).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Opt into the dev-only `x-org-id` header path before importing the app
// (the auth middleware reads NODE_ENV at module import time).
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable, suppliersTable, pool } from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import app from "../src/app";

const TEST_RUN_ID = `csvstreamprogress-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;
/**
 * 20k rows ≈ 2 MB. Comfortably more than `BATCH_SIZE` (1000) so multiple
 * batch flushes occur, and large enough that the cumulative DB insert time
 * exceeds the route's 250 ms `PROGRESS_EMIT_INTERVAL_MS` throttle window
 * even on fast hardware. Picked well below the 10 MB memory test so this
 * test stays fast.
 */
const ROW_COUNT = 20_000;
/**
 * Soft upper bound on the `first-progress → result` gap for a 20k-row
 * suppliers upload. This is the wall-clock time between the first batch
 * flush (after BATCH_SIZE=1000) and the terminal `result` event — i.e.
 * roughly the cost of ~19 remaining batch flushes on the suppliers
 * `flushBatch` branch (no FK lookup, single bulk upsert per batch).
 *
 * Sized at roughly 4–6× the observed p95 on local + CI hardware so
 * transient noise (cold DB, contended runner, GC pause) does not flake,
 * while a 5–10× throughput regression — the kind that turns a 30-second
 * upload into a 5-minute one — does fail loudly here instead of in a
 * customer's browser. See the matching ceiling map in
 * `csv-stream-progress-entities.test.ts` and the documented per-entity
 * p95 table in `routes/ingest.ts`.
 *
 * 8000 ms covers ~19 batch flushes ≈ 420 ms each, which is generous
 * relative to the ~1500 ms total gap typically observed for suppliers.
 */
const MAX_PROGRESS_TO_RESULT_GAP_MS = 8_000;
const HEADER =
  "externalId,name,countryCode,paymentTermsDays,isStrategic,isPreferred\n";
const COUNTRY_POOL = ["US", "DE", "FR", "JP", "BR", "IN", "GB", "CA"];

function writeCsvSync(filePath: string, rows: number): void {
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, HEADER);
    const pad = "x".repeat(48);
    for (let i = 0; i < rows; i++) {
      const ext = `${EXTERNAL_ID_PREFIX}${i}`;
      const name = `Progress Test Supplier ${i} ${pad}`;
      const country = COUNTRY_POOL[i % COUNTRY_POOL.length];
      const terms = String(15 + (i % 60));
      const strategic = i % 7 === 0 ? "true" : "false";
      const preferred = i % 11 === 0 ? "true" : "false";
      fs.writeSync(
        fd,
        `${ext},"${name}",${country},${terms},${strategic},${preferred}\n`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function startServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
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

async function openAsBlob(filePath: string, type: string): Promise<Blob> {
  const fsmod = await import("node:fs");
  const fn = (
    fsmod as unknown as {
      openAsBlob?: (p: string, opts?: { type?: string }) => Promise<Blob>;
    }
  ).openAsBlob;
  if (typeof fn !== "function") {
    throw new Error(
      "node:fs.openAsBlob is not available; node >= 20 is required.",
    );
  }
  return fn(filePath, { type });
}

test("streaming CSV ingest emits progress events before the terminal result", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `csv-stream-progress-${process.pid}-${Date.now()}.csv`,
  );

  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  t.after(async () => {
    try {
      const removed = await deleteTestRows();
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
    await pool.end().catch(() => {});
  });

  writeCsvSync(tmpFile, ROW_COUNT);
  const stat = fs.statSync(tmpFile);
  console.log(
    `[setup] generated CSV: ${(stat.size / 1024 / 1024).toFixed(2)} MB, ${ROW_COUNT} rows`,
  );

  server = await startServer();
  const orgId = await pickOrgId();

  // Defensive cleanup of any stragglers from a previous identically-prefixed
  // run (the prefix is timestamped so this is normally a no-op).
  await deleteTestRows();

  const fileBlob = await openAsBlob(tmpFile, "text/csv");
  const form = new FormData();
  form.append("file", fileBlob, "suppliers.csv");

  type ProgressEvent = {
    type: "progress";
    rowsParsed: number;
    rowsInserted: number;
    bytesProcessed?: number;
  };
  type ResultEvent = {
    type: "result";
    entity: string;
    rowsParsed: number;
    rowsInserted: number;
    durationMs: number;
  };
  type ErrorEvent = { type: "error"; error: string };
  type StreamEvent = ProgressEvent | ResultEvent | ErrorEvent;

  const url = `${server.baseUrl}/api/ingest/csv-stream?entity=suppliers`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-org-id": orgId },
    body: form,
  });

  assert.equal(res.status, 200, `unexpected status ${res.status}`);
  assert.ok(res.body, "response did not include a streamable body");

  // Read the response incrementally and timestamp every line as it arrives.
  // Doing this — rather than `await res.text()` — is what lets the test
  // catch a regression where progress lines are written to the response
  // socket but only *flushed* when the request ends (e.g. someone removes
  // `res.flushHeaders()` / `X-Accel-Buffering: no` and a buffering layer
  // coalesces the entire NDJSON body into one final chunk). In that
  // scenario the textual content still parses fine and the count check
  // would pass, but `firstProgressLineMs` would land on top of (or after)
  // `firstResultLineMs`, which the assertion below rejects.
  const events: StreamEvent[] = [];
  let firstProgressLineMs: number | null = null;
  let firstResultLineMs: number | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "";

  const consumeLine = (line: string, lineNo: number): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch (err) {
      throw new Error(
        `Failed to parse NDJSON line #${lineNo}: ${(err as Error).message}\n` +
          `Line content: ${trimmed}`,
      );
    }
    const arrivedAt = Date.now();
    if (event.type === "progress" && firstProgressLineMs === null) {
      firstProgressLineMs = arrivedAt;
    }
    if (event.type === "result" && firstResultLineMs === null) {
      firstResultLineMs = arrivedAt;
    }
    events.push(event);
  };

  let lineCounter = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        lineCounter++;
        consumeLine(line, lineCounter);
      }
    }
    if (done) break;
  }
  // Flush any trailing partial line (the route always terminates lines
  // with `\n`, but be defensive).
  pending += decoder.decode();
  if (pending.length > 0) {
    lineCounter++;
    consumeLine(pending, lineCounter);
  }

  const errorEvent = events.find((e): e is ErrorEvent => e.type === "error");
  assert.ok(
    !errorEvent,
    `streaming endpoint emitted error event: ${errorEvent?.error ?? ""}`,
  );

  const progressEvents = events.filter(
    (e): e is ProgressEvent => e.type === "progress",
  );

  // Core regression guard: at least one progress event must have arrived.
  assert.ok(
    progressEvents.length >= 1,
    `expected at least one { type: "progress" } event from /api/ingest/csv-stream ` +
      `for a ${(stat.size / 1024 / 1024).toFixed(2)} MB / ${ROW_COUNT}-row upload, ` +
      `but got 0. Total events received: ${events.length} ` +
      `(${events.map((e) => e.type).join(", ")}). ` +
      `This usually means progress emission is broken (interval misconfigured, ` +
      `throttle gate inverted, response buffered until end, or onProgress no ` +
      `longer wired into the route).`,
  );

  // Position guard: every progress event must precede the terminal result
  // event. Catches a regression where progress is accidentally emitted after
  // the result (which would also break the client-side NDJSON parser since
  // the UI stops reading at `result`).
  const resultIdx = events.findIndex((e) => e.type === "result");
  assert.ok(
    resultIdx >= 0,
    `streaming endpoint did not emit a 'result' event. ` +
      `Got ${events.length} events: ${events.map((e) => e.type).join(", ")}`,
  );
  for (let i = resultIdx + 1; i < events.length; i++) {
    assert.notEqual(
      events[i]?.type,
      "progress",
      `progress event must not appear after the terminal 'result' event ` +
        `(found at index ${i})`,
    );
  }

  // Live-streaming guard: the first progress event must be observed by the
  // client meaningfully before the terminal `result` event arrives. If a
  // proxy / Node write buffer / future code change coalesces all NDJSON
  // lines into one final flush, both timestamps would be effectively
  // identical (within a millisecond or two) — even though the count and
  // ordering checks above would still pass. Requiring a non-trivial gap
  // proves the response is actually streaming as it claims to.
  assert.ok(
    firstProgressLineMs !== null,
    "did not observe a progress line on the response stream",
  );
  assert.ok(
    firstResultLineMs !== null,
    "did not observe a result line on the response stream",
  );
  const progressToResultGapMs =
    (firstResultLineMs as number) - (firstProgressLineMs as number);
  // 50 ms is well below the route's 250 ms throttle interval (so the gap
  // will be much larger than this in practice — typically seconds for a
  // 20k-row upload) but well above the few-ms-or-less window we'd see if
  // the body were buffered to a single flush. This makes the check robust
  // on shared CI runners while still catching the regression.
  assert.ok(
    progressToResultGapMs >= 50,
    `expected the first progress event to arrive at least 50 ms before the ` +
      `result event (proves the response is actually streaming, not buffered ` +
      `until end), but the gap was only ${progressToResultGapMs} ms.`,
  );

  // Soft upper bound — catches a 5–10× throughput regression on the
  // suppliers `flushBatch` branch before customers do. See the comment on
  // MAX_PROGRESS_TO_RESULT_GAP_MS for sizing rationale.
  assert.ok(
    progressToResultGapMs <= MAX_PROGRESS_TO_RESULT_GAP_MS,
    `first-progress→result gap of ${progressToResultGapMs} ms exceeded the ` +
      `soft ceiling of ${MAX_PROGRESS_TO_RESULT_GAP_MS} ms for a ${ROW_COUNT}-row ` +
      `suppliers upload (~19 post-first-batch flushes). This usually means ` +
      `the suppliers flushBatch branch regressed: e.g. a per-row round-trip ` +
      `introduced inside the batch, BATCH_SIZE shrunk, or the upsert lost ` +
      `its index. Compare against the p95 table in ` +
      `artifacts/api-server/src/routes/ingest.ts and update both numbers ` +
      `together if this is a legitimate baseline shift.`,
  );

  // Sanity check: progress totals should be monotonically non-decreasing
  // and never exceed the file's row count. Catches "stale snapshot" or
  // "zeros only" regressions in the progress payload.
  let prevParsed = 0;
  let prevInserted = 0;
  let prevBytes = 0;
  for (const [i, ev] of progressEvents.entries()) {
    assert.ok(
      ev.rowsParsed >= prevParsed,
      `progress event #${i} rowsParsed went backward: ${prevParsed} -> ${ev.rowsParsed}`,
    );
    assert.ok(
      ev.rowsInserted >= prevInserted,
      `progress event #${i} rowsInserted went backward: ${prevInserted} -> ${ev.rowsInserted}`,
    );
    assert.ok(
      ev.rowsParsed <= ROW_COUNT,
      `progress event #${i} rowsParsed=${ev.rowsParsed} exceeds file row count ${ROW_COUNT}`,
    );
    if (ev.bytesProcessed !== undefined) {
      assert.ok(
        ev.bytesProcessed >= prevBytes,
        `progress event #${i} bytesProcessed went backward: ${prevBytes} -> ${ev.bytesProcessed}`,
      );
      assert.ok(
        ev.bytesProcessed <= stat.size,
        `progress event #${i} bytesProcessed=${ev.bytesProcessed} exceeds file size ${stat.size}`,
      );
      prevBytes = ev.bytesProcessed;
    }
    prevParsed = ev.rowsParsed;
    prevInserted = ev.rowsInserted;
  }

  // Lock down the bytesProcessed contract: at least one progress event
  // must carry a positive `bytesProcessed` value. The Data Ingest page's
  // server-side progress bar / ETA derives its percentage and rate from
  // this field — a regression that drops it would leave the bar dark and
  // hide the ETA for every long upload, but every other check above
  // would still pass.
  const eventsWithBytes = progressEvents.filter(
    (e) => typeof e.bytesProcessed === "number" && e.bytesProcessed > 0,
  );
  assert.ok(
    eventsWithBytes.length >= 1,
    `expected at least one progress event with a positive bytesProcessed value ` +
      `(used by the UI to render the server-side progress bar and ETA), but got ` +
      `${eventsWithBytes.length} of ${progressEvents.length} progress events ` +
      `with bytesProcessed set.`,
  );

  // Lightweight throughput metric the team can grep CI logs for over time
  // to spot trend drift well before it crosses the hard ceiling above.
  const POST_FIRST_BATCH_ROWS = Math.max(ROW_COUNT - 1000, 1);
  const rowsPerSec = Math.round(
    (POST_FIRST_BATCH_ROWS * 1000) / Math.max(progressToResultGapMs, 1),
  );
  console.log(
    `[progress] received ${progressEvents.length} progress event(s); ` +
      `final parsed=${prevParsed}, inserted=${prevInserted}; ` +
      `first-progress→result gap=${progressToResultGapMs} ms ` +
      `(ceiling ${MAX_PROGRESS_TO_RESULT_GAP_MS} ms, ` +
      `~${rowsPerSec} rows/sec post-first-batch)`,
  );
});
