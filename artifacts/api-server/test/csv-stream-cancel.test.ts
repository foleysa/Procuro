/**
 * Integration test for cancelling an in-flight `POST /api/ingest/csv-stream`
 * upload (Task #22 follow-up — see also `routes/ingest.ts` and the Cancel
 * button on the Data Ingest page).
 *
 * Why this exists
 * ---------------
 * Task #22 wired an `AbortController` from the route handler into the
 * streaming adapter so that a client-side `xhr.abort()` actually short-
 * circuits inserts mid-file instead of letting the server keep writing
 * to a dead socket. The end-to-end UX was verified manually but no
 * committed test pinned the server-side abort behaviour. A regression
 * that quietly stopped propagating the abort signal — e.g. dropping the
 * `req.on("aborted")` wiring, dropping the `signal:` arg into
 * `streamCsvEntity`, swallowing `CsvIngestAbortedError` in the catch, or
 * forgetting to emit the `cancelled` NDJSON event — would let the
 * server keep flushing batches after the client gave up, and nothing
 * would fail in CI.
 *
 * What this verifies
 * ------------------
 * 1. **Adapter rejects with the dedicated error type and partial counts.**
 *    `streamCsvEntity` is driven directly via a `PassThrough` input and a
 *    manual `AbortController`. The abort fires after the first batch of
 *    1000 rows has flushed but before the second; the test asserts the
 *    returned promise rejects with a `CsvIngestAbortedError` carrying
 *    `rowsParsed > 0` and `rowsInserted > 0` (the live counters at the
 *    moment of cancellation).
 *
 * 2. **Route emits a `{ type: "cancelled", entity, rowsParsed,
 *    rowsInserted }` NDJSON event.** A second sub-test boots the real
 *    Express app, POSTs a chunked `text/csv` body, lets the first batch
 *    flush, and aborts the client request. Because a realistic abort
 *    tears down the response socket before the route's catch block runs,
 *    the `cancelled` event never reaches the wire on its own — so the
 *    test installs a `res.write` spy at the `http.Server` layer to
 *    capture every write attempt the route makes (including ones that
 *    fail to flush).
 *
 * 3. **No further DB inserts land after the abort.** Both sub-tests
 *    snapshot the row count under their unique `source_external_id`
 *    prefix immediately after the abort, dwell for two seconds, and
 *    snapshot again. Any growth means a batch flush leaked past the
 *    abort.
 *
 * Sized small (1k–1.5k rows total) so it runs in a few seconds even on a
 * cold runner — the goal is to lock down the abort *contract*, not to
 * stress-test throughput.
 *
 * Prereqs
 * -------
 * - `DATABASE_URL` is set and the schema has been pushed (see `lib/db`).
 * - At least one row exists in `orgs` (the test will use the first one).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

// Opt into the dev-only `x-org-id` header path before importing the app
// (the auth middleware reads NODE_ENV at module import time). The dev
// header path also grants platform_admin in `resolveRbacContext`, which
// satisfies the route's `requirePermission("ingest:write")` gate.
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "development";
process.env["ALLOW_DEV_TENANT_HEADER"] = "true";

import { db, orgsTable, suppliersTable, pool } from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import app from "../src/app";
import {
  streamCsvEntity,
  CsvIngestAbortedError,
} from "../src/lib/adapters/csv-adapter";

const TEST_RUN_ID = `csvstreamcancel-${Date.now()}-${process.pid}`;
const EXTERNAL_ID_PREFIX = `${TEST_RUN_ID}-`;
const HEADER =
  "externalId,name,countryCode,paymentTermsDays,isStrategic,isPreferred\n";
/**
 * Matches `BATCH_SIZE` in `csv-adapter.ts`. The first flush fires when
 * exactly this many rows have been parsed; the test stages its rows
 * around this boundary so it can deterministically observe one full
 * batch landing in the DB and zero subsequent batches landing after the
 * abort.
 */
const BATCH_SIZE = 1000;
/**
 * Number of rows we push in stage 1. Note that csv-parse holds the most
 * recently seen row in its internal buffer pending either the next
 * character or end-of-stream as confirmation that the line is complete;
 * writing exactly `BATCH_SIZE` lines therefore only causes the parser
 * to emit `BATCH_SIZE - 1` rows, and the adapter's flush threshold is
 * never reached. We add a single trailing row past the boundary so the
 * parser commits row #`BATCH_SIZE` and the adapter flushes a full
 * batch, leaving one row pending in the next batch.
 */
const STAGE_ONE_ROW_COUNT = BATCH_SIZE + 1;
/**
 * Number of rows queued *after* the first batch has flushed. Kept
 * deliberately below `BATCH_SIZE` so the parser can fill its internal
 * buffer with these rows but never reach the threshold that would
 * trigger a second `flushBatch` round-trip — guaranteeing the abort
 * fires while the second batch is still in-progress (the regression
 * scenario this test exists to catch).
 */
const STAGE_TWO_ROW_COUNT = 500;
/**
 * Total rows we ever push through the parser across both stages. Used
 * as the upper bound when asserting that the abort genuinely
 * short-circuited the upload (i.e. far fewer than this many rows landed
 * in the DB).
 */
const TOTAL_ROWS_PUSHED = STAGE_ONE_ROW_COUNT + STAGE_TWO_ROW_COUNT;
/**
 * Timeout for "the first batch flushed to the DB". Polled at 50 ms, so
 * the actual wait is bounded by the real flush latency — typically
 * <500 ms. The 30 s cap absorbs cold-start variance on shared CI.
 */
const FIRST_FLUSH_TIMEOUT_MS = 30_000;
/**
 * Dwell between the two post-abort row-count snapshots. Long enough that
 * any in-flight batch flush would have completed (a single 1000-row
 * suppliers upsert is ~100 ms even on cold DB), short enough that the
 * test isn't sluggish. If the second snapshot is greater than the first,
 * the abort failed to short-circuit a batch.
 */
const POST_ABORT_DWELL_MS = 2_000;

function buildRow(prefix: string, i: number): string {
  const name = `Cancel Test Supplier ${i}`.padEnd(80, "x");
  return `${prefix}${i},"${name}",US,30,false,false\n`;
}

async function pickOrgId(): Promise<string> {
  const [row] = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .limit(1);
  if (!row) {
    throw new Error(
      "No org rows found. Seed the database (pnpm --filter @workspace/scripts run seed) before running this test.",
    );
  }
  return row.id;
}

async function countRowsWithPrefix(prefix: string): Promise<number> {
  const rows = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, "csv"),
        like(suppliersTable.sourceExternalId, `${prefix}%`),
      ),
    );
  return rows.length;
}

async function deleteRowsWithPrefix(prefix: string): Promise<number> {
  const deleted = await db
    .delete(suppliersTable)
    .where(
      and(
        eq(suppliersTable.sourceSystem, "csv"),
        like(suppliersTable.sourceExternalId, `${prefix}%`),
      ),
    )
    .returning({ id: suppliersTable.id });
  return deleted.length;
}

/**
 * Poll the DB until at least `target` test-prefixed rows are present,
 * or `timeoutMs` elapses. Returns the final observed count.
 */
async function waitForRowCount(
  prefix: string,
  target: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await countRowsWithPrefix(prefix);
    if (count >= target) return count;
    await sleep(50);
  }
  return count;
}

test("CSV stream cancellation contract", async (t) => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required to run this integration test.");
  }

  const orgId = await pickOrgId();

  // Final cleanup runs once after every sub-test so a single `pool.end()`
  // is reached even if an individual sub-test fails. Without this, a
  // failure in sub-test #1 would leak the pg pool and hang Node at exit.
  t.after(async () => {
    try {
      const removed = await deleteRowsWithPrefix(EXTERNAL_ID_PREFIX);
      console.log(
        `[cleanup] deleted ${removed} test supplier rows (catch-all)`,
      );
    } catch (err) {
      console.error("[cleanup] failed to delete test rows:", err);
    }
    await pool.end().catch(() => {});
  });

  // -----------------------------------------------------------------
  // Sub-test 1: drive `streamCsvEntity` directly so we can observe the
  // rejected `CsvIngestAbortedError` instance and its partial counters.
  // -----------------------------------------------------------------
  await t.test(
    "streamCsvEntity rejects with CsvIngestAbortedError carrying partial counts when AbortSignal fires mid-stream",
    async () => {
      const PREFIX = `${EXTERNAL_ID_PREFIX}direct-`;
      // Defensive cleanup of any stragglers from a previous identically-
      // prefixed run (the prefix is timestamped so this is normally a
      // no-op).
      await deleteRowsWithPrefix(PREFIX);

      const input = new PassThrough();
      const controller = new AbortController();

      const ingestPromise = streamCsvEntity({
        orgId,
        entity: "suppliers",
        input,
        signal: controller.signal,
      });

      // Stage 1: header + one full batch (plus a trailing row so the
      // parser commits row #BATCH_SIZE — see STAGE_ONE_ROW_COUNT).
      // The adapter will pause its input, flush a 1000-row upsert to
      // the DB, then resume and wait for more rows.
      input.write(HEADER);
      for (let i = 0; i < STAGE_ONE_ROW_COUNT; i++) {
        input.write(buildRow(PREFIX, i));
      }

      // Wait for the first batch to actually land in the DB before
      // continuing — this anchors our timing on the real flush lifecycle
      // rather than internal callback ordering, so the test isn't
      // sensitive to micro-task scheduling differences across nodes.
      const countAfterFirstFlush = await waitForRowCount(
        PREFIX,
        BATCH_SIZE,
        FIRST_FLUSH_TIMEOUT_MS,
      );
      assert.ok(
        countAfterFirstFlush >= BATCH_SIZE,
        `expected first batch of ${BATCH_SIZE} rows to flush within ${FIRST_FLUSH_TIMEOUT_MS} ms; got only ${countAfterFirstFlush}`,
      );

      // Stage 2: queue STAGE_TWO_ROW_COUNT (<BATCH_SIZE) more rows so
      // the adapter parses them but never accumulates enough to trigger
      // a second `flushBatch`.
      for (
        let i = STAGE_ONE_ROW_COUNT;
        i < STAGE_ONE_ROW_COUNT + STAGE_TWO_ROW_COUNT;
        i++
      ) {
        input.write(buildRow(PREFIX, i));
      }

      // Fire the abort. This destroys the parser, the for-await loop
      // throws `CsvIngestAbortedError`, and the adapter's catch block
      // re-throws a fresh error carrying the live `rowsParsed` /
      // `rowsInserted` counters.
      controller.abort();

      let caught: unknown;
      try {
        await ingestPromise;
      } catch (err) {
        caught = err;
      }
      assert.ok(
        caught instanceof CsvIngestAbortedError,
        `expected CsvIngestAbortedError, got ${
          caught instanceof Error
            ? `${caught.constructor.name}: ${caught.message}`
            : String(caught)
        }`,
      );
      const aborted = caught;
      assert.ok(
        aborted.rowsParsed > 0,
        `expected aborted.rowsParsed > 0, got ${aborted.rowsParsed}`,
      );
      assert.ok(
        aborted.rowsInserted > 0,
        `expected aborted.rowsInserted > 0, got ${aborted.rowsInserted}`,
      );
      // The route reads `rowsInserted` straight off the error to build
      // its NDJSON `cancelled` payload — if the adapter ever started
      // reporting the *attempted* total instead of the *flushed* total,
      // the UI would over-count "saved" rows for cancelled uploads.
      assert.ok(
        aborted.rowsInserted <= aborted.rowsParsed,
        `expected rowsInserted (${aborted.rowsInserted}) <= rowsParsed (${aborted.rowsParsed})`,
      );

      // Drain & end the PassThrough so we don't leak the descriptor.
      input.end();

      // No further DB inserts may land after the abort. Snapshot, dwell,
      // snapshot again — any growth means a flushBatch leaked past the
      // signal check.
      const snapshot1 = await countRowsWithPrefix(PREFIX);
      await sleep(POST_ABORT_DWELL_MS);
      const snapshot2 = await countRowsWithPrefix(PREFIX);
      assert.equal(
        snapshot2,
        snapshot1,
        `expected DB row count to be stable after abort, but went from ${snapshot1} -> ${snapshot2} (a batch leaked past the signal check)`,
      );
      // Sanity: the adapter's reported `rowsInserted` must match the
      // actual DB count under our prefix. A drift here would mean either
      // a phantom insert or a phantom counter increment.
      assert.equal(
        aborted.rowsInserted,
        snapshot2,
        `expected error.rowsInserted (${aborted.rowsInserted}) to match the actual DB row count (${snapshot2}) under prefix ${PREFIX}`,
      );
      // And the total written to the DB must be strictly less than the
      // total number of rows we pushed through the parser — proving the
      // abort genuinely short-circuited stage 2.
      assert.ok(
        snapshot2 < TOTAL_ROWS_PUSHED,
        `expected fewer than ${TOTAL_ROWS_PUSHED} rows inserted after abort, got ${snapshot2}`,
      );

      console.log(
        `[direct] aborted with rowsParsed=${aborted.rowsParsed}, rowsInserted=${aborted.rowsInserted}; DB count stable at ${snapshot2}`,
      );
    },
  );

  // -----------------------------------------------------------------
  // Sub-test 2: full HTTP path. Boots the real Express app, POSTs a
  // chunked text/csv body, aborts mid-flight, and verifies the route's
  // catch block emits the `cancelled` NDJSON event and that no further
  // DB inserts land.
  // -----------------------------------------------------------------
  await t.test(
    "POST /api/ingest/csv-stream emits a 'cancelled' NDJSON event and stops further DB inserts when the client aborts mid-flight",
    async (sub) => {
      const PREFIX = `${EXTERNAL_ID_PREFIX}http-`;
      await deleteRowsWithPrefix(PREFIX);

      // Capture every chunk written to the response, INCLUDING writes
      // that fail to flush because the client has already torn the
      // socket down. The route's `cancelled` event is emitted from its
      // catch block *after* `req.on("aborted")` has fired — by which
      // time the response socket is dead, so an end-to-end NDJSON
      // reader on the client side never observes the event. Spying at
      // the `http.Server` layer is the cheapest way to assert the
      // route still ran the emission code path: a regression that
      // dropped the `writeEvent({ type: "cancelled", ... })` line, or
      // forgot to plumb the abort signal at all, would leave this
      // capture array without the expected event even though the
      // client side looked identical.
      const capturedWrites: string[] = [];
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/api/ingest/csv-stream")) {
          const origWrite = res.write.bind(res);
          // The signature of res.write has many overloads; we only
          // need to observe the first chunk argument. Returning the
          // delegated call preserves backpressure semantics.
          res.write = ((chunk: unknown, ...rest: unknown[]) => {
            if (typeof chunk === "string") {
              capturedWrites.push(chunk);
            } else if (Buffer.isBuffer(chunk)) {
              capturedWrites.push(chunk.toString("utf8"));
            }
            return (
              origWrite as unknown as (
                chunk: unknown,
                ...rest: unknown[]
              ) => boolean
            )(chunk, ...rest);
          }) as typeof res.write;
        }
        app(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        await new Promise<void>((res) => server.close(() => res()));
        throw new Error("Failed to bind ephemeral test server");
      }
      const port = addr.port;

      sub.after(async () => {
        await new Promise<void>((res) => server.close(() => res()));
      });

      // Issue a chunked text/csv POST so we can keep writing while the
      // server is still parsing — this is the same code path the raw
      // curl `--data-binary` flow exercises (the multipart path goes
      // through busboy first but ultimately hands the same kind of
      // stream to `streamCsvEntity`).
      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/ingest/csv-stream?entity=suppliers",
        headers: {
          "x-org-id": orgId,
          "content-type": "text/csv",
          "transfer-encoding": "chunked",
        },
      });

      // Drain the response stream into a buffer for diagnostics. We do
      // not assert on its contents because the realistic abort tears
      // the socket down before the `cancelled` event can land —
      // capturing on the server side via the res.write spy is the
      // assertion vehicle. ECONNRESET / premature close on the client
      // side is the *expected* signal that the abort propagated.
      const responseChunks: Buffer[] = [];
      const responseDone = new Promise<void>((resolve) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        clientReq.on("response", (resp) => {
          resp.on("data", (chunk: Buffer) => responseChunks.push(chunk));
          resp.on("end", settle);
          resp.on("close", settle);
          resp.on("error", settle);
        });
        clientReq.on("error", settle);
        clientReq.on("close", settle);
      });

      // Stage 1: header + a full batch (plus the trailing row so the
      // parser actually commits row #BATCH_SIZE — see
      // STAGE_ONE_ROW_COUNT).
      clientReq.write(HEADER);
      for (let i = 0; i < STAGE_ONE_ROW_COUNT; i++) {
        clientReq.write(buildRow(PREFIX, i));
      }

      // Wait for the first batch to actually flush before aborting —
      // anchors the test on the real flush lifecycle (same rationale as
      // sub-test 1).
      const countAfterFirstFlush = await waitForRowCount(
        PREFIX,
        BATCH_SIZE,
        FIRST_FLUSH_TIMEOUT_MS,
      );
      assert.ok(
        countAfterFirstFlush >= BATCH_SIZE,
        `expected first batch of ${BATCH_SIZE} rows to flush within ${FIRST_FLUSH_TIMEOUT_MS} ms; got only ${countAfterFirstFlush}`,
      );

      // Stage 2: queue more rows that should never land. They may or
      // may not reach the server before req.destroy() depending on TCP
      // buffering — the test does not depend on whether they arrive,
      // only that nothing past the first batch ends up persisted.
      for (
        let i = STAGE_ONE_ROW_COUNT;
        i < STAGE_ONE_ROW_COUNT + STAGE_TWO_ROW_COUNT;
        i++
      ) {
        clientReq.write(buildRow(PREFIX, i));
      }

      // Mimic xhr.abort() / fetch AbortController by destroying the
      // client request, which closes the TCP connection. The server
      // observes `req.on("aborted")` and propagates `controller.abort()`
      // into `streamCsvEntity`.
      clientReq.destroy();
      await responseDone;

      // Give the server a beat to run its catch block + writeEvent.
      // The abort path is async (parser destroy → for-await throw →
      // adapter catch → route catch → writeEvent) so we cannot assume
      // the spy has captured the cancelled event the very tick the
      // client request closes.
      await sleep(500);

      const writes = capturedWrites.join("");
      const lines = writes.split("\n").filter((l) => l.trim().length > 0);
      const parsedLines = lines.map((l) => {
        try {
          return JSON.parse(l) as { type?: string; [k: string]: unknown };
        } catch {
          return { type: "[unparseable]", raw: l } as {
            type: string;
            raw: string;
          };
        }
      });
      const cancelledEvent = parsedLines.find((p) => p.type === "cancelled") as
        | {
            type: "cancelled";
            entity?: string;
            rowsParsed?: number;
            rowsInserted?: number;
          }
        | undefined;

      assert.ok(
        cancelledEvent,
        `expected the route to emit a { type: "cancelled" } NDJSON event after the client aborted. ` +
          `Captured ${parsedLines.length} write(s): [${parsedLines
            .map((p) => p.type ?? "?")
            .join(", ")}]. ` +
          `A regression in the route's catch block (e.g. dropping the writeEvent call, ` +
          `or no longer treating CsvIngestAbortedError specially) would surface here.`,
      );
      assert.equal(
        cancelledEvent.entity,
        "suppliers",
        `expected cancelled.entity to echo back the requested entity`,
      );
      assert.equal(
        typeof cancelledEvent.rowsParsed,
        "number",
        `expected cancelled.rowsParsed to be a number, got ${typeof cancelledEvent.rowsParsed}`,
      );
      assert.equal(
        typeof cancelledEvent.rowsInserted,
        "number",
        `expected cancelled.rowsInserted to be a number, got ${typeof cancelledEvent.rowsInserted}`,
      );
      assert.ok(
        (cancelledEvent.rowsParsed ?? 0) > 0,
        `expected cancelled.rowsParsed > 0, got ${cancelledEvent.rowsParsed}`,
      );
      assert.ok(
        (cancelledEvent.rowsInserted ?? 0) > 0,
        `expected cancelled.rowsInserted > 0, got ${cancelledEvent.rowsInserted}`,
      );
      // The cancelled event must NOT be followed by a result event —
      // otherwise the client-side NDJSON reader would treat the upload
      // as having succeeded.
      const resultIdxAfterCancel = parsedLines
        .slice(parsedLines.indexOf(cancelledEvent))
        .findIndex((p) => p.type === "result");
      assert.equal(
        resultIdxAfterCancel,
        -1,
        `the route must not emit a 'result' event after a 'cancelled' event`,
      );

      // No further DB inserts may land after the abort.
      const snapshot1 = await countRowsWithPrefix(PREFIX);
      await sleep(POST_ABORT_DWELL_MS);
      const snapshot2 = await countRowsWithPrefix(PREFIX);
      assert.equal(
        snapshot2,
        snapshot1,
        `expected DB row count to be stable after abort, but went from ${snapshot1} -> ${snapshot2} (a batch leaked past the signal check)`,
      );
      assert.ok(
        snapshot2 < TOTAL_ROWS_PUSHED,
        `expected fewer than ${TOTAL_ROWS_PUSHED} rows inserted after abort, got ${snapshot2}`,
      );
      // The cancelled event's reported rowsInserted must match the
      // actual DB state — otherwise the UI's "Saved N rows" badge on a
      // cancelled upload would lie to the operator.
      assert.equal(
        cancelledEvent.rowsInserted,
        snapshot2,
        `expected cancelled.rowsInserted (${cancelledEvent.rowsInserted}) to match the actual DB row count (${snapshot2}) under prefix ${PREFIX}`,
      );

      console.log(
        `[http] cancelled event captured with rowsParsed=${cancelledEvent.rowsParsed}, ` +
          `rowsInserted=${cancelledEvent.rowsInserted}; DB count stable at ${snapshot2}; ` +
          `client-side response chunks total ${responseChunks.reduce(
            (n, c) => n + c.length,
            0,
          )} bytes`,
      );
    },
  );
});
